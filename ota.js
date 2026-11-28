/* Ink Studio — direct Web Bluetooth OTA for the TLSR8359 tag.
 *
 * Commands on A001, answers on A002:
 *   0x20 <len u32> <crc u32> <seq u32>   A0 <rc> <erase_ms u16> <got u32>
 *   0x21 <bytes>                          A1 <got u32> every 4 KiB
 *   0x22 <sha32> <sig64> [key id]         A2 <rc> <copy_ms u16>
 *   0x23                                  A3 + 26 bytes
 *   0x24                                  A4 <rc>
 *   0x2F                                  A6 <mask> <ms u16> <sha256("abc")[0..7]>
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const core = window.OTA_CORE;
  const ble = window.INK_BLE;
  const ERRORS = {
    0x20: '状态错误（没有未完成的传输，或当前状态不允许）',
    0x21: '参数不合理',
    0x22: '镜像长度不在当前槽容量内',
    0x23: '降级被拒：这个包的 seq 不比价签在跑的版本新',
    0x24: '收到的字节少于声明长度',
    0x25: 'Flash 内容与收到的数据不符',
    0x26: 'SHA-256 不一致',
    0x27: 'ECDSA 签名验证失败',
    0x28: '槽切换或回滚副本准备失败',
    0x29: '没有可用的回滚副本',
    0x2A: '镜像不是这个槽布局（+0x1C 不是 OAB4）',
  };

  let link = null;
  let pkg = null;
  let uploading = false;
  let verifying = false;
  let ota = null;
  /* 这台标签的槽容量。只有连上过才知道（blob 契约标签要问 /api/ble/blob/caps），所以：
   *   cap === null    还没连接过，不拦包（否则 180 KiB 的包会在连接前被误拒）
   *   blobKnown===false  旧协议标签，131072 B
   *   blobKnown===true   契约标签，cap = CAPS.total_max */
  const LEGACY_MAX = 0x20000;
  let cap = null;
  let capKey = '';
  let capBusy = false;
  let blobKnown = null;

  // 验签在哪里做由宿主决定：浏览器直连时用 WebCrypto（core.verifyPackage），prism-ble 的
  // http 页面没有 crypto.subtle，就换成窗口注入的 OTA_VERIFIER（转发给本板用 mbedtls 验）。
  // 返回值形状一致：{ crc, sha, crcOk, shaOk, sigOk, ok }。
  const verifier = () => (typeof window !== 'undefined' && window.OTA_VERIFIER) || null;
  const verifyPackage = (p) => (verifier() ? verifier()(p) : core.verifyPackage(p));

  const u32le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const le32 = (bytes, off) =>
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  const hex32 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function log(message) {
    const node = $('otaLog');
    if (node.textContent === '就绪。') node.textContent = '';
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    node.textContent += (node.textContent ? '\n' : '') + '[' + stamp + '] ' + message;
    node.scrollTop = node.scrollHeight;
  }

  function status(message, kind = '') {
    const node = $('otaStatus');
    node.hidden = !message;
    node.textContent = message;
    node.className = 'ble-status' + (kind ? ' ' + kind : '');
  }

  function errorText(rc) {
    return ERRORS[rc] || ('状态 0x' + Number(rc).toString(16));
  }

  function connected() {
    return !!link?.connected;
  }

  function capacityNow() {
    return link && link.capacity != null ? link.capacity : cap;
  }

  // 契约标签（网关版）走 blob；直连站没有 INK_OTA_BLOB，恒走旧 0x20 路径。
  function blobPath() {
    return !!(window.INK_OTA_BLOB && blobKnown === true);
  }

  function legacyOverflow() {
    return !!pkg && blobKnown === false && pkg.len > LEGACY_MAX;
  }

  function slotOverflow() {
    const limit = capacityNow();
    return !!pkg && limit != null && pkg.len > limit;
  }

  /* 槽容量是异步问标签的：连接后的第一次 state 里只有 blob.present，caps 还没查。
   * 这里补一次，成功后重画包信息和按钮状态；失败保持 null（下次再试），不当成 128 KiB。 */
  async function refreshCapacity() {
    if (cap != null || capBusy) return;
    if (!link?.connected || link.blobPresent !== true) return;
    if (typeof ble.capacity !== 'function') return;
    const key = link.tagKey || '';
    capBusy = true;
    try {
      const value = await ble.capacity();
      // 查询期间用户可能换了价签：只把答案记给发起查询的那一枚。
      if (value != null && (link?.tagKey || '') === key) cap = value;
    } finally {
      capBusy = false;
      renderPkg();
      sync();
    }
  }

  function acceptable() {
    if (!pkg || !ota) return null;
    return pkg.seq >= ota.seqActive;
  }

  function sync() {
    const isConnected = connected();
    const hasDevice = !!link?.hasDevice;
    const blocked = !!link?.busy || uploading;
    $('otaRead').disabled = !hasDevice || blocked;
    $('otaSelftest').disabled = !hasDevice || blocked;
    $('otaAbort').disabled = !hasDevice || blocked;
    $('otaVerify').disabled = !pkg || uploading || verifying;
    $('otaUpload').disabled = !hasDevice || !pkg?.verified || blocked || acceptable() === false ||
      legacyOverflow() || slotOverflow();
    const label = link?.name || '';
    $('otaLinkBadge').textContent = !hasDevice ? '未连接' : label + (isConnected ? ' · 传输中' : ' · 未连接');
    $('otaLinkBadge').classList.toggle('ble-connected', isConnected);
    $('otaProgress').hidden = !uploading && !$('otaProgress').value;
    // 能不能连价签由传输层回答（直连版看 HTTPS + Web Bluetooth，网关版恒可用），
    // 这里只负责把原因显示出来。
    const blockedBy = ble.unavailableReason ? ble.unavailableReason() : null;
    const hint = blockedBy
      ? blockedBy
      : !hasDevice
        ? '先在右上角选价签；读状态和下发时临时连接、结束断开。'
        : !pkg
          ? '选择 .eslfw 固件包，页面先在本地验签。'
          : pkg.verified
            ? (legacyOverflow()
              ? '这个包 ' + pkg.len.toLocaleString() + ' B，旧协议（0x20 帧）最多 128 KiB；换 180 KiB 契约标签走 blob 通道。'
              : slotOverflow()
                ? '镜像 ' + pkg.len.toLocaleString() + ' B 超过这台标签的槽容量 ' +
                  capacityNow().toLocaleString() + ' B。'
                : acceptable() === false
                  ? '这个包的 seq 比价签在跑的旧，价签会拒绝。'
                  : '签名校验通过，可以下发。')
            : '固件包还没通过校验，不能下发。';
    $('otaSupport').hidden = !hint;
    $('otaSupport').textContent = hint;
  }

  function renderStatus() {
    if (!ota) {
      $('otaState').innerHTML = '<div><span>读取后显示</span><b>—</b></div>';
      return;
    }
    const pending = ota.pending === 255 ? '无' : '槽 ' + ota.pending + '（' + ota.tries + ' 次尝试）';
    $('otaState').innerHTML =
      '<div><span>在跑槽</span><b>seq ' + ota.seqActive + ' · 槽 ' + ota.slot + '</b></div>' +
      '<div><span>待确认</span><b>' + pending + '</b></div>' +
      '<div><span>回滚副本</span><b>' + (ota.rbValid ? '槽 ' + ota.rbSlot : '无') + '</b></div>' +
      '<div><span>未完成传输</span><b>' + (ota.open ? ota.got + ' / ' + ota.len + ' B' : '无') + '</b></div>' +
      '<div><span>最后一次 0x20</span><b>' +
        (ota.len ? 'len ' + ota.len + ' · seq ' + ota.seq + ' · CRC ' + hex32(ota.crc) : '—') + '</b></div>';
  }

  function capacityLine() {
    const limit = capacityNow();
    if (limit == null) return '槽容量待连接后读取';
    return '槽 ' + limit.toLocaleString() + ' B · ' + (blobKnown === false ? '仅旧协议' : '契约 v1');
  }

  function renderPkg() {
    if (!pkg) {
      $('otaPkg').innerHTML = '<div><span>固件包</span><b>尚未选择</b></div>';
      return;
    }
    const v = pkg.verification;
    const checks = v
      ? (v.crcOk ? '✓' : '✗') + ' CRC32 · ' + (v.shaOk ? '✓' : '✗') + ' SHA-256 · ' +
        (v.sigOk ? '✓' : '✗') + ' ECDSA'
      : '待校验';
    const accept = acceptable();
    $('otaPkg').innerHTML =
      '<div><span>文件</span><b>' + esc(pkg.fileName || '') + ' · ' + pkg.total + ' B</b></div>' +
      '<div><span>镜像</span><b>' + pkg.len + ' B · CRC32 ' + hex32(pkg.crc) + '</b></div>' +
      '<div><span>序号</span><b>seq ' + pkg.seq + ' · key id ' + pkg.keyId + '</b></div>' +
      '<div><span>这台标签</span><b class="' + (slotOverflow() ? 'bad' : '') + '">' +
        capacityLine() + '</b></div>' +
      '<div><span>SHA-256</span><b class="mono">' + core.hex(pkg.sha) + '</b></div>' +
      '<div><span>校验</span><b class="' + (v ? (v.ok ? 'good' : 'bad') : '') + '">' + checks + '</b></div>' +
      (accept === null ? '' :
        '<div><span>价签在跑</span><b class="' + (accept ? 'good' : 'bad') + '">seq ' + ota.seqActive +
          (accept ? ' · 可以升级' : ' · 比包新，会拒绝') + '</b></div>');
  }

  async function readStatus() {
    if (!connected()) throw new Error('BLE 未连接');
    const p = await ble.command([0x23], (packet) => packet[0] === 0xa3 && packet.length >= 27, 6000, '读取 OTA 状态');
    ota = {
      open: p[1], slot: p[2], pending: p[3], tries: p[4],
      got: le32(p, 5), len: le32(p, 9), crc: le32(p, 13),
      seq: le32(p, 17), seqActive: le32(p, 21), rbValid: p[25], rbSlot: p[26],
    };
    renderStatus();
    renderPkg();
    sync();
    log('OTA 状态：在跑 seq ' + ota.seqActive + ' / 槽 ' + ota.slot +
      (ota.open ? '，未完成 ' + ota.got + '/' + ota.len + ' B' : '，没有未完成传输'));
    return ota;
  }

  async function selfTest() {
    const p = await ble.command([0x2f], (packet) => packet[0] === 0xa6 && packet.length >= 12, 12000, '验签自检');
    const mask = p[1];
    const ms = (p[2] << 8) | p[3];
    const hash8 = core.hex(p.subarray(4, 12));
    const healthy = (mask & 0x0f) === 0x0f;
    log('验签自检 mask 0x' + mask.toString(16) + ' · ' + ms + ' ms · sha256("abc")[0..7]=' + hash8 +
      (healthy ? ' ✓' : ' ✗'));
    if (!healthy) throw new Error('价签验签自检未通过，先不要升级');
    status('验签自检通过。', 'good');
  }

  async function abortTransfer() {
    const p = await ble.command([0x24], (packet) => packet[0] === 0xa4 && packet.length >= 2, 6000, '放弃 OTA 传输');
    if (p[1]) throw new Error('放弃失败：' + errorText(p[1]));
    log('已放弃未完成的 OTA 传输。');
    await readStatus();
  }

  async function loadFile(file) {
    if (!file) return;
    pkg = null;
    renderPkg();
    sync();
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // 先按 180 KiB 宽上限解析（还不知道标签槽容量），再用已知容量复核。
      pkg = core.parsePackage(buf, { max: core.MAX_IMAGE });
      pkg.fileName = file.name;
      pkg.verification = null;
      pkg.verified = false;
      const limit = capacityNow();
      if (limit != null && pkg.len > limit) {
        throw new Error('镜像 ' + pkg.len + ' B 超过这台标签的槽容量 ' + limit + ' B');
      }
      renderPkg();
      log('已读取 ' + file.name + '：镜像 ' + pkg.len + ' B，seq ' + pkg.seq + '，key id ' + pkg.keyId);
      await verifyPkg();
    } catch (error) {
      pkg = null;
      status('读取固件包失败：' + error.message, 'bad');
      log('读取失败：' + error.message);
      renderPkg();
      sync();
    }
  }

  async function verifyPkg() {
    if (!pkg || verifying) return;
    verifying = true;
    status('正在校验 CRC32、SHA-256 和 ECDSA 签名…');
    renderPkg();
    sync();
    try {
      const result = await verifyPackage(pkg);
      pkg.verification = result;
      pkg.verified = result.ok;
      renderPkg();
      if (!result.ok) {
        const failed = [!result.crcOk && 'CRC32', !result.shaOk && 'SHA-256', !result.sigOk && 'ECDSA']
          .filter(Boolean).join('、');
        throw new Error('校验失败：' + failed);
      }
      log('验签通过：CRC32 ' + hex32(result.crc) + ' · SHA-256 ' + core.hex(result.sha).slice(0, 16) + '…');
      status('固件包校验通过。', 'good');
      renderPkg();
    } catch (error) {
      status(error.message, 'bad');
      log('校验失败：' + error.message);
    } finally {
      verifying = false;
      sync();
    }
  }

  function stageText(name) {
    if (name === '检查') return '检查：读取标签槽容量并打开 blob 会话…';
    if (name === '传输') return '传输：准备发送镜像…';
    if (name === '校验/安装') return '校验/安装：价签正在回读 Flash、验签并切槽…';
    if (name === '等待重启') return '等待重启：价签安装约 5–15 秒后重新广播…';
    return name;
  }

  async function upload() {
    if (!pkg?.verified) throw new Error('固件包还没通过校验');
    if (!connected()) throw new Error('BLE 未连接');
    if (acceptable() === false) throw new Error('这个包的 seq 比价签在跑的旧，价签会拒绝');
    const limit = capacityNow();
    if (limit != null && pkg.len > limit) {
      throw new Error('镜像 ' + pkg.len + ' B 超过这台标签的槽容量 ' + limit + ' B');
    }
    if (legacyOverflow()) {
      throw new Error('这台标签只有旧协议（0x20 帧），最多 ' + LEGACY_MAX + ' B；这个包 ' + pkg.len + ' B');
    }
    // 不要再检查 link?.busy：upload 是通过 withTag → ble.session 进来的，会话自己已经把
    // busy 置真，这里再看一定是「忙」，下发永远走不出去。真正的并发保护在 guard() 里。
    uploading = true;
    ble.setBusy(true);
    $('otaProgress').hidden = false;
    $('otaProgress').max = pkg.len;
    $('otaProgress').value = 0;
    sync();
    try {
      if (blobPath()) return await uploadBlob();
      return await uploadLegacy();
    } finally {
      uploading = false;
      ble.setBusy(false);
      sync();
    }
  }

  // 180 KiB 契约标签：网关中转 blob v1，页面只发 HTTP。步骤和判据都在 c3/ota-blob.js。
  async function uploadBlob() {
    const conn = link?.conn || '';
    if (!conn) throw new Error('网关没有返回连接令牌，先把本板固件升级到带 /api/ble/blob/* 的版本');
    log('开始 blob OTA：' + pkg.len + ' B，seq ' + pkg.seq + '，网关连接 ' + conn);
    const result = await window.INK_OTA_BLOB.run(conn, pkg, {
      onStage: (name) => status(stageText(name)),
      onProgress: (sent, total) => {
        $('otaProgress').value = sent;
        if (total) {
          status('传输：' + sent.toLocaleString() + ' / ' + total.toLocaleString() + ' B（' +
            (100 * sent / total).toFixed(1) + '%）');
        }
      },
      onLog: (line) => log(line),
    });
    if (result.ok) {
      $('otaProgress').value = pkg.len;
      status('已确认：价签在跑 seq ' + result.seqActive + ' · phase 0（镜像 ' +
        pkg.len.toLocaleString() + ' B）。', 'good');
      log('升级完成：seq_active ' + result.seqActive + '，phase 0。');
    } else {
      status((result.verdict === 'rollback' ? '已回滚：' : '待确认：') + result.detail, 'warn');
      log((result.verdict === 'rollback' ? '已回滚：' : '待确认：') + result.detail);
    }
    return result;
  }

  async function uploadLegacy() {
    let off = 0;
    let notifyError = null;
    const stopNotify = ble.onNotify((packet) => {
      if (packet[0] === 0x8f) notifyError = new Error('价签在数据阶段报错：' + errorText(packet[1]));
      else if (packet[0] === 0xa1) {
        // Progress notifications are advisory; Flash writes can lag the ATT ack.
      }
    });

    try {
      const mtu = await ble.queryMtu();
      if (mtu < 101) throw new Error('当前 ATT MTU 为 ' + mtu + '，0x22 的 98 B 帧需要至少 101，请换设备或靠近价签');
      log('ATT MTU ' + mtu + '，开始 OTA：' + pkg.len + ' B，seq ' + pkg.seq);

      const begin = [0x20, ...u32le(pkg.len), ...u32le(pkg.crc), ...u32le(pkg.seq)];
      const a0 = await ble.command(begin, (p) => p[0] === 0xa0 && p.length >= 8, 40000, 'OTA 开始');
      if (a0[1]) throw new Error('价签拒绝开始：' + errorText(a0[1]));
      const eraseMs = (a0[2] << 8) | a0[3];
      off = le32(a0, 4);
      if (off > pkg.len) throw new Error('价签报告的续传位置超过镜像长度');
      $('otaProgress').value = off;
      log('0x20 已接受：擦除 ' + eraseMs + ' ms' + (off ? '，从 ' + off + ' B 续传' : '，从 0 开始'));

      const chunkSize = Math.min(243, mtu - 4);
      const startedAt = performance.now();
      let nextYield = 0;
      while (off < pkg.len) {
        if (notifyError) throw notifyError;
        const count = Math.min(chunkSize, pkg.len - off);
        const packet = new Uint8Array(count + 1);
        packet[0] = 0x21;
        packet.set(pkg.image.subarray(off, off + count), 1);
        await ble.writeWithResponse(packet);
        off += count;
        $('otaProgress').value = off;
        if (off >= nextYield) {
          const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
          status('正在写入 ' + off.toLocaleString() + ' / ' + pkg.len.toLocaleString() + ' B（' +
            (100 * off / pkg.len).toFixed(1) + '%）· ' + (off / 1024 / elapsed).toFixed(1) + ' KB/s');
          nextYield = off + Math.max(2048, chunkSize * 8);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (notifyError) throw notifyError;
      log('数据写完，价签正在回读 Flash、算 SHA-256 并验签（约 10–15 秒）…');
      status('校验/安装：数据已发完，等待价签回读和验签…', 'warn');

      const finish = new Uint8Array(1 + 32 + 64 + 1);
      finish[0] = 0x22;
      finish.set(pkg.sha, 1);
      finish.set(pkg.sig, 33);
      finish[97] = pkg.keyId;
      const a2 = await ble.command(finish, (p) => p[0] === 0xa2 && p.length >= 4, 120000, 'OTA 验签');
      if (a2[1]) throw new Error('价签验签失败：' + errorText(a2[1]));
      $('otaProgress').value = pkg.len;
      log('0xA2 rc=0：价签已接受固件，正在切换槽并重启。');
      status('已通过价签验签，价签将在约 1 秒后重启。', 'good');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      status('等待重启：约 10 秒后重新连接，再读取 OTA 状态确认 seq_active。', 'warn');
      log('升级完成。重新连接后确认“在跑槽”的 seq 已变成 ' + pkg.seq + '。');
    } finally {
      stopNotify();
    }
  }

  function guard(action) {
    return async () => {
      if (uploading || verifying || link?.busy) return;
      try {
        status('');
        await action();
      } catch (error) {
        const message = String((error && error.message) || error || '未知错误');
        status(message, 'bad');
        log('错误：' + message);
      } finally {
        renderPkg();
        sync();
      }
    };
  }

  const withTag = (action) => guard(() => ble.session(action, (message) => {
    status(message, 'bad');
    log('错误：' + message);
  }));
  $('otaRead').addEventListener('click', withTag(readStatus));
  $('otaSelftest').addEventListener('click', withTag(selfTest));
  $('otaAbort').addEventListener('click', withTag(abortTransfer));
  $('otaVerify').addEventListener('click', guard(verifyPkg));
  $('otaUpload').addEventListener('click', withTag(upload));
  $('otaFile').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
  });

  let lastTagKey = '';
  ble.subscribe((state) => {
    link = state;
    // 槽容量属于某一枚标签：换了标签就清掉，不能把上一台的 180 KiB 当成这一台的。
    if ((state.tagKey || '') !== capKey) {
      capKey = state.tagKey || '';
      cap = null;
      blobKnown = null;
    }
    if (state.blobPresent === false) {
      blobKnown = false;
      cap = LEGACY_MAX;
    } else if (state.blobPresent === true) {
      blobKnown = true;
      if (state.capacity != null) cap = state.capacity;
    }
    // Sessions disconnect after every operation. Invalidate cached tag status only when the
    // selected tag actually changed, not on the normal post-transfer disconnect.
    if (state.tagKey && state.tagKey !== lastTagKey && ota) {
      lastTagKey = state.tagKey;
      ota = null;
      renderStatus();
    } else if (state.tagKey) {
      lastTagKey = state.tagKey;
    }
    renderPkg();
    sync();
    void refreshCapacity();
  });
  window.addEventListener('ink:tab', (event) => {
    if (event.detail?.tab === 'ota') {
      void refreshCapacity();
      renderPkg();
      sync();
    }
  });

  renderStatus();
  renderPkg();
  sync();
  log('就绪。先在右上角选价签，再选择 .eslfw 固件包。');
})();
