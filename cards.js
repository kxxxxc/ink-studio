/* Ink Studio — TLSR8359 on-device cards over the shared Web Bluetooth link. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ble = window.INK_BLE;
  const modeNames = ['', '月历', '日历 + 天气', '五天天气', '倒计时', '每日一言'];
  const settingsIds = ['cardMode', 'cardWeek', 'cardLat', 'cardLon', 'cardCity',
    'cardCdTitle', 'cardCdDate', 'cardCdBody', 'cardQuoteRows'];
  const settingsKey = 'ink-studio-cards';
  const encoder = new TextEncoder();
  const weatherNames = ['晴', '多云', '阴', '小雨', '中雨', '大雨', '雷阵雨', '小雪',
    '中雪', '大雪', '雨夹雪', '雾', '霾', '沙尘', '大风', '未知'];
  const weatherCodes = {0:0, 1:0, 2:1, 3:2, 45:11, 48:11, 51:3, 53:3, 55:4,
    56:10, 57:10, 61:3, 63:4, 65:5, 66:10, 67:10, 71:7, 73:8, 75:9, 77:8,
    80:3, 81:4, 82:5, 85:8, 86:9, 95:6, 96:6, 99:6};
  const beaufort = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
  const demoQuotes = [
    '不积跬步，无以至千里；不积小流，无以成江海。 | 《荀子·劝学》',
    '路漫漫其修远兮，吾将上下而求索。 | 屈原《离骚》',
    '海内存知己，天涯若比邻。 | 王勃',
    '问渠那得清如许？为有源头活水来。 | 朱熹',
    '纸上得来终觉浅，绝知此事要躬行。 | 陆游',
    '山重水复疑无路，柳暗花明又一村。 | 陆游',
    '长风破浪会有时，直挂云帆济沧海。 | 李白',
  ];
  const pad = (v) => String(v).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const le16 = (v) => [v & 255, (v >>> 8) & 255];
  const cardMode = () => Number($('cardMode').value);
  const weatherMode = (mode) => mode === 2 || mode === 3;
  const code = (v) => weatherCodes[v] ?? 15;
  const bounded = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : 0)));
  const temp = (v) => bounded(v, -128, 127) & 255;
  const percent = (v) => bounded(v, 0, 100);
  const compass = (v) => Number.isFinite(v) ? (Math.round(v / 45) + 8) % 8 : 255;
  const wind = (v) => Number.isFinite(v) ? beaufort.filter((limit) => v >= limit).length : 0;
  const holidayCache = new Map();
  let link, loading = false, results = [];
  let forecast = null;

  function status(message, kind = '') {
    const node = $('cardStatus');
    node.textContent = message;
    node.hidden = !message;
    node.className = 'ble-status' + (kind ? ' ' + kind : '');
  }

  function supportsCards() {
    const panel = link?.panel;
    return panel?.w === 800 && panel.h === 480 && panel.mode === 'bwr';
  }

  function updateControls() {
    if (!link) return;
    const blocked = link.busy || loading;
    const capable = link.connected && supportsCards();
    $('cardFields').disabled = blocked;
    $('cardConnect').hidden = link.connected;
    $('cardConnect').disabled = blocked || !link.canConnect;
    $('cardDisconnect').hidden = !link.connected;
    $('cardDisconnect').disabled = blocked;
    $('cardRead').disabled = blocked || !capable;
    $('cardPush').disabled = blocked || !capable || !!link.transferPlane;
    $('cardQuoteNext').hidden = cardMode() !== 5;
    $('cardQuoteNext').disabled = $('cardPush').disabled;
    $('cardLink').textContent = link.connected ? (link.name || 'ESL 价签') : '未连接';
    $('cardLink').classList.toggle('ble-connected', link.connected);
    let hint = '';
    if (!link.canConnect) hint = '蓝牙直连需要 HTTPS 和支持 Web Bluetooth 的 Chrome 或 Edge。';
    else if (link.connected && !capable) hint = '这些卡片需要支持本机渲染的 800 × 480 黑白红价签。';
    else if (link.transferPlane) hint = '价签正在接收图片，请先完成或中止传图。';
    $('cardLinkHint').textContent = hint;
  }

  function persist() {
    try {
      localStorage.setItem(settingsKey, JSON.stringify(Object.fromEntries(settingsIds.map((id) => [id, $(id).value]))));
    } catch { /* The form remains usable when storage is disabled. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(settingsKey));
      for (const id of settingsIds) {
        if (typeof saved?.[id] === 'string') $(id).value = saved[id];
      }
    } catch { /* Use the default form values. */ }
    if (!modeNames[cardMode()]) $('cardMode').value = '1';
    if ($('cardWeek').value !== '1') $('cardWeek').value = '0';
  }

  function quoteRows() {
    return $('cardQuoteRows').value.split(/\r?\n/).map((raw) => raw.trim()).filter(Boolean).map((line) => {
      const divider = line.lastIndexOf('|');
      return divider < 0 ? [line, ''] : [line.slice(0, divider).trim(), line.slice(divider + 1).trim()];
    });
  }

  function updateForm() {
    const mode = cardMode();
    $('cardCalendar').hidden = mode > 2;
    $('cardWeather').hidden = !weatherMode(mode);
    $('cardCountdown').hidden = mode !== 4;
    $('cardQuotes').hidden = mode !== 5;
    $('cardTextHint').hidden = mode < 4;
    if (mode === 4) {
      const target = $('cardCdDate').valueAsNumber;
      const today = Date.parse(dateKey(new Date()));
      const days = Number.isFinite(target) ? `距目标 ${Math.max(0, Math.round((target - today) / 86400000))} 天 · ` : '';
      const metrics = ['cardCdTitle', 'cardCdBody'].map((id) => encoder.encode($(id).value.trim()).length);
      $('cardCdNote').textContent = `${days}标题 ${metrics[0]}/47 B · 正文 ${metrics[1]}/119 B`;
    }
    if (mode === 5) {
      const rows = quoteRows();
      const size = rows.reduce((n, [body, source]) => n + 2 + encoder.encode(body + source).length, 6);
      $('cardQuoteNote').textContent =
      `已用 ${(size / 1024).toFixed(1)} KB / 16 KB · ${rows.length} 条 · 每条正文 ≤223 B、出处 ≤39 B`;
    }
    updateControls();
  }

  function countdownPacket() {
    const [year, month, day] = $('cardCdDate').value.split('-').map(Number);
    if (!$('cardCdDate').value || !$('cardCdDate').validity.valid) throw new Error('请输入 2000–2099 年内的目标日期');
    const title = encoder.encode($('cardCdTitle').value.trim());
    const body = encoder.encode($('cardCdBody').value.trim());
    if (!title.length || title.length > 47) throw new Error('倒计时标题需要 1–47 字节');
    if (body.length > 119) throw new Error('倒计时正文最多 119 字节');
    return [0x50, ...le16(year), month, day, title.length, ...title, body.length, ...body];
  }

  function quoteBlob(rows) {
    if (rows.length < 1 || rows.length > 255) throw new Error('请输入 1–255 条一言');
    const bytes = [...encoder.encode('QT01'), rows.length, 0];
    for (const [index, [body, source]] of rows.entries()) {
      const b = encoder.encode(body), s = encoder.encode(source);
      if (b.length < 1 || b.length > 223 || s.length > 39) {
        throw new Error(`第 ${index + 1} 条的一言正文需要 1–223 字节，出处最多 39 字节`);
      }
      bytes.push(b.length, ...b, s.length, ...s);
    }
    if (bytes.length > 16384) throw new Error('一言整包最多 16384 字节');
    return Uint8Array.from(bytes);
  }

  async function getJson(url, signal = AbortSignal.timeout(8000)) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function inputTask(action, output) {
    if (loading || link.busy) return;
    loading = true;
    updateControls();
    try { await action(); }
    catch (error) { $(output).textContent = error.message; }
    finally { loading = false; updateControls(); }
  }

  function location() {
    const lat = $('cardLat').valueAsNumber, lon = $('cardLon').valueAsNumber;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error('请先选择城市，或在自定义坐标中填写有效的经纬度');
    }
    return { lat, lon, city: $('cardCity').value.trim() };
  }

  function shortCity(city) {
    let label = '';
    for (const character of city) {
      if (encoder.encode(label + character).length > 11) break;
      label += character;
    }
    return label;
  }

  function locationChanged() {
    forecast = null;
    $('cardWeatherStatus').textContent = '';
    try {
      const { lat, lon, city } = location();
      const label = shortCity(city);
      $('cardLocation').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}${label ? ' · 屏上显示 ' + label : ''}`;
    } catch { $('cardLocation').textContent = '尚未选择天气位置'; }
    persist();
  }

  async function searchCities() {
    const name = $('cardCitySearch').value.trim();
    if (name.length < 2) throw new Error('请输入至少两个字符的城市名');
    $('cardWeatherStatus').textContent = '正在查找城市…';
    $('cardLocations').hidden = true;
    const query = new URLSearchParams({ name, language: 'zh', count: 8 });
    const found = await getJson('https://geocoding-api.open-meteo.com/v1/search?' + query);
    results = (found.results || []).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    if (!results.length) throw new Error('没有找到城市，可试试全名或填写坐标');
    $('cardLocations').replaceChildren(new Option('选择城市', ''), ...results.map((r, i) =>
      new Option([...new Set([r.name, r.admin1, r.country].filter(Boolean))].join(' · '), String(i))));
    $('cardLocations').hidden = false;
    $('cardWeatherStatus').textContent = '';
  }

  async function fetchWeather(place) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const key = `${place.lat},${place.lon},${timezone},${dateKey(new Date())}`;
    if (forecast?.key === key && Date.now() - forecast.at < 300000) return forecast.data;
    $('cardWeatherStatus').textContent = '正在取天气…';
    const query = new URLSearchParams({
      latitude: place.lat, longitude: place.lon, timezone, forecast_days: 7,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,surface_pressure,weather_code,precipitation_probability,wind_speed_10m,wind_direction_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant',
      hourly: 'temperature_2m,precipitation_probability',
    });
    try {
      const data = await getJson('https://api.open-meteo.com/v1/forecast?' + query);
      const current = data.current;
      if (!Number.isFinite(current?.temperature_2m) || !Array.isArray(data.daily?.time) || !Array.isArray(data.hourly?.time)) {
        throw new Error('天气接口返回的数据不完整');
      }
      forecast = { key, at: Date.now(), data };
      $('cardWeatherStatus').textContent = `${weatherNames[code(current.weather_code)]} · ${Math.round(current.temperature_2m)} ℃ · ${current.time.replace('T', ' ')}`;
      return data;
    } catch (error) {
      $('cardWeatherStatus').textContent = '取天气失败：' + error.message;
      throw new Error($('cardWeatherStatus').textContent, { cause: error });
    }
  }

  function weatherPacket({ daily, current, hourly }, today) {
    const base = daily.time.indexOf(today);
    const days = Math.min(7, daily.time.length - base);
    if (base < 0 || days < 5 || current.time.slice(0, 10) !== today) throw new Error('天气日期与本机日期不一致，请重新取天气');
    const clock = (value) => typeof value === 'string' ? value.slice(11, 16).split(':').map(Number) : [0, 0];
    const packet = [0x43, days];
    for (let i = base; i < base + days; i++) {
      const w = code(daily.weather_code[i]);
      packet.push(w, temp(daily.temperature_2m_max[i]), temp(daily.temperature_2m_min[i]), w,
        percent(daily.precipitation_probability_max[i]), ...clock(daily.sunrise[i]), ...clock(daily.sunset[i]),
        0, compass(daily.wind_direction_10m_dominant[i]), wind(daily.wind_speed_10m_max[i]));
    }
    packet.push(code(current.weather_code), temp(current.temperature_2m), temp(current.apparent_temperature),
      percent(current.relative_humidity_2m), ...le16(bounded(current.surface_pressure, 0, 65535)),
      percent(current.precipitation_probability), compass(current.wind_direction_10m), wind(current.wind_speed_10m));
    for (let hour = 0; hour < 24; hour++) {
      const i = hourly.time.indexOf(`${today}T${pad(hour)}:00`);
      packet.push(temp(hourly.temperature_2m[i] ?? current.temperature_2m), percent(hourly.precipitation_probability[i]));
    }
    if (packet.length !== 2 + days * 12 + 9 + 48 || packet.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      throw new Error('天气字段格式错误');
    }
    return packet;
  }

  async function holidayRows(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);
    for (const base of ['https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/',
      'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/']) {
      try {
        const data = await getJson(`${base}${year}.json`, AbortSignal.timeout(4500));
        if (!Array.isArray(data.days) || !data.days.length || data.days.length > 64) continue;
        const rows = data.days.map(({ date, isOffDay }) => {
          const d = new Date(date + 'T00:00:00Z');
          if (d.getUTCFullYear() !== year || d.toISOString().slice(0, 10) !== date || typeof isOffDay !== 'boolean') {
            throw new Error('调休日历格式错误');
          }
          return [d.getUTCMonth() + 1, d.getUTCDate(), isOffDay ? 1 : 2];
        });
        holidayCache.set(year, rows);
        return rows;
      } catch { /* Try the next public source. */ }
    }
    return null;
  }

  async function fetchQuotes() {
    const quotes = new Map();
    const signal = AbortSignal.timeout(12000);
    for (let i = 0; i < 10 && quotes.size < 7 && !signal.aborted; i++) {
      $('cardQuoteStatus').textContent = `正在取一言（${quotes.size}/7）…`;
      try {
        const quote = await getJson(`https://v1.hitokoto.cn/?c=i&_=${Date.now()}-${i}`, signal);
        const body = String(quote.hitokoto ?? '').trim().replace(/\s+/g, ' ').replaceAll('|', '｜');
        const source = String(quote.from ?? '').trim().replace(/\s+/g, ' ').replaceAll('|', '｜');
        if (body && encoder.encode(body).length <= 223 && encoder.encode(source).length <= 39) quotes.set(body, source);
      } catch {
        if (!quotes.size) throw new Error('一言接口暂不可用，仍可填入示例或手动编辑');
        break;
      }
    }
    if (!quotes.size) throw new Error('一言接口没有返回可用的内容');
    $('cardQuoteRows').value = [...quotes].map(([body, source]) => `${body} | ${source}`).join('\n');
    $('cardQuoteStatus').textContent = `已从一言接口取到 ${quotes.size} 条。`;
    updateForm();
    persist();
  }

  async function request(frame, opcode, length, label) {
    try {
      const reply = await ble.command(frame, (p) => p[0] === opcode, 5000, label);
      if (reply.length !== length) throw new Error('回执长度不符');
      return reply;
    } catch (error) { throw new Error(label + '：' + error.message, { cause: error }); }
  }

  async function setFrame(frame, opcode, length, label) {
    const reply = await request(frame, opcode, length, label);
    if (reply[1] !== 1) throw new Error(label + '被价签拒绝');
    return reply;
  }

  async function readCard() {
    // 0.6.x C6: opcode + 17 bytes. The first 13 payload bytes keep the old
    // layout; the last four are pre_ms and total_ms (u16BE each).
    const p = await request([0x46], 0xc6, 18, '读取卡片状态');
    return { mode: p[1], weather: p[3], rest: p[4], flags: p[5], busyMs: (p[6] << 8) | p[7],
      clock: p[8] & 1, month: p[9], day: p[10], quotes: p[11], slot: p[12],
      countdown: p[13] & 1, fonts: p[13] & 4,
      preMs: (p[14] << 8) | p[15], totalMs: (p[16] << 8) | p[17] };
  }

  async function sendRest(year, rows, payload) {
    await setFrame([0x40, ...le16(year), rows.length], 0xc0, 2, '开始同步调休');
    const batch = Math.floor((payload - 1) / 3);
    for (let i = 0; i < rows.length; i += batch) {
      await ble.writeWithResponse(Uint8Array.from([0x41, ...rows.slice(i, i + batch).flat()]));
    }
    const p = await request([0x42], 0xc2, 2, '核对调休条数');
    if (p[1] !== rows.length) throw new Error(`调休条数不符（${p[1]}/${rows.length}）`);
  }

  async function sendQuotes(blob, payload) {
    const count = blob[4], crc = ble.crc32(blob);
    const start = await setFrame([0x51, count, ...le16(blob.length), ...le16(crc), ...le16(crc >>> 16)], 0xd1, 3, '开始上传一言');
    if (start[2] !== count) throw new Error('价签回执的一言条数不符');
    for (let offset = 0; offset < blob.length; offset += payload - 1) {
      await ble.writeWithResponse(Uint8Array.from([0x52, ...blob.subarray(offset, offset + payload - 1)]));
    }
    const p = await request([0x53], 0xd3, 5, '提交一言并回读');
    const got = (p[2] << 8) | p[3];
    const reason = ['', '未开始接收', '长度不足', 'CRC32 不匹配', '整包格式无效', 'Flash 回读不一致'];
    if (p[1]) throw new Error(`一言保存失败：${reason[p[1]] || '状态 ' + p[1]}（${got}/${blob.length} B）`);
    if (got !== blob.length || p[4] !== count) throw new Error('一言回读的长度或条数不符');
  }

  async function refreshCard(summary) {
    const startedAt = Date.now();
    status(summary + ' 正在请求刷屏…');
    let reply;
    try { reply = await ble.requestCardRefresh(); }
    catch (error) { throw new Error(summary + ' 刷新请求发送失败：' + error.message, { cause: error }); }
    if (reply && (reply[0] !== 0xc5 || reply.length !== 3 || reply[1] !== 0 || reply[2] > 1)) {
      throw new Error(summary + ' 刷新回执异常，请读取价签状态。');
    }
    if (reply?.[2] === 0) {
      status(summary + ' 价签报告本次跳过刷屏，请查看当前屏幕内容。', 'warn');
      return;
    }
    const result = reply ? '价签已受理刷新。' : '刷新命令已发送，未收到价签回执。';
    status(summary + ' ' + result + ' 整刷约需 25 秒，期间蓝牙可能断开。', 'warn');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 32000 - (Date.now() - startedAt))));
    status(summary + ' ' + result + ' 请查看屏幕确认。', 'warn');
  }

  async function pushCard() {
    const mode = cardMode();
    const week = mode <= 2 ? Number($('cardWeek').value) : 0;
    const countdown = mode === 4 ? countdownPacket() : null;
    const quotes = mode === 5 ? quoteBlob(quoteRows()) : null;
    const place = weatherMode(mode) ? location() : null;
    const year = new Date().getFullYear();
    status('正在准备' + modeNames[mode] + '…');
    const [forecastData, holidays] = await Promise.all([
      place ? fetchWeather(place) : null,
      mode <= 2 ? holidayRows(year) : null,
    ]);
    const now = new Date();
    const rows = now.getFullYear() === year ? holidays : null;
    const weather = forecastData ? weatherPacket(forecastData, dateKey(now)) : null;
    const initial = await readCard();
    const mtu = await ble.queryMtu();
    const payload = Math.min(243, mtu - 3);
    if (weather && weather.length > payload) {
      throw new Error(`此连接的 ATT MTU 为 ${mtu}，天气卡片需要至少 ${weather.length + 3}。请用支持较大 MTU 的设备连接。`);
    }
    if (countdown && countdown.length > payload) throw new Error(`此连接最多可发送 ${payload} 字节，请缩短倒计时标题或正文`);

    await setFrame([0x37, ...le16(now.getFullYear()), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()],
      0xb7, 2, '同步本机时间');
    const notes = [];
    if (rows) await sendRest(year, rows, payload);
    else if (mode <= 2) notes.push('本次未同步调休表');
    if (weather) await setFrame(weather, 0xc3, 2, '写入天气');
    if (countdown) {
      const p = await setFrame(countdown, 0xd0, 4, '写入倒计时');
      if (p[2] || p[3]) notes.push(`标题缺 ${p[2]} 字，正文缺 ${p[3]} 字`);
    }
    if (quotes) {
      status(`正在保存 ${quotes[4]} 条一言…`);
      await sendQuotes(quotes, payload);
      notes.push(`${quotes[4]} 条已通过 Flash 回读`);
    }
    if (mode >= 4 && !initial.fonts) notes.push('价签未报告加载 U5 字库，部分字可能显示为方框');
    const city = encoder.encode(shortCity(place?.city ?? ''));
    await setFrame([0x44, mode, week, 0, city.length, ...city], 0xc4, 2, '设置卡片版式');
    const saved = await readCard();
    if (saved.mode !== mode || !saved.clock || saved.month !== now.getMonth() + 1 || saved.day !== now.getDate() ||
        ((saved.flags >> 2) & 1) !== week || (weather && (saved.weather !== weather[1] || (saved.flags & 3) !== 3)) ||
        (countdown && !saved.countdown) || (quotes && saved.quotes !== quotes[4])) {
      throw new Error('价签读回的卡片状态与发送内容不一致');
    }
    await refreshCard(modeNames[mode] + '已写入' + (notes.length ? '（' + notes.join('；') + '）' : '') + '。');
  }

  async function showCardStatus() {
    const info = await readCard();
    status(`${modeNames[info.mode] || '未知版式'} · ${info.clock ? `${pad(info.month)}-${pad(info.day)}` : '时间未同步'}` +
      ` · 天气 ${info.weather} 天 · 调休 ${info.rest} 条 · 倒计时${info.countdown ? '已设置' : '未设置'}` +
      ` · 一言 ${info.quotes} 条${info.quotes ? `（第 ${info.slot + 1} 条）` : ''}` +
      ` · U5 字库${info.fonts ? '已加载' : '未加载'} · 上次整刷 ${info.totalMs ? info.totalMs + ' ms' : info.busyMs + ' ms'}` +
      (info.preMs && info.totalMs ? `（准备 ${info.preMs} ms + 波形 ${info.busyMs} ms）` : ''), 'good');
  }

  async function nextQuote() {
    const current = await readCard();
    if (current.mode !== 5) throw new Error('价签当前未显示每日一言，请先推送该卡片');
    if (current.quotes < 2) throw new Error('价签至少要缓存两条一言才能切换');
    const p = await request([0x54], 0xd4, 3, '切换一言');
    if (p[1] !== current.quotes || p[2] >= p[1]) throw new Error('一言切换回执无效');
    await refreshCard(`已切换至第 ${p[2] + 1}/${p[1]} 条一言。`);
  }

  const run = (action) => ble.runBusy(async () => { status(''); await action(); }, (error) => status(error, 'bad'));
  const search = () => inputTask(searchCities, 'cardWeatherStatus');
  $('cardConnect').addEventListener('click', () => { status(''); return ble.connect((error) => status(error, 'bad')); });
  $('cardDisconnect').addEventListener('click', () => { status(''); return ble.disconnect(); });
  $('cardPush').addEventListener('click', () => run(pushCard));
  $('cardRead').addEventListener('click', () => run(showCardStatus));
  $('cardQuoteNext').addEventListener('click', () => run(nextQuote));
  $('cardSearch').addEventListener('click', search);
  $('cardCitySearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } });
  $('cardLocations').addEventListener('change', (e) => {
    const place = results[e.target.value];
    if (!place) return;
    $('cardLat').value = place.latitude;
    $('cardLon').value = place.longitude;
    $('cardCity').value = place.name;
    locationChanged();
  });
  $('cardFetchWeather').addEventListener('click', () => inputTask(() => fetchWeather(location()), 'cardWeatherStatus'));
  $('cardQuoteFetch').addEventListener('click', () => inputTask(fetchQuotes, 'cardQuoteStatus'));
  $('cardQuoteDemo').addEventListener('click', () => {
    $('cardQuoteRows').value = demoQuotes.join('\n');
    $('cardQuoteStatus').textContent = '';
    updateForm();
    persist();
  });
  for (const id of settingsIds) {
    $(id).addEventListener('input', () => {
      if (['cardLat', 'cardLon', 'cardCity'].includes(id)) locationChanged();
      else { updateForm(); persist(); }
    });
  }
  restore();
  locationChanged();
  ble.subscribe((state) => { link = state; updateControls(); });
  updateForm();
})();
