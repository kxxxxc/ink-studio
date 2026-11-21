/* BWR Lab — Web Bluetooth direct transfer to the 7.5-inch TLSR8359 tag. */
(function () {
  'use strict';

  const lab = window.__BWR_LAB__;
  const $ = (id) => document.getElementById(id);
  const SERVICE = '0000a000-0000-1000-8000-00805f9b34fb';
  const CMD = '0000a001-0000-1000-8000-00805f9b34fb';
  const RSP = '0000a002-0000-1000-8000-00805f9b34fb';
  const PLANE_BYTES = 48000;
  const TOTAL_BYTES = PLANE_BYTES * 2;
  const WINDOW_BYTES = 4096;
  const waiters = new Set();
  let device = null;
  let commandChar = null;
  let responseChar = null;
  let connected = false;
  let busy = false;
  let transferPlane = 0;
  let transferBlocked = false;
  let latestAck = 0;
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
    progress.value = Math.max(0, Math.min(TOTAL_BYTES, value));
  }

  function canUseBluetooth() {
    return !!(window.isSecureContext && navigator.bluetooth);
  }

  function hasCompatiblePanel() {
    return lab.state.w === 800 && lab.state.h === 480 && lab.state.colorMode === 'bwr';
  }

  function updateControls() {
    const canConnect = canUseBluetooth();
    $('bleConnect').hidden = connected;
    $('bleConnect').disabled = busy || connected || !canConnect;
    $('bleDisconnect').hidden = !connected;
    $('bleDisconnect').disabled = busy || !connected;
    $('bleSend').disabled = busy || !connected || transferBlocked ||
      !hasCompatiblePanel() || lab.state.codes?.length !== 800 * 480;
    $('bleAbort').hidden = !connected || !transferPlane;
    $('bleAbort').disabled = busy || !connected || !transferPlane;

    let hint = '';
    if (!window.isSecureContext) {
      hint = '蓝牙直连需要通过 HTTPS 或 localhost 打开。';
    } else if (!canConnect) {
      hint = '蓝牙直连可用桌面 Chrome / Edge 或 Android Chrome。';
    } else if (!hasCompatiblePanel()) {
      hint = '价签直传使用 7.5 寸（800 × 480）黑白红三色画布。';
    }
    $('bleSupport').textContent = hint;
    $('bleSupport').hidden = !hint;
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
    waiter.timer = setTimeout(() => waiter.finish(null, new Error('等待' + label + '超时')), timeoutMs);
    waiters.add(waiter);
    return waiter;
  }

  function receive(event) {
    const packet = packetBytes(event.target.value);
    if (!packet.length) return;
    if (packet[0] === 0x91 && packet.length >= 5) {
      latestAck = u32le(packet, 1);
      if (transferPlane) setStatus('平面 ' + transferPlane + '：价签已接收 ' + latestAck.toLocaleString() + ' / ' + PLANE_BYTES.toLocaleString() + ' B', '');
    }
    for (const waiter of Array.from(waiters)) {
      try {
        if (waiter.predicate(packet)) waiter.finish(packet, null);
      } catch (error) {
        waiter.finish(null, error);
      }
    }
  }

  function failWaiters(error) {
    for (const waiter of Array.from(waiters)) waiter.finish(null, error);
  }

  async function writeWithResponse(bytes) {
    if (!connected || !commandChar) throw new Error('BLE 已断开');
    if (commandChar.writeValueWithResponse) return commandChar.writeValueWithResponse(bytes);
    if (commandChar.writeValue) return commandChar.writeValue(bytes);
    throw new Error('当前浏览器不支持 GATT 写入');
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
    transferBlocked = true;
    updateControls();
    const packet = await command([0x17], (p) => p[0] === 0x97 && p.length >= 7, 7000, '传图状态');
    const status = { active: packet[1], loaded: packet[2], got: u32le(packet, 3) };
    transferPlane = status.active;
    transferBlocked = !!status.active;
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

  function waitForAck(target, timeoutMs) {
    if (latestAck >= target) return Promise.resolve(latestAck);
    const waiter = makeWaiter((packet) => packet[0] === 0x91 && packet.length >= 5 && u32le(packet, 1) >= target, timeoutMs, '数据分块确认');
    return waiter.promise.then((packet) => u32le(packet, 1));
  }

  async function sendPlane(planeBytes, planeNumber, mtu, progressBase) {
    if (planeBytes.length !== PLANE_BYTES) throw new Error('平面长度不是 48,000 B');
    const wantedCrc = crc32(planeBytes);
    const begin = [0x10, planeNumber, 0, 0, 0, 0, 0, 0, 0, 0];
    putU32le(begin, 2, planeBytes.length);
    putU32le(begin, 6, wantedCrc);
    latestAck = 0;
    transferPlane = planeNumber;
    requireOk(await command(begin, (p) => p[0] === 0x90 && p.length >= 2, 20000, '平面擦除'), 0x90);

    const maxPayload = Math.min(243, mtu - 4);
    if (maxPayload < 1) throw new Error('ATT MTU 太小，无法发送图像');
    let sent = 0;
    let acked = 0;
    while (sent < planeBytes.length) {
      if (!connected) throw new Error('传输过程中 BLE 断开');
      const windowRoom = Math.max(1, WINDOW_BYTES - (sent - acked));
      const count = Math.min(maxPayload, windowRoom, planeBytes.length - sent);
      const chunk = new Uint8Array(count + 1);
      chunk[0] = 0x11;
      chunk.set(planeBytes.subarray(sent, sent + count), 1);
      if (!commandChar.writeValueWithoutResponse) throw new Error('当前浏览器不支持无响应 BLE 写入');
      await commandChar.writeValueWithoutResponse(chunk);
      sent += count;
      setProgress(progressBase + sent);
      if (sent - acked >= WINDOW_BYTES && sent < planeBytes.length) {
        acked = await waitForAck(acked + WINDOW_BYTES, 15000);
      }
    }

    setStatus('平面 ' + planeNumber + ' 已发送 ' + sent.toLocaleString() + ' B，正在让价签读回 Flash 并校验 CRC32…', '');
    const commit = await command([0x12], (p) => p[0] === 0x92 && p.length >= 10, 30000, 'Flash 回读校验');
    requireOk(commit, 0x92);
    const got = u32le(commit, 2);
    const actualCrc = u32le(commit, 6);
    if (got !== planeBytes.length || actualCrc !== wantedCrc) {
      throw new Error('平面 ' + planeNumber + ' 回读不匹配：长度 ' + got + '，CRC32 0x' + actualCrc.toString(16).padStart(8, '0') + '（期望 0x' + wantedCrc.toString(16).padStart(8, '0') + '）');
    }

    const pushed = await command([0x13, planeNumber], (p) => p[0] === 0x93 && p.length >= 4, 20000, '写入面板 RAM');
    requireOk(pushed, 0x93);
    transferPlane = 0;
    updateControls();
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
      setStatus('价签已接受全刷，正在驱动面板（通常约 26 秒）…', '');
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

  async function sendImage() {
    lab.finishPendingRender();
    if (!lab.state.codes) throw new Error('请先添加图片或手写图层');
    if (!hasCompatiblePanel()) throw new Error('请先选择 7.5 寸（800 × 480）黑白红三色画布');

    const packed = lab.B.pack(lab.state.codes, lab.state.w, lab.state.h, {
      encoding: 'driver', invertBW: false, invertRed: false,
    });
    if (packed.planeBytes !== PLANE_BYTES) throw new Error('转换结果不是 800×480 双平面');
    const status = await queryStatus();
    if (status.active) return;

    const mtu = await queryMtu();
    const mtuPayload = Math.min(243, mtu - 4);
    setProgress(0);
    setStatus('开始传图：ATT MTU ' + mtu + '，每个 BLE 包最多 ' + mtuPayload + ' B 图像数据。', '');
    await sendPlane(packed.plane0, 1, mtu, 0);
    await sendPlane(packed.plane1, 2, mtu, PLANE_BYTES);
    setProgress(TOTAL_BYTES);
    const refresh = await refreshPanel();
    if (refresh.disconnected) {
      const message = refresh.accepted
        ? '两个平面已传完并通过 Flash CRC32 回读。价签已接受全刷，但刷新完成通知到达前 BLE 断开；屏幕结果未知，请查看屏幕确认。'
        : '两个平面已传完并通过 Flash CRC32 回读。发送全刷请求期间 BLE 断开，页面无法确认价签是否接受或完成刷新；请查看屏幕确认。';
      setStatus(message, 'warn');
      return;
    }
    const refreshMs = (refresh.packet[4] << 8) | refresh.packet[5];
    setStatus('传图、两个平面的 Flash CRC32 回读校验和屏幕刷新均已完成（' + (refreshMs / 1000).toFixed(1) + ' 秒）。', 'good');
  }

  async function connect() {
    if (!canUseBluetooth()) throw new Error('请在 HTTPS 页面和支持 Web Bluetooth 的 Chrome / Edge 中打开');
    const link = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'ESL-' }],
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
    transferBlocked = false;
    $('bleLinkBadge').textContent = '未连接';
    $('bleLinkBadge').classList.remove('ble-connected');
    if (refreshInProgress) {
      refreshDisconnected = true;
      if (refreshCompletionWaiter) refreshCompletionWaiter.finish({ disconnected: true }, null);
    }
    failWaiters(new Error('BLE 连接已断开'));
    setStatus(transferInterrupted
      ? '传输中断。请重新连接价签并检查传输状态。'
      : '价签已断开。', transferInterrupted ? 'warn' : '');
    updateControls();
  }

  async function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    else onDisconnected();
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

  async function runBusy(action) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      await action();
    } catch (error) {
      const message = String((error && error.message) || error || '未知错误');
      setStatus(message, 'bad');
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
  updateControls();
})();
