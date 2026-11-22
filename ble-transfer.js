/* Ink Studio — Web Bluetooth image transfer. */
(function () {
  'use strict';

  const lab = window.__BWR_LAB__;
  const $ = (id) => document.getElementById(id);
  const SERVICE = '0000a000-0000-1000-8000-00805f9b34fb';
  const CMD = '0000a001-0000-1000-8000-00805f9b34fb';
  const RSP = '0000a002-0000-1000-8000-00805f9b34fb';
  const WIRE_MODES = [null, 'bw', 'bwr', 'bwy', 'gray4', 'seven'];
  const waiters = new Set();
  const linkListeners = new Set();
  const notifyListeners = new Set();
  class NotificationTimeout extends Error {}
  let device = null;
  let commandChar = null;
  let responseChar = null;
  let connected = false;
  let busy = false;
  let externalBusy = false;
  let transferPlane = 0;
  let panel = null;
  let token = 0;
  let refreshInProgress = false;
  let refreshAccepted = false;
  let refreshDisconnected = false;
  let refreshCompletionWaiter = null;

  function setStatus(message, kind) {
    const node = $('bleStatus');
    node.hidden = false;
    node.textContent = message;
    node.classList.toggle('bad', kind === 'bad');
    node.classList.toggle('good', kind === 'good');
    node.classList.toggle('warn', kind === 'warn');
  }

  function setProgress(value) {
    const progress = $('bleProgress');
    progress.hidden = false;
    progress.value = value;
  }

  function canUseBluetooth() {
    return !!(window.isSecureContext && navigator.bluetooth);
  }

  function panelMatches(spec, { w, h, colorMode }) {
    return spec && spec.w === w && spec.h === h && spec.mode === colorMode;
  }

  function panelDescription(spec) {
    return spec.w + ' × ' + spec.h + ' ' + window.INK_PANELS.modes[spec.mode].label;
  }

  function readPanel(packet) {
    if (packet.length !== 13) throw new Error('设备返回的传图状态帧长度有误，应为 13 字节');
    if (packet[7] !== 1) throw new Error('设备报告了不支持的传图协议版本');
    const w = packet[8] | (packet[9] << 8);
    const h = packet[10] | (packet[11] << 8);
    const mode = WIRE_MODES[packet[12]];
    if (w < 8 || w > 1024 || h < 8 || h > 1024 || !mode) {
      throw new Error('设备报告了不支持的画布规格');
    }
    return { w, h, mode };
  }

  function updateControls() {
    const canConnect = canUseBluetooth();
    const blocked = busy || externalBusy;
    $('bleConnect').hidden = connected;
    $('bleConnect').disabled = blocked || connected || !canConnect;
    $('bleDisconnect').hidden = !connected;
    $('bleDisconnect').disabled = blocked || !connected;
    $('bleSend').disabled = blocked || !connected || !!transferPlane ||
      !panelMatches(panel, lab.state) || lab.state.codes?.length !== lab.state.w * lab.state.h;
    $('bleAbort').hidden = !connected || !transferPlane;
    $('bleAbort').disabled = blocked || !connected || !transferPlane;

    let hint = '传图无需蓝牙配对或输入密钥。';
    if (!window.isSecureContext) {
      hint = '蓝牙直连需要通过 HTTPS 或 localhost 打开。';
    } else if (!canConnect) {
      hint = '蓝牙直连可用桌面 Chrome / Edge 或 Android Chrome。';
    } else if (connected && panel) {
      hint = panelMatches(panel, lab.state)
        ? '设备规格：' + panelDescription(panel)
        : '请将画布切换为设备规格：' + panelDescription(panel);
    }
    $('bleSupport').textContent = hint;
    $('bleSupport').hidden = !hint;
    const state = { canConnect, connected, busy: blocked, transferPlane, panel, name: device?.name };
    for (const listener of Array.from(linkListeners)) {
      try { listener(state); } catch (error) { console.error(error); }
    }
  }

  function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function putU32le(bytes, offset, value) {
    bytes[offset] = value & 255;
    bytes[offset + 1] = (value >>> 8) & 255;
    bytes[offset + 2] = (value >>> 16) & 255;
    bytes[offset + 3] = (value >>> 24) & 255;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function packetBytes(value) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy;
  }

  function makeWaiter(predicate, timeoutMs, label) {
    let resolvePromise, rejectPromise;
    const waiter = {
      predicate: predicate,
      timer: 0,
      promise: new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }),
      finish: (value, error) => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      },
      cancel: (error) => {
        if (waiters.has(waiter)) waiter.finish(null, error || new Error('操作已取消'));
      },
    };
    // 写入完成前也可能收到断连或超时，先注册拒绝处理，再由调用方读取结果。
    void waiter.promise.catch(() => {});
    waiter.timer = setTimeout(() => waiter.finish(null, new NotificationTimeout('等待' + label + '超时')), timeoutMs);
    waiters.add(waiter);
    return waiter;
  }

  function receive(event) {
    const packet = packetBytes(event.target.value);
    if (!packet.length) return;
    for (const waiter of Array.from(waiters)) {
      try {
        if (waiter.predicate(packet)) waiter.finish(packet, null);
      } catch (error) {
        waiter.finish(null, error);
      }
    }
    for (const listener of Array.from(notifyListeners)) {
      try { listener(packet); } catch (error) { console.error(error); }
    }
  }

  function failWaiters(error) {
    for (const waiter of Array.from(waiters)) waiter.finish(null, error);
  }

  async function writeWithResponse(bytes) {
    if (!connected || !commandChar) throw new Error('BLE 已断开');
    if (!commandChar.writeValueWithResponse) throw new Error('请使用支持 BLE 写入确认的新版 Chrome 或 Edge');
    return commandChar.writeValueWithResponse(bytes);
  }

  async function requestCardRefresh() {
    if (!connected || !commandChar?.writeValueWithoutResponse) throw new Error('刷新请求需要可用的 BLE 连接');
    const waiter = makeWaiter((p) => p[0] === 0xc5 || p[0] === 0x8f, 2500, '卡片刷新回执');
    try {
      // 0x45 renders inside the tag's write callback, which can outlast the connection.
      await commandChar.writeValueWithoutResponse(Uint8Array.of(0x45));
    } catch (error) {
      waiter.cancel(error);
      throw error;
    }
    return waiter.promise.catch(() => null);
  }

  async function command(bytes, predicate, timeoutMs, label) {
    const waiter = makeWaiter((packet) => packet[0] === 0x8f || predicate(packet), timeoutMs, label);
    try {
      await writeWithResponse(Uint8Array.from(bytes));
      const packet = await waiter.promise;
      if (packet[0] === 0x8f) throw new Error('价签拒绝命令，错误码 ' + packet[1]);
      return packet;
    } catch (error) {
      waiter.cancel(error);
      throw error;
    }
  }

  function requireOk(packet, commandId) {
    if (packet[0] !== commandId || packet[1] !== 0) {
      throw new Error('价签返回失败：命令 0x' + commandId.toString(16) + '，状态 ' + packet[1]);
    }
    return packet;
  }

  async function queryStatus() {
    panel = null;
    updateControls();
    const requestStatus = (timeout) => command([0x17], (p) => p[0] === 0x97, timeout, '传图状态');
    let packet;
    try {
      packet = await requestStatus(2000);
    } catch (error) {
      // 刚订阅通知时设备可能漏发第一帧。0x17 只读，可以安全重试一次。
      if (!(error instanceof NotificationTimeout) || !connected) throw error;
      packet = await requestStatus(5000);
    }
    panel = readPanel(packet);
    const status = { active: packet[1], loaded: packet[2], got: u32le(packet, 3) };
    const planeCount = panel.mode === 'bwr' || panel.mode === 'bwy' ? 2 : 1;
    if (status.active > planeCount || status.loaded > planeCount) {
      panel = null;
      throw new Error('设备报告了无效的平面编号');
    }
    transferPlane = status.active;
    updateControls();
    if (status.active) {
      setStatus('价签有未完成的平面 ' + status.active + '（已收 ' + status.got.toLocaleString() + ' B）。请先点“中止未完成传输”，再发送新图。', 'bad');
    } else if (status.loaded) {
      setStatus('价签上有已提交的平面 ' + status.loaded + '；开始新传输会覆盖它。', '');
    } else {
      setStatus('价签已连接，当前没有未完成传输。', 'good');
    }
    return status;
  }

  async function queryMtu() {
    token = (token + 1) & 255;
    const expectedToken = token;
    const packet = await command([0x18, expectedToken], (p) => p[0] === 0x98 && p.length >= 4 && p[1] === expectedToken, 7000, 'MTU 查询');
    const mtu = packet[2];
    if (mtu < 23) throw new Error('价签报告的 ATT MTU 无效：' + mtu);
    return mtu;
  }

  async function sendPlane(planeBytes, planeNumber, mtu, progressBase) {
    const total = planeBytes.length;
    const wantedCrc = crc32(planeBytes);
    const begin = [0x10, planeNumber, 0, 0, 0, 0, 0, 0, 0, 0];
    putU32le(begin, 2, total);
    putU32le(begin, 6, wantedCrc);
    const maxPayload = Math.min(243, mtu - 4);
    const planeLabel = '平面 ' + planeNumber;
    let sent = 0;
    let stage = '擦除 Flash';
    transferPlane = planeNumber;

    try {
      setStatus(planeLabel + '：正在擦除 Flash…', '');
      requireOk(await command(begin, (p) => p[0] === 0x90 && p.length >= 2, 20000, '平面擦除'), 0x90);

      stage = '写入图像数据';
      setStatus(planeLabel + '：正在写入 ' + total.toLocaleString() + ' B 图像数据…', '');
      // The tag programs Flash in the receive callback. Let ATT acknowledge each write
      // before sending the next one. The 0x91 progress notification may be lost.
      while (sent < total) {
        const count = Math.min(maxPayload, total - sent);
        const chunk = new Uint8Array(count + 1);
        chunk[0] = 0x11;
        chunk.set(planeBytes.subarray(sent, sent + count), 1);
        await writeWithResponse(chunk);
        sent += count;
        setProgress(progressBase + sent);
      }

      stage = 'Flash 回读校验';
      setStatus(planeLabel + '：正在读回 Flash 并校验 CRC32…', '');
      const commit = await command([0x12], (p) => p[0] === 0x92 && p.length >= 10, 30000, stage);
      requireOk(commit, 0x92);
      const got = u32le(commit, 2);
      const actualCrc = u32le(commit, 6);
      if (got !== total || actualCrc !== wantedCrc) {
        throw new Error('回读不匹配：长度 ' + got + '，CRC32 0x' + actualCrc.toString(16).padStart(8, '0') + '（期望 0x' + wantedCrc.toString(16).padStart(8, '0') + '）');
      }

      stage = '写入面板 RAM';
      setStatus(planeLabel + '：正在写入面板 RAM…', '');
      const pushed = await command([0x13, planeNumber], (p) => p[0] === 0x93 && p.length >= 4, 20000, stage);
      requireOk(pushed, 0x93);
      transferPlane = 0;
      updateControls();
    } catch (error) {
      const detail = device?.gatt.connected ? error.message : 'BLE 连接已断开，请重新连接';
      const count = sent.toLocaleString() + ' / ' + total.toLocaleString() + ' B 已获写入确认';
      throw new Error(planeLabel + ' · ' + stage + '（' + count + '）：' + detail, { cause: error });
    }
  }

  async function refreshPanel() {
    const finished = makeWaiter((packet) => packet.disconnected || (packet[0] === 0x94 && packet.length >= 6 && packet[1] !== 0), 40000, '面板全刷完成通知');
    refreshInProgress = true;
    refreshAccepted = false;
    refreshDisconnected = false;
    refreshCompletionWaiter = finished;
    try {
      await command([0x14], (p) => p[0] === 0x94 && p.length >= 2 && p[1] === 0, 8000, '全刷接受通知');
      refreshAccepted = true;
      setStatus('价签已接受全刷，等待刷新完成通知…', '');
      const done = await finished.promise;
      if (done.disconnected) return { accepted: true, disconnected: true };
      if (done[1] !== 1) throw new Error('价签报告面板刷新失败，状态 ' + done[1]);
      const totalMs = (done[4] << 8) | done[5];
      if (!totalMs) throw new Error('价签报告面板刷新耗时为 0');
      return { accepted: true, disconnected: false, packet: done };
    } catch (error) {
      finished.cancel(error);
      if (refreshDisconnected) return { accepted: refreshAccepted, disconnected: true };
      throw error;
    } finally {
      refreshInProgress = false;
      refreshAccepted = false;
      refreshDisconnected = false;
      refreshCompletionWaiter = null;
    }
  }

  async function beforeTransfer(stage, request) {
    try {
      return await request();
    } catch (error) {
      throw new Error(stage + '（0 B 已获写入确认）：' + error.message, { cause: error });
    }
  }

  async function sendImage() {
    const status = await beforeTransfer('读取价签传图状态', queryStatus);
    if (status.active) return;
    lab.finishPendingRender();
    const { colorMode } = lab.state;
    // 竖版编辑时 codes 要先顺时针旋转成横版，尺寸也用成品尺寸与价签比对
    const codes = lab.outputCodes();
    const { w, h } = lab.outDims();
    if (codes?.length !== w * h) throw new Error('请先添加图层');
    if (!panelMatches(panel, { w, h, colorMode })) {
      throw new Error('画布与设备规格不符：' + panelDescription(panel));
    }

    const packed = lab.B.pack(codes, w, h, { colorMode, encoding: 'driver' });
    const planes = packed.plane1 ? [packed.plane0, packed.plane1] : [packed.plane0];
    const mtu = await beforeTransfer('查询 ATT MTU', queryMtu);
    $('bleProgress').max = packed.bytes;
    setProgress(0);
    for (const [index, bytes] of planes.entries()) {
      await sendPlane(bytes, index + 1, mtu, index * packed.planeBytes);
    }
    const refresh = await refreshPanel();
    if (refresh.disconnected) {
      const message = refresh.accepted
        ? '图像已传完并通过 Flash CRC32 回读。价签已接受全刷，但刷新完成通知到达前 BLE 断开；屏幕结果未知，请查看屏幕确认。'
        : '图像已传完并通过 Flash CRC32 回读。发送全刷请求期间 BLE 断开，页面无法确认价签是否接受或完成刷新；请查看屏幕确认。';
      setStatus(message, 'warn');
      return;
    }
    const refreshMs = (refresh.packet[4] << 8) | refresh.packet[5];
    releaseConnection();
    setStatus('传图、Flash CRC32 回读校验和屏幕刷新均已完成（' + (refreshMs / 1000).toFixed(1) + ' 秒）。蓝牙已断开。', 'good');
  }

  async function connect() {
    if (connected) return;
    if (!canUseBluetooth()) throw new Error('请在 HTTPS 页面和支持 Web Bluetooth 的 Chrome / Edge 中打开');
    const link = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'ESL-' }, { services: [SERVICE] }],
      optionalServices: [SERVICE],
    });
    device = link;
    link.addEventListener('gattserverdisconnected', onDisconnected);
    try {
      const server = await link.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      commandChar = await service.getCharacteristic(CMD);
      responseChar = await service.getCharacteristic(RSP);
      responseChar.addEventListener('characteristicvaluechanged', receive);
      await responseChar.startNotifications();
      if (!link.gatt.connected) throw new Error('BLE 连接已断开');
      connected = true;
      $('bleLinkBadge').textContent = link.name || 'ESL 价签';
      $('bleLinkBadge').classList.add('ble-connected');
      $('bleProgress').hidden = true;
      updateControls();
      await queryStatus();
    } catch (error) {
      onDisconnected();
      if (link.gatt.connected) link.gatt.disconnect();
      throw error;
    }
  }

  function onDisconnected() {
    const transferInterrupted = transferPlane || refreshInProgress;
    device?.removeEventListener('gattserverdisconnected', onDisconnected);
    responseChar?.removeEventListener('characteristicvaluechanged', receive);
    device = null;
    connected = false;
    commandChar = null;
    responseChar = null;
    transferPlane = 0;
    panel = null;
    $('bleLinkBadge').textContent = '未连接';
    $('bleLinkBadge').classList.remove('ble-connected');
    if (refreshInProgress) {
      refreshDisconnected = true;
      if (refreshCompletionWaiter) refreshCompletionWaiter.finish({ disconnected: true }, null);
    }
    failWaiters(new Error('BLE 连接已断开'));
    if (!busy) {
      setStatus(transferInterrupted
        ? '传输中断。请重新连接价签并检查传输状态。'
        : '价签已断开。', transferInterrupted ? 'warn' : '');
    }
    updateControls();
  }

  function releaseConnection() {
    if (device?.gatt.connected) device.gatt.disconnect();
    if (device) onDisconnected();
  }

  function disconnect() {
    releaseConnection();
    setStatus('价签已断开。', '');
  }

  async function abortTransfer() {
    if (!connected || !transferPlane) return;
    const plane = transferPlane;
    const packet = await command([0x15], (p) => p[0] === 0x95 && p.length >= 2, 10000, '中止回执');
    requireOk(packet, 0x95);
    transferPlane = 0;
    const status = await queryStatus();
    if (!status.active) setStatus('未完成的平面 ' + plane + ' 已中止，可以安全开始新传图。', 'good');
  }

  async function runBusy(action, onError = (message) => setStatus(message, 'bad')) {
    if (busy || externalBusy) return;
    busy = true;
    updateControls();
    try {
      await action();
    } catch (error) {
      // A rejected GATT operation can arrive before the disconnect event.
      if (device && !device.gatt.connected) onDisconnected();
      const message = String((error && error.message) || error || '未知错误');
      onError(message);
    } finally {
      busy = false;
      updateControls();
    }
  }

  $('bleConnect').addEventListener('click', () => runBusy(connect));
  $('bleDisconnect').addEventListener('click', () => runBusy(disconnect));
  $('bleSend').addEventListener('click', () => runBusy(sendImage));
  $('bleAbort').addEventListener('click', () => runBusy(abortTransfer));
  window.addEventListener('bwr:render', updateControls);
  window.INK_BLE = {
    connect: (onError) => runBusy(connect, onError),
    disconnect: () => runBusy(disconnect),
    subscribe(listener) {
      linkListeners.add(listener);
      updateControls();
      return () => linkListeners.delete(listener);
    },
    onNotify(listener) {
      notifyListeners.add(listener);
      return () => notifyListeners.delete(listener);
    },
    isConnected: () => connected,
    deviceName: () => device?.name || '',
    setBusy(value) {
      externalBusy = !!value;
      updateControls();
    },
    runBusy, command, writeWithResponse, queryMtu, requestCardRefresh, crc32,
  };
  updateControls();
})();
