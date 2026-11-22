/* Ink Studio — 墨水屏图层编辑与传图 */
(function () {
  'use strict';

  const B = window.BWR;
  if (!B) {
    document.body.innerHTML = '<pre style="padding:20px;color:#f88">core.js 没有加载成功。</pre>';
    return;
  }
  const runtimeErrors = [];
  window.addEventListener('error', (e) => {
    const msg = String((e && e.message) || (e && e.error) || 'unknown error');
    runtimeErrors.push(msg);
    if (typeof toast === 'function') toast('脚本错误：' + msg, true);
    console.error(e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e && e.reason && e.reason.message) || (e && e.reason) || 'unhandled rejection');
    runtimeErrors.push(msg);
    console.error(e);
  });
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const LS_KEY = 'bwr-lab-v2';

  const PRE_DEFAULTS = {
    brightness: 0, contrast: 0, gamma: 1, saturation: 100,
    redBoost: 0, sharpen: 30, invert: false, blackClip: 10, whiteClip: 236,
  };
  const PARAM_DEFAULTS = {
    mode: 'nearest', space: 'oklab', dither: 'fs', strength: 1, serpentine: true,
    redBias: 0, warmOnly: true, warmGate: 60,
    dark: 64, light: 192, redScore: 42, redFirst: true, redSoft: 12, toneRed: 130,
  };
  const DEFAULT_TRANSFORM = { x: 0, y: 0, zoom: 100, angle: 0 };
  const LAYER_KINDS = { image: '图片', ink: '手写', text: '文字' };
  const RGB_CHANNELS = ['R', 'G', 'B'];
  const PANELS = window.INK_PANELS;
  const panelById = new Map(PANELS.panels.map(panel => [panel.id, panel]));
  const EMPTY_PRE = { ...PRE_DEFAULTS };
  const EMPTY_PARAMS = { ...PARAM_DEFAULTS, dither: 'none', threshold: 128 };
  const hasAccent = () => state.colorMode === 'bwr' || state.colorMode === 'bwy';
  const IMAGE_KINDS = {
    document: '文档 / 截图',
    graphic: '图标 / 插画',
    monochrome: '黑白图像',
    warm: '暖调照片',
    photo: '照片',
  };

  const state = {
    panelId: '800x480',
    w: 800, h: 480,
    colorMode: 'bwr',
    layers: [], activeLayer: null, drawing: false, erasing: false,
    sourceData: null, processed: null,
    get pre() { return this.activeLayer?.pre || EMPTY_PRE; },
    set pre(value) { if (this.activeLayer) this.activeLayer.pre = value; },
    get params() { return this.activeLayer?.params || EMPTY_PARAMS; },
    set params(value) { if (this.activeLayer) this.activeLayer.params = value; },
    debugOpen: false,
    codes: null, pack: null, metrics: null,
    resultCanvas: null, sourceCanvas: null, bwCanvas: null, redCanvas: null,
    view: 'result', split: false, splitFrac: 0.5,
    smooth: true, autoFit: true,
    zoom: 1, panX: 0, panY: 0,
    hover: null, spaceSource: false,
    renderMs: 0,
    palette: B.makePalette(PANELS.modes.bwr.colors),
    encoding: 'gateway',
    invertBW: false, invertRed: false,
  };

  let workCanvas = null, workCtx = null;
  let histDrag = null;
  let toastTimer = 0, saveTimer = 0, fitTimer = 0;
  let rafProcess = 0, rafSource = 0;
  let lastHoverKey = '';
  let imageRequest = 0, inkCount = 0, textCount = 0;
  let fileTarget, stageDrag = null, editTimer = 0;
  const stageTouches = new Map();
  let touchTransform = null;
  let supersampleCanvas = null;

  /* ---------------------------------------------------------------- utils */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function newCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2(c) { return c.getContext('2d', { willReadFrequently: true }); }
  function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(v, d) { return (v * 100).toFixed(d === undefined ? 1 : d) + '%'; }

  function toast(message, bad) {
    const t = $('toast');
    t.textContent = message;
    t.classList.toggle('bad', !!bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2300);
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1200);
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png');
    });
  }

  function baseName() {
    let s = String(state.layers[0]?.name || '').replace(/\.[^.]+$/, '');
    s = s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s || s === '尚未载入') s = 'bwr';
    return s + '-' + state.w + 'x' + state.h;
  }

  function setCanvasRGBA(canvas, w, h, rgba) {
    if (!canvas) canvas = newCanvas(w, h);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const c = canvas.getContext('2d');
    c.putImageData(new ImageData(rgba, w, h), 0, 0);
    return canvas;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- 示例图 */
  function drawChart() {
    const W = 1200, H = 900, c = newCanvas(W, H), g = ctx2(c);
    g.fillStyle = '#f1eee5'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#141414'; g.lineWidth = 12; g.strokeRect(6, 6, W - 12, H - 12);

    g.fillStyle = '#111';
    g.font = '700 34px ui-monospace, Consolas, "Courier New", monospace';
    g.fillText('BWR / CONVERSION CHART', 40, 66);
    g.font = '500 13px ui-monospace, Consolas, monospace';
    g.fillStyle = '#5b5b5b';
    g.fillText('3 INKS · 1 BIT PER PLANE · 256-STEP RAMPS · SKIN / DETAIL / RED', 40, 92);

    const cols = ['#000000', '#ffffff', '#c80000', '#6e1010', '#e8503f', '#f2b49a',
      '#b97850', '#1e5aa8', '#2e8b57', '#e0b12f', '#7b3fa0', '#808080'];
    const x0 = 40, y0 = 118, gap = 6, total = W - 80;
    const cw = (total - gap * (cols.length - 1)) / cols.length, chh = 105;
    cols.forEach((col, i) => {
      const x = x0 + i * (cw + gap);
      g.fillStyle = col; g.fillRect(x, y0, cw, chh);
      g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(x, y0, cw, chh);
      g.fillStyle = '#111'; g.font = '500 9px ui-monospace, Consolas, monospace';
      g.fillText(col.toUpperCase(), x + 3, y0 + chh + 14);
    });

    g.fillStyle = '#111'; g.font = '600 11px ui-monospace, Consolas, monospace';
    g.fillText('GRAY 0 → 255', 40, 252);
    for (let i = 0; i < 256; i++) {
      const v = i;
      g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      g.fillRect(40 + i * 1120 / 256, 262, 1120 / 256 + 1, 52);
    }
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(40, 262, 1120, 52);

    g.fillStyle = '#111'; g.font = '600 11px ui-monospace, Consolas, monospace';
    g.fillText('RED 0 → 255', 40, 338);
    for (let i = 0; i < 256; i++) {
      g.fillStyle = 'rgb(' + i + ',0,0)';
      g.fillRect(40 + i * 1120 / 256, 348, 1120 / 256 + 1, 36);
    }
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const r = Math.round(28 + 227 * t), gg = Math.round(8 + 150 * t), bb = Math.round(8 + 120 * t);
      g.fillStyle = 'rgb(' + r + ',' + gg + ',' + bb + ')';
      g.fillRect(40 + i * 1120 / 256, 388, 1120 / 256 + 1, 36);
    }

    // 肤色 / 红围巾
    const fx = 40, fy = 450, fw = 300, fh = 380;
    g.fillStyle = '#e5ddcf'; g.fillRect(fx, fy, fw, fh);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(fx, fy, fw, fh);
    const cx = fx + 150, cy = fy + 190;
    g.save();
    g.beginPath(); g.ellipse(cx, cy, 94, 120, 0, 0, Math.PI * 2); g.clip();
    const fg = g.createRadialGradient(cx - 36, cy - 48, 8, cx, cy, 155);
    fg.addColorStop(0, '#f8d8be'); fg.addColorStop(0.55, '#e2ae8b'); fg.addColorStop(1, '#b87856');
    g.fillStyle = fg; g.fillRect(fx, fy, fw, fh);
    g.fillStyle = 'rgba(120,60,30,.16)';
    g.beginPath(); g.ellipse(cx + 48, cy + 12, 52, 102, 0.15, 0, Math.PI * 2); g.fill();
    g.restore();

    g.fillStyle = '#261915';
    g.beginPath(); g.ellipse(cx, cy - 96, 106, 82, 0, Math.PI, 0); g.fill();
    g.beginPath(); g.ellipse(cx - 88, cy - 18, 24, 78, -0.12, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + 88, cy - 18, 24, 78, 0.12, 0, Math.PI * 2); g.fill();

    // 眼睛
    for (const s of [-1, 1]) {
      g.fillStyle = '#fffaf2';
      g.beginPath(); g.ellipse(cx + s * 35, cy - 16, 19, 11, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a2419';
      g.beginPath(); g.arc(cx + s * 35, cy - 15, 8, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0b0b0b';
      g.beginPath(); g.arc(cx + s * 35, cy - 15, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.beginPath(); g.arc(cx + s * 37, cy - 18, 2, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = '#6b3b2a'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(cx - 55, cy - 40); g.quadraticCurveTo(cx - 35, cy - 50, cx - 16, cy - 40); g.stroke();
    g.beginPath(); g.moveTo(cx + 16, cy - 40); g.quadraticCurveTo(cx + 35, cy - 50, cx + 55, cy - 40); g.stroke();
    g.fillStyle = 'rgba(150,55,50,.35)';
    g.beginPath(); g.ellipse(cx - 58, cy + 34, 26, 13, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + 58, cy + 34, 26, 13, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#a52d32';
    g.beginPath(); g.ellipse(cx, cy + 62, 29, 11, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#7c1d22';
    g.beginPath(); g.moveTo(cx - 120, fy + fh); g.lineTo(cx - 32, fy + fh - 78); g.lineTo(cx + 34, fy + fh); g.closePath(); g.fill();
    g.fillStyle = '#c33a3f';
    g.beginPath(); g.moveTo(cx - 92, fy + fh); g.lineTo(cx - 20, fy + fh - 66); g.lineTo(cx + 8, fy + fh); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '600 10px ui-monospace, monospace';
    g.fillText('SKIN / RED', fx + 10, fy + fh - 10);

    // 细节卡
    const dx = 370, dy = 450, dw = 790, dh = 380;
    g.fillStyle = '#fffdf7'; g.fillRect(dx, dy, dw, dh);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(dx, dy, dw, dh);
    g.fillStyle = '#111'; g.font = '700 26px ui-monospace, Consolas, monospace';
    g.fillText('DETAIL / 1 px', dx + 20, dy + 38);

    for (let i = 1; i <= 6; i++) {
      g.strokeStyle = '#111'; g.lineWidth = i;
      g.beginPath(); g.moveTo(dx + 20, dy + 62 + i * 13); g.lineTo(dx + 260, dy + 62 + i * 13); g.stroke();
      g.fillStyle = '#555'; g.font = '500 9px ui-monospace, monospace';
      g.fillText(i + ' px', dx + 270, dy + 65 + i * 13);
    }

    // 棋盘
    const chx = dx + 20, chy = dy + 170, chs = 8;
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
      if ((xx + yy) & 1) { g.fillStyle = '#111'; g.fillRect(chx + xx * chs, chy + yy * chs, chs, chs); }
    }

    // 红色圆标
    g.fillStyle = '#c80000';
    g.beginPath(); g.arc(dx + 610, dy + 125, 64, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.font = '700 56px ui-monospace, Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R', dx + 610, dy + 130);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';

    // 渐变条
    const grad = g.createLinearGradient(dx + 400, 0, dx + 760, 0);
    grad.addColorStop(0, '#102b4e'); grad.addColorStop(0.35, '#2e8b9f');
    grad.addColorStop(0.65, '#e4b15f'); grad.addColorStop(1, '#c33a3f');
    g.fillStyle = grad; g.fillRect(dx + 400, dy + 210, 360, 50);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(dx + 400, dy + 210, 360, 50);

    // 小字
    g.fillStyle = '#111';
    const smalls = ['12 px  BWR LAB 0123456789', '10 px  black / white / red', '8 px   no grey, only dots'];
    smalls.forEach((s, i) => {
      g.font = (12 - i * 2) + 'px ui-monospace, Consolas, monospace';
      g.fillText(s, dx + 400, dy + 298 + i * 18);
    });

    // 二维码式细节块
    const rnd = mulberry32(7);
    const qx = dx + 400, qy = dy + 345, qs = 22, cell = 5;
    for (let yy = 0; yy < qs; yy++) for (let xx = 0; xx < qs; xx++) {
      if (rnd() > 0.52) {
        g.fillStyle = '#111';
        g.fillRect(qx + xx * cell, qy + yy * cell, cell, cell);
      }
    }

    g.fillStyle = '#666'; g.font = '500 10px ui-monospace, monospace';
    g.fillText('BWR LAB · LOCAL TEST IMAGE · TARGET 400×300 · NO NETWORK', 40, 872);
    return c;
  }

  function drawPhoto() {
    const W = 1400, H = 1000, c = newCanvas(W, H), g = ctx2(c);
    const sky = g.createLinearGradient(0, 0, 0, 720);
    sky.addColorStop(0, '#1f4f7d'); sky.addColorStop(0.32, '#4f86ad');
    sky.addColorStop(0.58, '#9db6b8'); sky.addColorStop(0.75, '#e8b06f');
    sky.addColorStop(1, '#f6d6a8');
    g.fillStyle = sky; g.fillRect(0, 0, W, 760);

    const sg = g.createRadialGradient(985, 300, 10, 985, 300, 330);
    sg.addColorStop(0, 'rgba(255,246,210,.95)');
    sg.addColorStop(0.18, 'rgba(255,228,170,.55)');
    sg.addColorStop(0.55, 'rgba(255,180,120,.14)');
    sg.addColorStop(1, 'rgba(255,180,120,0)');
    g.fillStyle = sg; g.fillRect(600, 0, 800, 700);
    g.fillStyle = '#fff6d6';
    g.beginPath(); g.arc(985, 300, 48, 0, Math.PI * 2); g.fill();

    // 云
    const clouds = [[220, 170, 190, 28], [420, 240, 240, 22], [760, 150, 210, 24], [1120, 210, 260, 26]];
    for (const [x, y, rx, ry] of clouds) {
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.08)';
      g.beginPath(); g.ellipse(x + 30, y - 12, rx * 0.7, ry * 0.8, 0, 0, Math.PI * 2); g.fill();
    }

    // 远山
    g.fillStyle = '#6f7f9a';
    g.beginPath(); g.moveTo(0, 560); g.lineTo(140, 430); g.lineTo(300, 520);
    g.lineTo(450, 390); g.lineTo(620, 520); g.lineTo(800, 450); g.lineTo(980, 540);
    g.lineTo(1150, 430); g.lineTo(1400, 560); g.lineTo(1400, 760); g.lineTo(0, 760); g.closePath(); g.fill();

    g.fillStyle = '#48616a';
    g.beginPath(); g.moveTo(0, 640); g.lineTo(210, 500); g.lineTo(360, 610);
    g.lineTo(560, 470); g.lineTo(760, 620); g.lineTo(980, 510); g.lineTo(1180, 630);
    g.lineTo(1400, 520); g.lineTo(1400, 780); g.lineTo(0, 780); g.closePath(); g.fill();

    g.fillStyle = '#2e4a44';
    g.beginPath(); g.moveTo(0, 760); g.lineTo(0, 650); g.lineTo(160, 610);
    g.lineTo(340, 700); g.lineTo(520, 640); g.lineTo(720, 730); g.lineTo(900, 680);
    g.lineTo(1100, 740); g.lineTo(1400, 660); g.lineTo(1400, 800); g.lineTo(0, 800); g.closePath(); g.fill();

    // 湖面
    const water = g.createLinearGradient(0, 760, 0, H);
    water.addColorStop(0, '#3d6170'); water.addColorStop(0.55, '#234451'); water.addColorStop(1, '#122b36');
    g.fillStyle = water; g.fillRect(0, 760, W, H - 760);
    for (let i = 0; i < 70; i++) {
      const yy = 770 + i * 3.2;
      const ww = 20 + (i % 9) * 8;
      g.fillStyle = 'rgba(255,215,160,' + (0.10 - i * 0.0011) + ')';
      g.fillRect(985 - ww / 2 + Math.sin(i * 1.7) * 8, yy, ww, 1.5);
    }
    for (let i = 0; i < 26; i++) {
      const yy = 790 + i * 7;
      g.fillStyle = 'rgba(20,40,45,.28)';
      g.fillRect(0, yy, W, 2);
    }

    // 红帆船
    const bx = 930, by = 755;
    g.fillStyle = '#141619';
    g.beginPath(); g.moveTo(bx - 55, by); g.lineTo(bx + 55, by); g.lineTo(bx + 38, by + 18); g.lineTo(bx - 38, by + 18); g.closePath(); g.fill();
    g.strokeStyle = '#1a1c1f'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx, by - 150); g.stroke();

    const sail = g.createLinearGradient(bx, by - 150, bx + 70, by - 20);
    sail.addColorStop(0, '#e8554e'); sail.addColorStop(0.6, '#c0272d'); sail.addColorStop(1, '#7e171c');
    g.fillStyle = sail;
    g.beginPath(); g.moveTo(bx + 3, by - 148); g.lineTo(bx + 76, by - 38); g.lineTo(bx + 3, by - 26); g.closePath(); g.fill();
    g.fillStyle = '#f0e4c8';
    g.beginPath(); g.moveTo(bx - 3, by - 140); g.lineTo(bx - 58, by - 42); g.lineTo(bx - 3, by - 30); g.closePath(); g.fill();
    g.fillStyle = 'rgba(200,40,45,.30)';
    g.beginPath(); g.ellipse(bx, by + 30, 48, 8, 0, 0, Math.PI * 2); g.fill();

    // 前景树
    g.fillStyle = '#0d1b19';
    for (const [tx, th] of [[70, 220], [140, 270], [1220, 200], [1300, 260]]) {
      g.fillRect(tx - 3, 1000 - th, 6, th);
      for (let i = 0; i < 5; i++) {
        g.beginPath(); g.ellipse(tx, 1000 - th + 20 + i * 16, 50 - i * 6, 20, 0, 0, Math.PI * 2); g.fill();
      }
    }

    // 左下角红色小花
    const rnd = mulberry32(21);
    for (let i = 0; i < 24; i++) {
      const x = 30 + rnd() * 260, y = 900 + rnd() * 80;
      g.fillStyle = 'rgba(204,50,55,' + (0.35 + rnd() * 0.5) + ')';
      g.beginPath(); g.arc(x, y, 2 + rnd() * 3, 0, Math.PI * 2); g.fill();
    }

    grain(g, W, H, 7, 99);
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.26)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    return c;
  }

  function drawPortrait() {
    const W = 1000, H = 1200, c = newCanvas(W, H), g = ctx2(c);
    const bg = g.createRadialGradient(500, 330, 80, 500, 500, 850);
    bg.addColorStop(0, '#87947e'); bg.addColorStop(0.5, '#4d5a4e'); bg.addColorStop(1, '#232d29');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    const rnd = mulberry32(41);
    for (let i = 0; i < 18; i++) {
      const x = rnd() * W, y = 80 + rnd() * 700, r = 16 + rnd() * 70;
      g.fillStyle = 'rgba(230,220,180,' + (0.025 + rnd() * 0.05) + ')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    // 大衣
    g.fillStyle = '#1b2428';
    g.beginPath(); g.moveTo(0, H); g.lineTo(0, 960); g.bezierCurveTo(160, 860, 300, 880, 390, 950);
    g.lineTo(500, 1040); g.lineTo(610, 950); g.bezierCurveTo(700, 880, 840, 860, 1000, 960);
    g.lineTo(1000, H); g.closePath(); g.fill();

    // 脖子
    const neck = g.createLinearGradient(0, 830, 0, 1010);
    neck.addColorStop(0, '#c88f6d'); neck.addColorStop(1, '#9d6045');
    g.fillStyle = neck;
    g.beginPath(); g.moveTo(420, 820); g.lineTo(580, 820); g.lineTo(610, 1000);
    g.lineTo(390, 1000); g.closePath(); g.fill();

    // 脸
    const face = g.createRadialGradient(430, 430, 20, 500, 530, 300);
    face.addColorStop(0, '#f7d8bd'); face.addColorStop(0.48, '#e6b592');
    face.addColorStop(0.82, '#c98b68'); face.addColorStop(1, '#9f6045');
    g.fillStyle = face;
    g.beginPath(); g.ellipse(500, 520, 196, 246, 0, 0, Math.PI * 2); g.fill();

    // 耳朵
    for (const s of [-1, 1]) {
      g.fillStyle = '#d6a080';
      g.beginPath(); g.ellipse(500 + s * 196, 540, 34, 52, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(130,70,45,.35)';
      g.beginPath(); g.ellipse(500 + s * 198, 540, 14, 26, 0, 0, Math.PI * 2); g.fill();
    }

    // 头发
    g.fillStyle = '#2b1b17';
    g.beginPath(); g.ellipse(500, 400, 220, 180, 0, Math.PI, 0); g.fill();
    g.beginPath(); g.ellipse(290, 540, 55, 200, -0.08, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(710, 540, 55, 200, 0.08, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,235,210,.10)';
    g.beginPath(); g.ellipse(380, 330, 110, 40, -0.35, 0, Math.PI * 2); g.fill();

    // 眉毛
    g.strokeStyle = '#3a2219'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(365, 425); g.quadraticCurveTo(420, 400, 470, 425); g.stroke();
    g.beginPath(); g.moveTo(530, 425); g.quadraticCurveTo(580, 400, 635, 425); g.stroke();

    // 眼睛
    for (const s of [-1, 1]) {
      const ex = 500 + s * 82, ey = 475;
      g.fillStyle = '#fff9f0';
      g.beginPath(); g.ellipse(ex, ey, 46, 25, 0, 0, Math.PI * 2); g.fill();
      const iris = g.createRadialGradient(ex, ey, 3, ex, ey, 20);
      iris.addColorStop(0, '#7a4a2a'); iris.addColorStop(1, '#3a2115');
      g.fillStyle = iris;
      g.beginPath(); g.arc(ex, ey + 1, 19, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#120c0a';
      g.beginPath(); g.arc(ex, ey + 1, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.beginPath(); g.arc(ex - 6, ey - 7, 4, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3a2219'; g.lineWidth = 4;
      g.beginPath(); g.ellipse(ex, ey, 48, 27, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    }

    // 鼻子 / 嘴
    g.strokeStyle = 'rgba(120,66,45,.55)'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(500, 520); g.quadraticCurveTo(510, 590, 478, 600); g.stroke();
    g.fillStyle = 'rgba(120,55,40,.18)';
    g.beginPath(); g.ellipse(500, 590, 30, 16, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#a83c3f';
    g.beginPath(); g.moveTo(430, 654); g.quadraticCurveTo(500, 700, 570, 654);
    g.quadraticCurveTo(500, 672, 430, 654); g.closePath(); g.fill();
    g.fillStyle = 'rgba(70,20,22,.45)';
    g.beginPath(); g.moveTo(440, 657); g.quadraticCurveTo(500, 678, 560, 657);
    g.quadraticCurveTo(500, 666, 440, 657); g.closePath(); g.fill();
    g.fillStyle = 'rgba(220,120,110,.22)';
    g.beginPath(); g.ellipse(380, 590, 55, 30, 0.15, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(620, 590, 55, 30, -0.15, 0, Math.PI * 2); g.fill();

    // 红围巾
    const scarf = g.createLinearGradient(0, 820, 0, 1060);
    scarf.addColorStop(0, '#d24a4e'); scarf.addColorStop(0.55, '#a92a30'); scarf.addColorStop(1, '#781b22');
    g.fillStyle = scarf;
    g.beginPath(); g.moveTo(350, 845); g.bezierCurveTo(430, 900, 570, 900, 650, 845);
    g.bezierCurveTo(660, 930, 610, 990, 560, 1030); g.lineTo(500, 1000);
    g.lineTo(440, 1030); g.bezierCurveTo(390, 990, 340, 930, 350, 845); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(90,20,25,.45)'; g.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      g.beginPath(); g.moveTo(390 + i * 52, 875); g.quadraticCurveTo(420 + i * 52, 930, 430 + i * 52, 1000); g.stroke();
    }
    g.fillStyle = 'rgba(255,140,140,.18)';
    g.beginPath(); g.ellipse(470, 880, 70, 22, -0.2, 0, Math.PI * 2); g.fill();

    grain(g, W, H, 5, 88);
    const vg = g.createRadialGradient(500, 500, 240, 500, 600, 760);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.4)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    return c;
  }

  function drawLogo() {
    const W = 1000, H = 750, c = newCanvas(W, H), g = ctx2(c);
    g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#111'; g.lineWidth = 10; g.strokeRect(5, 5, W - 10, H - 10);

    g.fillStyle = '#c80000';
    g.beginPath(); g.arc(205, 265, 128, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.font = '700 150px ui-monospace, Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('B', 205, 272);

    g.fillStyle = '#111';
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.font = '800 190px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.fillText('BWR', 350, 320);
    g.font = '600 54px ui-monospace, Consolas, monospace';
    g.fillText('LAB', 360, 390);
    g.fillStyle = '#c80000'; g.fillRect(360, 420, 270, 10);
    g.fillStyle = '#111'; g.font = '500 22px ui-monospace, Consolas, monospace';
    g.fillText('THREE INKS / ONE SCREEN', 360, 466);

    g.strokeStyle = '#111'; g.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      g.beginPath(); g.moveTo(60, 540 + i * 22); g.lineTo(940, 540 + i * 22); g.stroke();
    }
    g.font = '500 12px ui-monospace, Consolas, monospace';
    g.fillStyle = '#333';
    g.fillText('1 px rules · sharp edges · red accent · small text', 60, 520);
    g.fillText('0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ', 60, 700);
    g.font = '400 8px ui-monospace, Consolas, monospace';
    g.fillText('8 px: the thinnest line that survives a 400×300 downsample', 60, 718);

    // 右下角红色徽章
    g.fillStyle = '#c80000';
    g.beginPath(); g.arc(860, 620, 58, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 42px ui-monospace, Consolas, monospace';
    g.fillText('R', 860, 624);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    return c;
  }

  function grain(g, w, h, amount, seed) {
    const id = g.getImageData(0, 0, w, h);
    const d = id.data, rnd = mulberry32(seed);
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amount;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    g.putImageData(id, 0, 0);
  }

  const SAMPLES = {
    chart: { label: '测试卡', make: drawChart },
    photo: { label: '风景', make: drawPhoto },
    portrait: { label: '人像', make: drawPortrait },
    logo: { label: '图标', make: drawLogo },
  };

  /* ---------------------------------------------------------------- 图像 */
  function activeImageLayer() {
    return state.activeLayer?.kind === 'image' ? state.activeLayer : null;
  }

  function recommendImage(layer) {
    const scale = Math.min(1, 384 / Math.max(layer.width, layer.height));
    const w = Math.max(1, Math.round(layer.width * scale));
    const h = Math.max(1, Math.round(layer.height * scale));
    const ctx = getWorkCanvas(w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.source, 0, 0, w, h);
    return B.recommend(ctx.getImageData(0, 0, w, h).data, w, h,
      state.w, state.h, layer.width / layer.height);
  }

  function recommendLayer(layer) {
    layer.recommendation = recommendImage(layer);
    if (!layer.manual) {
      layer.pre = { ...PRE_DEFAULTS, ...layer.recommendation.pre };
      layer.params = { ...EMPTY_PARAMS, ...layer.recommendation.params };
    }
    layer.params.dither = layer.dither || layer.recommendation.params.dither;
  }

  function updateRecommendationUI() {
    const layer = state.activeLayer;
    if (!layer) return;
    const title = layer.kind !== 'image' ? layer.name
      : layer.manual ? '手动转换' : '自动转换 · ' + IMAGE_KINDS[layer.recommendation.kind];
    const fit = layer.kind === 'image' ? (layer.fit === 'cover' ? '裁切铺满' : '完整放入') : '';
    $('recommendationTitle').textContent = title;
    $('recommendationText').textContent = fit;
    $('recommendationText').hidden = !fit;
    const mix = layer.cache?.mix;
    const summary = $('colorSummary');
    summary.hidden = !hasAccent() || !mix || layer.kind !== 'image';
    if (summary.hidden) return;
    const shares = mix.ratios.map((ratio, i) => RGB_CHANNELS[i] + ' ' + pct(ratio));
    shares.push('中性 ' + pct(mix.neutral));
    if (layer.mapping === 'auto' && mix.channel !== null) {
      shares.push(RGB_CHANNELS[mix.channel] + ' → ' + PANELS.modes[state.colorMode].inks[2] + '墨');
    }
    summary.textContent = shares.join(' · ');
  }

  function selectLayer(layer) {
    endStageInteraction();
    endHistDrag();
    state.activeLayer = layer;
    state.erasing = false;
    syncControls();
    drawStage();
    updateRecommendationUI();
  }

  function newLayer(kind, properties) {
    return { kind, visible: true, revision: 0, erasures: [], ...DEFAULT_TRANSFORM,
      pre: { ...PRE_DEFAULTS }, params: { ...EMPTY_PARAMS },
      mapping: kind === 'image' ? 'auto' : 'ink', accentColor: '#0080ff', ...properties };
  }

  function setImage(img, name, target = activeImageLayer()) {
    const focusReplace = document.activeElement === $('emptyOpen');
    let layer = target;
    if (layer) {
      if (typeof layer.source.close === 'function') layer.source.close();
    } else {
      layer = newLayer('image', { fit: state.layers.some(item => item.kind === 'image') ? 'contain' : 'cover' });
      state.layers.push(layer);
    }
    layer.source = img;
    layer.name = name || '未命名图片';
    layer.width = img.naturalWidth || img.width;
    layer.height = img.naturalHeight || img.height;
    layer.erasures = [];
    layer.revision++;
    recommendLayer(layer);
    if (!target || target === state.activeLayer) selectLayer(layer);
    syncControls();
    renderLayerList();
    if (state.autoFit) fitView(false);
    rebuildSource();
    if (focusReplace) $('openBtn').focus({ preventScroll: true });
    scheduleFit();
  }

  function addInkLayer() {
    const number = ++inkCount;
    const layer = newLayer('ink', {
      name: number === 1 ? '手写' : '手写 ' + number,
      width: state.w, height: state.h, strokes: [],
    });
    state.layers.push(layer);
    return layer;
  }

  function addTextLayer() {
    const number = ++textCount;
    const layer = newLayer('text', {
      name: number === 1 ? '文字' : '文字 ' + number,
      width: state.w, height: state.h, text: '', ink: '#000000',
      fontSize: Math.max(4, Math.round(Math.min(state.w, state.h) * 0.1)),
    });
    state.layers.push(layer);
    selectLayer(layer);
    renderLayerList();
    setView('result');
    if (state.split) setSplit(false);
    if (state.autoFit) fitView(false);
    rebuildSource();
    $('textBody').focus();
  }

  function chooseFile(add = false) {
    fileTarget = add ? null : activeImageLayer();
    $('fileInput').click();
  }

  function loadSample(kind) {
    imageRequest++;
    const s = SAMPLES[kind] || SAMPLES.chart;
    setImage(s.make(), '示例 · ' + s.label);
    return Promise.resolve();
  }

  async function loadFile(file, target = activeImageLayer()) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      toast('这不是图片文件', true);
      return;
    }
    const request = ++imageRequest;
    let image;
    try {
      if (window.createImageBitmap) {
        try { image = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) { image = await createImageBitmap(file); }
      } else {
        const url = URL.createObjectURL(file);
        try {
          image = new Image();
          image.src = url;
          await image.decode();
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch (e) {
      if (request === imageRequest) toast('图片解码失败：' + e.message, true);
      return;
    }
    if (request !== imageRequest || (target && !state.layers.includes(target))) {
      if (typeof image.close === 'function') image.close();
      return;
    }
    setImage(image, file.name || '粘贴的图片', target);
  }

  function updateSourceUI() {
    const thumb = $('srcThumb');
    const g = thumb.getContext('2d');
    g.clearRect(0, 0, thumb.width, thumb.height);
    g.fillStyle = '#0a0e14'; g.fillRect(0, 0, thumb.width, thumb.height);
    const image = activeImageLayer();
    $('emptyOpen').hidden = state.layers.length > 0;
    $('imageDetails').hidden = !state.layers.length;
    $('openBtn').textContent = image ? '替换图片' : '添加图片';
    if (!image) {
      $('srcName').textContent = state.activeLayer?.name || '尚未载入';
      $('srcMeta').textContent = state.activeLayer
        ? LAYER_KINDS[state.activeLayer.kind] + '图层' : '拖入图片或点击预览区';
      return;
    }
    const { width: iw, height: ih } = image;
    const s = Math.max(thumb.width / iw, thumb.height / ih);
    const dw = iw * s, dh = ih * s;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(image.source, (thumb.width - dw) / 2, (thumb.height - dh) / 2, dw, dh);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, thumb.width - 1, thumb.height - 1);
    $('srcName').textContent = image.name;
    const ss = (state.w * state.h <= 250000) ? 2 : 1;
    $('srcMeta').textContent = iw + '×' + ih + ' → ' + state.w + '×' + state.h + ' · ' + ss + '× 采样';
  }

  function getWorkCanvas(w, h) {
    if (!workCanvas) {
      workCanvas = newCanvas(w, h);
      workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (workCanvas.width !== w || workCanvas.height !== h) {
      workCanvas.width = w; workCanvas.height = h;
    }
    return workCtx;
  }

  function layerGeometry(layer) {
    const { w, h } = state;
    const radians = layer.angle * Math.PI / 180;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    const c = Math.abs(cos), s = Math.abs(sin);
    const iw = layer.width, ih = layer.height;
    let base;
    if (layer.kind !== 'image') base = Math.min(w / iw, h / ih);
    else if (layer.fit === 'cover') base = Math.max((w * c + h * s) / iw, (w * s + h * c) / ih);
    else base = Math.min(w / (iw * c + ih * s), h / (iw * s + ih * c));
    return { x: w * (0.5 + layer.x), y: h * (0.5 + layer.y), radians, cos, sin,
      scale: base * layer.zoom / 100 };
  }

  function drawStrokes(ctx, strokes) {
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      ctx.globalCompositeOperation = stroke.ink ? 'source-over' : 'destination-out';
      ctx.strokeStyle = ctx.fillStyle = stroke.ink || '#000';
      ctx.lineWidth = stroke.width;
      const start = stroke.points[0];
      ctx.beginPath();
      if (stroke.points.length === 1) {
        ctx.arc(start.x, start.y, stroke.width / 2, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < stroke.points.length; i++) {
          const point = stroke.points[i];
          ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      }
    }
  }

  function drawText(ctx, layer, color) {
    const lines = layer.text.split('\n');
    const lineHeight = layer.fontSize * 1.25;
    ctx.font = `600 ${layer.fontSize}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, (i - (lines.length - 1) / 2) * lineHeight);
    }
  }

  function layerRaster(layer) {
    const { w, h, colorMode } = state;
    const key = [w, h, colorMode, layer.revision, layer.x, layer.y, layer.angle, layer.zoom, layer.fit].join('/');
    if (layer.cache?.key === key) return layer.cache;
    const canvas = layer.cache?.canvas || newCanvas(w, h);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const ss = layer.kind === 'image' && w * h <= 250000 ? 2 : 1;
    if (ss === 2 && !supersampleCanvas) supersampleCanvas = newCanvas(w * ss, h * ss);
    const raster = ss === 1 ? canvas : supersampleCanvas;
    if (raster.width !== w * ss || raster.height !== h * ss) {
      raster.width = w * ss; raster.height = h * ss;
    }
    const ctx = ctx2(raster);
    ctx.clearRect(0, 0, raster.width, raster.height);
    const geometry = layerGeometry(layer);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(ss, ss);
    ctx.translate(geometry.x, geometry.y);
    ctx.rotate(geometry.radians);
    ctx.scale(geometry.scale, geometry.scale);
    if (layer.kind === 'ink') {
      const operations = [...layer.strokes, ...layer.erasures].sort((a, b) => a.order - b.order);
      drawStrokes(ctx, operations);
    } else {
      if (layer.kind === 'text') drawText(ctx, layer, layer.ink);
      else ctx.drawImage(layer.source, -layer.width / 2, -layer.height / 2);
      drawStrokes(ctx, layer.erasures);
    }
    ctx.restore();
    if (ss === 2) {
      const output = ctx2(canvas);
      output.clearRect(0, 0, w, h);
      output.imageSmoothingQuality = 'high';
      output.drawImage(raster, 0, 0, w, h);
    }
    layer.cache = { canvas, key };
    return layer.cache;
  }

  function drawArtwork(ctx) {
    for (const layer of state.layers) {
      if (layer.visible) ctx.drawImage(layerRaster(layer).canvas, 0, 0);
    }
  }

  function convertLayer(layer) {
    const { w, h, colorMode, palette } = state;
    const cache = layerRaster(layer);
    const key = JSON.stringify([layer.pre, layer.params, layer.mapping, layer.accentColor]);
    if (cache.convertKey === key) return cache;
    const rgba = cache.rgba ||= ctx2(cache.canvas).getImageData(0, 0, w, h).data;
    const params = { ...layer.params };
    let accentChannel, accentColor;
    if (hasAccent()) {
      if (layer.mapping === 'auto') {
        cache.mix ||= B.colorMix(rgba);
        accentChannel = cache.mix.channel;
        params.mode = 'dominant';
      } else if (layer.mapping === 'color') {
        accentColor = B.hexToRgb(layer.accentColor);
        params.mode = 'dominant';
      } else if (RGB_CHANNELS.includes(layer.mapping)) {
        accentChannel = RGB_CHANNELS.indexOf(layer.mapping);
        params.mode = 'dominant';
      } else if (layer.mapping === 'natural') {
        params.mode = 'nearest';
        params.warmOnly = colorMode === 'bwr' && params.warmOnly;
      } else if (layer.mapping === 'mono') {
        params.mode = 'mono';
      }
      if (layer.kind === 'image') cache.mix ||= B.colorMix(rgba);
    }
    if (layer.mapping === 'ink') Object.assign(params, { mode: 'nearest', warmOnly: false });
    if (layer.mapping === 'mono') params.mode = 'mono';
    const pre = layer.mapping === 'ink' ? {} : layer.pre;
    cache.processed = B.preprocess(rgba, w, h, { ...pre, preserveAlpha: true });
    cache.codes = B.quantize({
      w, h, rgb: cache.processed.rgb, palette, params, colorMode, sourceRGBA: rgba,
      accentChannel, accentColor,
    });
    cache.histogram = null;
    cache.convertKey = key;
    return cache;
  }

  function rebuildSource() {
    cancelAnimationFrame(rafSource);
    rafSource = 0;
    clearTimeout(editTimer);
    editTimer = 0;
    reprocess();
  }

  /* ---------------------------------------------------------------- 转换 */
  function reprocess() {
    cancelAnimationFrame(rafProcess);
    rafProcess = 0;
    if (!state.layers.length) {
      state.sourceData = state.processed = state.codes = state.metrics = state.pack = null;
      state.resultCanvas = state.sourceCanvas = state.bwCanvas = state.redCanvas = null;
      state.hover = null;
      lastHoverKey = '';
      updateSourceUI();
      updateEmptyOutputs();
      updateInspector();
      drawHistogram();
      drawStage();
      window.dispatchEvent(new Event('bwr:render'));
      return;
    }

    const t0 = performance.now();
    const { w, h } = state;
    const codes = new Uint8Array(w * h).fill(B.WHITE);
    const ctx = getWorkCanvas(w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      const converted = convertLayer(layer);
      ctx.drawImage(converted.canvas, 0, 0);
      for (let i = 0; i < codes.length; i++) {
        if (converted.rgba[i * 4 + 3] >= 128) codes[i] = converted.codes[i];
      }
    }
    state.codes = codes;
    state.sourceData = ctx.getImageData(0, 0, w, h);
    state.processed = B.preprocess(state.sourceData.data, w, h);

    const resultRGBA = B.codesToRGBA(codes, state.palette);
    state.resultCanvas = setCanvasRGBA(state.resultCanvas, w, h, resultRGBA);
    state.sourceCanvas = setCanvasRGBA(state.sourceCanvas, w, h, state.sourceData.data);
    state.bwCanvas = PANELS.modes[state.colorMode].bits === 1 ? layerCanvas(state.bwCanvas, 'bw', codes, w, h) : null;
    state.redCanvas = hasAccent() ? layerCanvas(state.redCanvas, 'red', codes, w, h) : null;
    state.metrics = state.debugOpen ? B.analyze(codes, state.processed.rgb, w, h, state.palette) : null;
    updatePack();
    state.renderMs = performance.now() - t0;

    updateStats();
    updateThumbs();
    updateExportInfo();
    updateDitherUI();
    drawHistogram();
    if (state.debugOpen) updateInspector();
    drawStage();
    updateRecommendationUI();
    window.dispatchEvent(new Event('bwr:render'));
  }

  function layerCanvas(canvas, kind, codes, w, h) {
    if (!canvas) canvas = newCanvas(w, h);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const c = canvas.getContext('2d');
    const img = c.createImageData(w, h);
    const d = img.data;
    const red = state.palette.rgb[2];
    for (let i = 0; i < codes.length; i++) {
      let r = 255, g = 255, b = 255;
      if (kind === 'bw') {
        if (codes[i] === B.BLACK) { r = 16; g = 16; b = 16; }
      } else if (codes[i] === B.RED) {
        r = red[0]; g = red[1]; b = red[2];
      }
      const o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    return canvas;
  }

  function updatePack() {
    state.pack = B.pack(state.codes, state.w, state.h, {
      colorMode: state.colorMode, encoding: state.encoding,
      invertBW: PANELS.modes[state.colorMode].bits === 1 && state.invertBW, invertRed: state.invertRed,
    });
  }

  function repack() {
    if (!state.codes) return;
    updatePack();
    updateExportInfo();
    drawStage();
  }

  /* ---------------------------------------------------------------- stage */
  function stageRect() { return $('stage').getBoundingClientRect(); }

  function stageLayout() {
    const rect = stageRect();
    const zoom = state.zoom;
    const iw = state.w * zoom, ih = state.h * zoom;
    let ox = (rect.width - iw) / 2 + state.panX;
    let oy = (rect.height - ih) / 2 + state.panY;
    if (zoom >= 1) { ox = Math.round(ox); oy = Math.round(oy); }
    return { rect: rect, zoom: zoom, iw: iw, ih: ih, ox: ox, oy: oy };
  }

  function fitView(redraw) {
    const rect = stageRect();
    if (!rect.width || !rect.height) return;
    const pad = Math.min(64, Math.max(24, Math.min(rect.width, rect.height) * 0.09));
    const inlinePad = matchMedia('(max-width: 600px)').matches ? 0 : pad;
    const z = Math.min((rect.width - inlinePad) / state.w, (rect.height - pad) / state.h);
    state.zoom = clamp(z, 0.04, 32);
    state.panX = 0; state.panY = 0;
    updateZoomUI();
    if (redraw !== false) drawStage();
  }

  function updateZoomUI() { $('zoomOut').textContent = Math.round(state.zoom * 100) + '%'; }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (state.autoFit && state.layers.length) fitView();
    }, 250);
  }

  function updateSplitUI(l) {
    const split = state.debugOpen && state.split && !!state.resultCanvas && !isEditingArtwork();
    $('splitTagL').hidden = !split;
    $('splitTagR').hidden = !split;
    $('splitHandle').hidden = !split;
    if (!split) return;
    const x = clamp(l.ox + l.iw * state.splitFrac, l.rect.width > 0 ? 0 : 0, l.rect.width);
    $('splitHandle').style.left = x + 'px';
  }

  function drawStage() {
    const rect = stageRect();
    const canvas = $('view');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const chh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);
    const l = stageLayout();
    if (!state.resultCanvas) { updateSplitUI(l); return; }

    g.save();
    g.shadowColor = 'rgba(32,37,57,.23)';
    g.shadowBlur = 28; g.shadowOffsetY = 12;
    g.fillStyle = '#f4f1ea';
    g.fillRect(l.ox, l.oy, l.iw, l.ih);
    g.restore();

    g.imageSmoothingEnabled = !state.debugOpen || state.smooth ? l.zoom < 4 : l.zoom < 0.999;
    g.imageSmoothingQuality = 'high';

    const editing = isEditingArtwork();
    const split = state.debugOpen && state.split && !editing;
    if (editing) {
      g.save();
      g.beginPath();
      g.rect(l.ox, l.oy, l.iw, l.ih);
      g.clip();
      g.translate(l.ox, l.oy);
      g.scale(l.zoom, l.zoom);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, state.w, state.h);
      drawArtwork(g);
      g.restore();
    } else if (split) {
      g.drawImage(state.sourceCanvas, l.ox, l.oy, l.iw, l.ih);
      const splitX = l.ox + l.iw * state.splitFrac;
      g.save();
      g.beginPath();
      g.rect(splitX, l.oy, Math.max(0, l.iw * (1 - state.splitFrac)), l.ih);
      g.clip();
      g.drawImage(state.resultCanvas, l.ox, l.oy, l.iw, l.ih);
      g.restore();
    } else {
      let src = state.resultCanvas;
      if (state.debugOpen) {
        if (state.spaceSource || state.view === 'source') src = state.sourceCanvas;
        else if (state.view === 'bw') src = state.bwCanvas;
        else if (state.view === 'red' && state.redCanvas) src = state.redCanvas;
      }
      g.drawImage(src, l.ox, l.oy, l.iw, l.ih);
    }

    g.strokeStyle = 'rgba(255,255,255,.20)';
    g.lineWidth = 1;
    g.strokeRect(l.ox + 0.5, l.oy + 0.5, l.iw - 1, l.ih - 1);

    if (state.debugOpen && $('gridChk').checked && l.zoom >= 5) {
      g.save();
      g.beginPath();
      g.rect(l.ox, l.oy, l.iw, l.ih);
      g.clip();
      g.strokeStyle = 'rgba(255,255,255,.11)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= state.w; x++) {
        const px = Math.round(l.ox + x * l.zoom) + 0.5;
        if (px < -2 || px > rect.width + 2) continue;
        g.moveTo(px, Math.max(l.oy, 0));
        g.lineTo(px, Math.min(l.oy + l.ih, rect.height));
      }
      for (let y = 0; y <= state.h; y++) {
        const py = Math.round(l.oy + y * l.zoom) + 0.5;
        if (py < -2 || py > rect.height + 2) continue;
        g.moveTo(Math.max(l.ox, 0), py);
        g.lineTo(Math.min(l.ox + l.iw, rect.width), py);
      }
      g.stroke();
      g.restore();
    }

    if (state.debugOpen && state.hover && !split && !editing && l.zoom >= 4) {
      g.strokeStyle = '#ff5b61';
      g.lineWidth = 1.5;
      g.strokeRect(l.ox + state.hover.x * l.zoom + 0.5, l.oy + state.hover.y * l.zoom + 0.5, l.zoom, l.zoom);
    }

    updateSplitUI(l);
    updateStatus();
  }

  function updateStatus() {
    if (!state.pack) {
      $('statusLeft').textContent = state.layers.length ? '准备中…' : '等待图片';
      $('statusRight').textContent = '';
      return;
    }
    const chunks = Math.ceil(state.pack.bytes / 120);
    $('statusLeft').textContent =
      state.w + '×' + state.h + ' · ' + state.pack.bytes + ' B · ' + chunks + ' 块 @120 B · ' +
      $('planeBadge').textContent + ' · ' + state.pack.stride + ' B/行';
    $('statusRight').textContent =
      state.renderMs.toFixed(1) + ' ms · ' + viewName(state.view) + ' · ' + Math.round(state.zoom * 100) + '%';
  }

  function viewName(v) {
    return { result: '合成', source: '预处理后', bw: 'BW 层', red: 'RED 层' }[v] || v;
  }

  /* ---------------------------------------------------------------- 统计 */
  function updateStats() {
    const m = state.metrics;
    if (!m) return;
    const { colors, inks } = PANELS.modes[state.colorMode];
    $('covBar').replaceChildren();
    $('covLabels').replaceChildren();
    for (let i = 0; i < colors.length; i++) {
      const part = document.createElement('i');
      part.style.background = colors[i];
      part.style.width = pct(m.coverage[i]);
      $('covBar').append(part);
      const label = document.createElement('span');
      label.textContent = inks[i] + ' ' + pct(m.coverage[i], 0);
      $('covLabels').append(label);
    }
    $('mDE').textContent = m.deltaE.toFixed(2);
    $('mTrans').textContent = (m.transitions * 100).toFixed(1) + '%';
    $('mRedComp').textContent = String(m.redComponents);
    $('mRedCompSub').textContent = '最大 ' + m.largestRed + ' px';
    $('mIsolated').textContent = String(m.isolatedRed);
    $('mSrcRed').textContent = (m.sourceRedRatio * 100).toFixed(1) + '%';
    $('mPixels').textContent = state.w + '×' + state.h;
    $('mBytes').textContent = state.pack.bytes + ' B · ' + Math.ceil(state.pack.bytes / 120) + ' 块';
    $('renderTime').textContent = state.renderMs.toFixed(0) + ' ms';


  }

  function updateThumbs() {
    if (!state.resultCanvas) return;
    drawThumb($('thumbResult'), state.resultCanvas);
    if (state.bwCanvas) drawThumb($('thumbBW'), state.bwCanvas);
    if (state.redCanvas) drawThumb($('thumbRED'), state.redCanvas);
  }

  function drawThumb(canvas, src) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    const s = Math.min(W / state.w, H / state.h);
    const dw = state.w * s, dh = state.h * s;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1;
    g.strokeRect((W - dw) / 2 + 0.5, (H - dh) / 2 + 0.5, dw - 1, dh - 1);
  }

  function updateExportInfo() {
    if (!state.pack) return;
    const p = state.pack;
    $('sizeBadge').textContent = state.w + '×' + state.h;
    $('bwInfo').textContent = p.planeBytes + ' B';
    $('redInfo').textContent = p.plane1 ? p.planeBytes + ' B' : '—';
    $('allInfo').textContent = p.bytes + ' B';
    $('crc0').textContent = '0x' + hex4(p.crc0) + ' (' + p.crc0 + ')';
    $('crc1').textContent = p.crc1 === null ? '—' : '0x' + hex4(p.crc1) + ' (' + p.crc1 + ')';
    $('crcAll').textContent = '0x' + hex4(p.crcAll) + ' (' + p.crcAll + ')';
    $('byteCount').textContent = p.bytes + ' B';
    $('planeBadge').textContent = !p.plane1 ? PANELS.modes[state.colorMode].label :
      state.encoding === 'gateway' ? '网关双平面' : '驱动双平面';
    updateStatus();
  }

  function updateEmptyOutputs() {
    $('covBar').replaceChildren();
    $('covLabels').replaceChildren();
    ['mDE', 'mTrans', 'mRedComp', 'mIsolated', 'mSrcRed'].forEach((id) => { $(id).textContent = '—'; });
    $('mRedCompSub').textContent = '最大 —';
    $('mPixels').textContent = state.w + '×' + state.h;
    $('mBytes').textContent = '—';
    $('renderTime').textContent = '—';
    $('sizeBadge').textContent = state.w + '×' + state.h;
    $('bwInfo').textContent = $('redInfo').textContent = $('allInfo').textContent = '—';
    ['crc0', 'crc1', 'crcAll', 'byteCount'].forEach((id) => { $(id).textContent = '—'; });
    ['thumbResult', 'thumbBW', 'thumbRED'].forEach((id) => {
      const c = $(id), g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = '#0a0e14'; g.fillRect(0, 0, c.width, c.height);
    });
    $('statusLeft').textContent = '等待图片';
    $('statusRight').textContent = '';
  }

  /* ---------------------------------------------------------------- 直方图 */
  function drawHistogram() {
    const cv = $('hist');
    const width = cv.getBoundingClientRect().width;
    if (!width) return;
    const height = 84;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#171a21';
    ctx.fillRect(0, 0, width, height);

    const cache = activeImageLayer()?.cache;
    if (!cache?.processed) return;
    if (!cache.histogram) {
      const bins = Array.from({ length: 4 }, () => new Uint32Array(256));
      const { lum, rgb } = cache.processed;
      for (let i = 0; i < lum.length; i++) {
        if (cache.rgba[i * 4 + 3] < 128) continue;
        for (let c = 0; c < 3; c++) bins[c][Math.round(rgb[i * 3 + c])]++;
        bins[3][Math.round(lum[i])]++;
      }
      cache.histogram = bins;
    }
    const colors = ['#ff6464', '#55e08c', '#62a3ff', '#e3e8ef'];
    cache.histogram.forEach((bins, channel) => {
      const max = Math.max(1, ...bins);
      ctx.strokeStyle = colors[channel];
      ctx.beginPath();
      bins.forEach((count, i) => {
        const x = i * width / 255;
        const y = height - 1 - Math.sqrt(count / max) * (height - 8);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    const x = state.params.threshold * width / 255;
    ctx.strokeStyle = '#ffe084';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  function moveHistogramThreshold(e) {
    if (histDrag === null || !activeImageLayer()) return;
    const box = $('hist').getBoundingClientRect();
    state.params.threshold = clamp(Math.round((e.clientX - box.left) * 255 / box.width), 1, 254);
    syncAdjustmentUI();
    scheduleProcess();
  }

  function endHistDrag() { histDrag = null; }

  /* ---------------------------------------------------------------- 交互 */
  function scheduleProcess(manual = true) {
    if (manual && state.activeLayer) state.activeLayer.manual = true;
    if (!rafProcess && !rafSource && !isEditingArtwork()) rafProcess = requestAnimationFrame(reprocess);
  }

  function isEditingArtwork() {
    return Boolean(stageDrag?.changed || touchTransform?.changed || editTimer);
  }

  function scheduleSource(preview = false) {
    cancelAnimationFrame(rafProcess);
    rafProcess = 0;
    clearTimeout(editTimer);
    editTimer = preview ? setTimeout(() => {
      editTimer = 0;
      if (!isEditingArtwork()) rebuildSource();
    }, 135) : 0;
    if (!rafSource) {
      rafSource = requestAnimationFrame(() => {
        rafSource = 0;
        if (isEditingArtwork()) drawStage();
        else rebuildSource();
      });
    }
  }

  function finishPendingRender() {
    if (rafSource || isEditingArtwork()) rebuildSource();
    else if (rafProcess) reprocess();
  }

  function setDebug(open) {
    state.debugOpen = open;
    state.spaceSource = false;
    state.hover = null;
    lastHoverKey = '';
    updateInspector();
    state.autoFit = true;
    $('app').classList.toggle('is-debug', open);
    document.body.classList.toggle('debug-mode', open);
    const button = $('debugBtn');
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? '退出手动模式' : '手动模式';
    for (const id of ['debugSettings', 'debugDetails', 'debugToolbar', 'debugStatus']) {
      $(id).hidden = !open;
    }
    fitView(false);
    reprocess();
  }

  function restoreAutomatic() {
    const layer = state.activeLayer;
    if (!layer) return;
    layer.manual = false;
    layer.preset = '';
    layer.dither = null;
    layer.mapping = layer.kind === 'image' ? 'auto' : 'ink';
    if (layer.kind === 'image') recommendLayer(layer);
    else {
      layer.pre = { ...PRE_DEFAULTS };
      layer.params = { ...EMPTY_PARAMS };
    }
    syncControls();
    reprocess();
  }

  function syncFramingUI() {
    const layer = state.activeLayer || DEFAULT_TRANSFORM;
    const zoom = Math.round(layer.zoom);
    $('imgZoom').value = String(zoom);
    $('imgZoomOut').textContent = zoom + '%';
    $('angle').value = String(layer.angle);
    $('angleOut').textContent = layer.angle + '°';
    $('fitSelect').value = state.activeLayer?.fit || 'contain';
  }

  function syncLayerUI() {
    const layer = state.activeLayer;
    const index = state.layers.indexOf(layer);
    state.drawing = !!(layer?.visible && layer.kind === 'ink' && !state.erasing);
    $('layerTransform').hidden = !layer;
    $('fitField').hidden = layer?.kind !== 'image';
    $('layerConversion').hidden = !layer;
    $('eraseBtn').hidden = !layer?.visible;
    $('eraseBtn').setAttribute('aria-pressed', String(state.erasing));
    $('eraseBtn').textContent = state.erasing ? '完成擦除' : '擦除';
    $('drawTools').hidden = !state.drawing;
    $('eraseTools').hidden = !state.erasing;
    $('undoStroke').disabled = !layer?.strokes?.length;
    $('undoErase').disabled = !layer?.erasures.length;
    const text = layer?.kind === 'text' ? layer : null;
    $('textTools').hidden = !text;
    if (text) {
      if ($('textBody').value !== text.text) $('textBody').value = text.text;
      $('textSize').value = String(text.fontSize);
      const colors = PANELS.modes[state.colorMode].colors;
      const rgb = B.hexToRgb(text.ink);
      const mapped = B.quantize({ w: 1, h: 1, rgb, palette: state.palette, colorMode: state.colorMode,
        params: { dither: 'none', warmOnly: false } })[0];
      $('textColor').value = colors[mapped];
    }

    const multiple = state.layers.length > 1;
    $('layerPanel').hidden = !multiple;
    const remove = $('removeLayer');
    const actions = $(multiple ? 'layerActions' : 'editorActions');
    if (remove.parentElement !== actions) actions.append(remove);
    remove.textContent = multiple ? '删除' : '删除图层';
    remove.hidden = !layer;
    $('layerUp').disabled = index < 0 || index === state.layers.length - 1;
    $('layerDown').disabled = index < 1;
    $('layerVisible').textContent = layer?.visible ? '隐藏' : '显示';
    $('layerList').querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.layer) === index));
    });
    $('view').classList.toggle('editable', !!layer?.visible);
    $('view').classList.toggle('drawing', state.drawing || state.erasing);
    const touch = matchMedia('(any-pointer: coarse)').matches;
    const hint = touch ? '双指缩放 · 三指旋转' : '滚轮缩放';
    const action = state.erasing ? '拖动擦除' : state.drawing ? '单指手写' : '拖动移动图层';
    $('view').title = layer?.visible ? action + ' · ' + hint : '';
    if (state.drawing && state.view !== 'result') setView('result');
    syncFramingUI();
  }

  function renderLayerList() {
    const entries = document.createDocumentFragment();
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i];
      const item = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('span');
      const kind = document.createElement('span');
      button.className = 'layer-select';
      button.type = 'button';
      button.dataset.layer = i;
      button.setAttribute('aria-pressed', String(layer === state.activeLayer));
      name.textContent = layer.name;
      button.title = layer.name;
      kind.className = 'layer-kind';
      kind.textContent = layer.visible ? LAYER_KINDS[layer.kind] : '已隐藏';
      button.append(name, kind);
      item.append(button);
      entries.append(item);
    }
    $('layerList').replaceChildren(entries);
  }

  function updateLayerStack() {
    syncControls();
    renderLayerList();
    rebuildSource();
  }

  function moveLayer(offset) {
    const index = state.layers.indexOf(state.activeLayer);
    const to = index + offset;
    if (index < 0 || to < 0 || to >= state.layers.length) return;
    [state.layers[to], state.layers[index]] = [state.layers[index], state.layers[to]];
    updateLayerStack();
  }

  function toggleLayerVisibility() {
    const layer = state.activeLayer;
    if (!layer) return;
    endStageInteraction();
    layer.visible = !layer.visible;
    state.erasing = false;
    updateLayerStack();
  }

  function removeLayer() {
    const layer = state.activeLayer;
    const index = state.layers.indexOf(layer);
    if (index < 0) return;
    endStageInteraction();
    state.layers.splice(index, 1);
    layer.source?.close?.();
    selectLayer(state.layers[Math.max(0, index - 1)] || null);
    updateLayerStack();
    (state.activeLayer ? $('angle') : $('emptyOpen')).focus({ preventScroll: true });
  }

  function syncColorUI() {
    const mode = PANELS.modes[state.colorMode];
    $('colorMode').value = state.colorMode;
    document.querySelectorAll('[data-bwr]').forEach((item) => { item.hidden = !hasAccent(); });
    document.querySelectorAll('[data-accent-name]').forEach((item) => {
      item.textContent = hasAccent() ? mode.inks[2] + '墨' : '';
    });
    $('plane0Label').textContent = mode.bits === 1 ? 'BW 平面' : '位图';
    for (const item of document.querySelectorAll('[data-accent-plane]')) {
      item.textContent = (mode.inks[2] || '') + '墨平面';
    }
    if (!hasAccent() && state.view === 'red') state.view = 'result';
    $('expBin').textContent = hasAccent() ? '双平面 BIN' : '位图 BIN';
    $('invBW').closest('label').hidden = mode.bits !== 1;
    $('expBW').hidden = mode.bits !== 1;
    document.querySelectorAll('[data-view="bw"]').forEach(item => { item.hidden = mode.bits !== 1; });
    if (mode.bits !== 1 && state.view === 'bw') state.view = 'result';

    for (const id of ['textColor', 'brushColor']) {
      const select = $(id);
      const previous = select.value;
      if (select.dataset.mode !== state.colorMode) {
        select.replaceChildren(...mode.colors.map((color, index) => new Option(mode.inks[index], color)));
        select.dataset.mode = state.colorMode;
        if (mode.colors.includes(previous)) select.value = previous;
      }
    }
  }

  function syncAdjustmentUI() {
    for (const [id, value] of [['bri', state.pre.brightness], ['con', state.pre.contrast],
      ['threshold', state.params.threshold]]) {
      $(id).value = value;
      $(id + 'Out').textContent = value;
    }
  }

  function syncControls() {
    $('encoding').value = state.encoding;
    $('invBW').checked = !!state.invertBW;
    $('invRed').checked = !!state.invertRed;
    $('imageAdjustments').hidden = !activeImageLayer()?.visible;
    $('autoBtn').disabled = !state.activeLayer;
    const layer = state.activeLayer;
    const mapping = $('layerMapping');
    const accent = hasAccent();
    $('mappingField').hidden = state.colorMode === 'bw';
    $('mapColorField').hidden = !accent || layer?.mapping !== 'color';
    for (const option of mapping.options) {
      option.hidden = (option.value === 'ink' && layer?.kind === 'image') ||
        (!accent && ['auto', 'R', 'G', 'B', 'color'].includes(option.value));
    }
    mapping.value = Array.from(mapping.options).some(option => !option.hidden && option.value === layer?.mapping)
      ? layer.mapping : 'natural';
    $('mapColor').value = layer?.accentColor || '#0080ff';
    $('presetField').hidden = layer?.kind !== 'image';
    $('presetSelect').value = layer?.preset || '';
    syncAdjustmentUI();
    syncColorUI();
    syncLayerUI();
    updateDitherUI();
    updateSourceUI();
    updateViewUI();
    updateZoomUI();
    drawHistogram();
  }

  function updateDitherUI() {
    $('quickDither').value = state.activeLayer?.dither || (activeImageLayer() ? 'auto' : 'none');
  }

  function updateViewUI() {
    document.querySelectorAll('.view-tab').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.thumb').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === state.view);
    });
  }

  function updateSmoothUI() {
    const b = $('smoothBtn');
    b.classList.toggle('primary', state.smooth);
    b.setAttribute('aria-pressed', state.smooth ? 'true' : 'false');
    b.textContent = state.smooth ? '柔化' : '像素';
    b.title = state.smooth ? '按观看距离模拟；关掉可以看真实点阵' : '正在显示真实点阵；点一下恢复柔化';
  }

  function setView(v) {
    if (!['result', 'source', 'bw', 'red'].includes(v) ||
        (v === 'red' && !hasAccent()) || (v === 'bw' && PANELS.modes[state.colorMode].bits !== 1)) return;
    state.view = v;
    updateViewUI();
    drawStage();
  }

  function setSplit(on) {
    state.split = !!on;
    $('splitBtn').setAttribute('aria-pressed', state.split ? 'true' : 'false');
    $('splitBtn').classList.toggle('primary', state.split);
    drawStage();
  }

  function zoomBy(f) {
    state.autoFit = false;
    const old = state.zoom;
    const z = clamp(old * f, 0.04, 32);
    state.panX *= z / old;
    state.panY *= z / old;
    state.zoom = z;
    updateZoomUI();
    drawStage();
  }

  function artworkPoint(e, l) {
    return {
      x: (e.clientX - l.rect.left - l.ox) / l.zoom,
      y: (e.clientY - l.rect.top - l.oy) / l.zoom,
    };
  }

  function insideArtwork(point) {
    return point.x >= 0 && point.x < state.w && point.y >= 0 && point.y < state.h;
  }

  function localPoint(point, geometry) {
    const x = point.x - geometry.x, y = point.y - geometry.y;
    return {
      x: (x * geometry.cos + y * geometry.sin) / geometry.scale,
      y: (y * geometry.cos - x * geometry.sin) / geometry.scale,
    };
  }

  function wheelZoom(e) {
    const layer = state.activeLayer;
    if (!layer || stageDrag || stageTouches.size || e.ctrlKey || e.metaKey) return;
    const l = stageLayout();
    const point = artworkPoint(e, l);
    const preview = state.debugOpen && e.shiftKey;
    if (!preview && (!layer.visible || !insideArtwork(point))) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? l.rect.height : 1);
    const factor = Math.exp(clamp(-delta * 0.0014, -1, 1));
    if (preview) {
      state.autoFit = false;
      const zoom = clamp(l.zoom * factor, 0.04, 32);
      const change = 1 - zoom / l.zoom;
      state.panX += (e.clientX - l.rect.left - l.rect.width / 2 - state.panX) * change;
      state.panY += (e.clientY - l.rect.top - l.rect.height / 2 - state.panY) * change;
      state.zoom = zoom;
      updateZoomUI();
      drawStage();
      return;
    }
    const zoom = clamp(layer.zoom * factor, +$('imgZoom').min, +$('imgZoom').max);
    const change = 1 - zoom / layer.zoom;
    layer.x += (point.x / state.w - 0.5 - layer.x) * change;
    layer.y += (point.y / state.h - 0.5 - layer.y) * change;
    layer.zoom = zoom;
    syncFramingUI();
    if (change) {
      scheduleSource(true);
    }
  }

  function startStageDrag(e) {
    const layer = state.activeLayer;
    const preview = state.debugOpen && (e.shiftKey || e.button === 1);
    if (!layer || stageDrag || !e.isPrimary || (e.button !== 0 && !preview) || e.button > 1) return;
    const l = stageLayout();
    const point = artworkPoint(e, l);
    if (!preview && (!layer.visible || !insideArtwork(point))) return;
    e.preventDefault();
    if (document.activeElement === $('textBody')) $('textBody').blur();
    const drag = {
      id: e.pointerId, layer, preview, x: e.clientX, y: e.clientY,
      fromX: preview ? state.panX : layer.x,
      fromY: preview ? state.panY : layer.y,
    };
    stageDrag = drag;
    if (e.pointerType !== 'touch') $('view').setPointerCapture(e.pointerId);
    if (preview) state.autoFit = false;
    if (!preview && (state.drawing || state.erasing)) {
      drag.geometry = layerGeometry(layer);
      drag.stroke = {
        order: layer.revision,
        ink: state.erasing ? null : $('brushColor').value,
        width: +$(state.erasing ? 'eraseWidth' : 'brushWidth').value / drag.geometry.scale,
        points: [localPoint(point, drag.geometry)],
      };
      drag.strokes = state.erasing ? layer.erasures : layer.strokes;
      drag.strokes.push(drag.stroke);
      layer.revision++;
      drag.changed = true;
      $(state.erasing ? 'undoErase' : 'undoStroke').disabled = false;
      if (state.view !== 'result') setView('result');
      if (state.split) setSplit(false);
      scheduleSource(true);
    } else {
      $('view').classList.add('dragging');
    }
  }

  function moveStageDrag(e) {
    const drag = stageDrag;
    if (!drag) {
      if (state.debugOpen) inspectAt(e);
      return;
    }
    if (drag.id !== e.pointerId || (drag.x === e.clientX && drag.y === e.clientY && !drag.changed)) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.preview) {
      state.panX = drag.fromX + dx;
      state.panY = drag.fromY + dy;
      drawStage();
      return;
    }
    const l = stageLayout();
    if (drag.stroke) {
      const points = drag.stroke.points;
      const next = localPoint(artworkPoint(e, l), drag.geometry);
      const last = points[points.length - 1];
      if (next.x === last.x && next.y === last.y) return;
      points.push(next);
      drag.layer.revision++;
    } else {
      drag.layer.x = drag.fromX + dx / l.iw;
      drag.layer.y = drag.fromY + dy / l.ih;
    }
    drag.changed = true;
    scheduleSource(true);
  }

  function endStageDrag(e) {
    const drag = stageDrag;
    if (!drag || (e && drag.id !== e.pointerId)) return;
    if (e?.type === 'pointerup') moveStageDrag(e);
    stageDrag = null;
    const view = $('view');
    view.classList.remove('dragging');
    if (!stageTouches.has(drag.id) && view.hasPointerCapture(drag.id)) {
      view.releasePointerCapture(drag.id);
    }
    if (drag.changed) scheduleSource();
  }

  function touchCenter(points) {
    let clientX = 0, clientY = 0;
    for (const point of points) {
      clientX += point.clientX;
      clientY += point.clientY;
    }
    return { clientX: clientX / points.length, clientY: clientY / points.length };
  }

  function rebaseTouchTransform() {
    const changed = Boolean(touchTransform?.changed || stageDrag?.changed);
    touchTransform = null;
    if (stageTouches.size < 2 || stageTouches.size > 3) {
      if (changed) scheduleSource();
      return;
    }

    const layer = state.activeLayer;
    if (!layer?.visible) return;
    if (stageDrag?.stroke) {
      // The second finger turns an in-progress touch stroke into a transform.
      stageDrag.strokes.pop();
      layer.revision++;
      $('undoStroke').disabled = !layer.strokes?.length;
      $('undoErase').disabled = !layer.erasures.length;
    }
    endStageDrag();

    const points = Array.from(stageTouches.values());
    const center = touchCenter(points);
    const offsets = points.map(point => ({
      x: point.clientX - center.clientX,
      y: point.clientY - center.clientY,
    }));
    const spread = offsets.reduce((sum, point) => sum + point.x ** 2 + point.y ** 2, 0);
    const geometry = layerGeometry(layer);
    touchTransform = {
      layer, offsets, spread, changed, scale: geometry.scale, angle: layer.angle,
      anchor: localPoint(artworkPoint(center, stageLayout()), geometry),
    };
    if (changed) scheduleSource(true);
  }

  function startStagePointer(e) {
    if (e.pointerType !== 'touch') {
      if (!stageTouches.size) startStageDrag(e);
      return;
    }
    if (!state.activeLayer?.visible || (stageDrag && !stageTouches.has(stageDrag.id))) return;
    e.preventDefault();
    $('view').setPointerCapture(e.pointerId);
    stageTouches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (stageTouches.size === 1) startStageDrag(e);
    else rebaseTouchTransform();
  }

  function moveStagePointer(e) {
    if (e.pointerType !== 'touch') {
      if (!stageTouches.size) moveStageDrag(e);
      return;
    }
    const last = stageTouches.get(e.pointerId);
    if (!last || (last.clientX === e.clientX && last.clientY === e.clientY)) return;
    stageTouches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    const gesture = touchTransform;
    if (!gesture) {
      if (stageDrag) moveStageDrag(e);
      return;
    }
    if (gesture.spread < 1) {
      rebaseTouchTransform();
      return;
    }
    const points = Array.from(stageTouches.values());
    const center = touchCenter(points);
    let dot = 0, cross = 0;
    points.forEach((point, i) => {
      const dx = point.clientX - center.clientX, dy = point.clientY - center.clientY;
      const from = gesture.offsets[i];
      dot += from.x * dx + from.y * dy;
      cross += from.x * dy - from.y * dx;
    });
    const layer = gesture.layer;
    const pinch = points.length === 2;
    if (!pinch) {
      const degrees = Math.round(Math.atan2(cross, dot) * 180 / Math.PI);
      layer.angle = (gesture.angle + degrees + 540) % 360 - 180;
    }
    const factor = pinch ? Math.hypot(dot, cross) / gesture.spread : 1;
    const zoom = layer.zoom * gesture.scale * factor / layerGeometry(layer).scale;
    layer.zoom = clamp(zoom, +$('imgZoom').min, +$('imgZoom').max);

    const point = artworkPoint(center, stageLayout());
    const { scale, cos, sin } = layerGeometry(layer);
    const anchor = gesture.anchor;
    // Keep the same source point under the fingers, including after fit changes on rotation.
    layer.x = (point.x - (anchor.x * cos - anchor.y * sin) * scale) / state.w - 0.5;
    layer.y = (point.y - (anchor.x * sin + anchor.y * cos) * scale) / state.h - 0.5;
    gesture.changed = true;
    syncFramingUI();
    scheduleSource(true);
  }

  function endStagePointer(e) {
    if (e.pointerType !== 'touch') {
      endStageDrag(e);
      return;
    }
    if (!stageTouches.has(e.pointerId)) return;
    if (touchTransform && e.type === 'pointerup') moveStagePointer(e);
    endStageDrag(e);
    stageTouches.delete(e.pointerId);
    if (touchTransform || stageTouches.size >= 2) rebaseTouchTransform();
  }

  function endStageInteraction() {
    endStageDrag();
    const view = $('view');
    const ids = Array.from(stageTouches.keys());
    stageTouches.clear();
    rebaseTouchTransform();
    for (const id of ids) {
      if (view.hasPointerCapture(id)) view.releasePointerCapture(id);
    }
  }

  function inspectAt(e) {
    if (!state.processed || !state.resultCanvas) return;
    const l = stageLayout();
    const x = Math.floor((e.clientX - l.rect.left - l.ox) / l.zoom);
    const y = Math.floor((e.clientY - l.rect.top - l.oy) / l.zoom);
    if (x < 0 || y < 0 || x >= state.w || y >= state.h) {
      if (lastHoverKey) { lastHoverKey = ''; state.hover = null; updateInspector(); drawStage(); }
      return;
    }
    const key = x + ',' + y;
    if (key === lastHoverKey) return;
    lastHoverKey = key;
    state.hover = { x: x, y: y };
    updateInspector();
    drawStage();
  }

  function updateInspector() {
    const h = state.hover;
    if (!h || !state.processed || h.x >= state.w || h.y >= state.h) {
      $('pxCoord').textContent = '—';
      $('pxRaw').textContent = '—';
      $('pxProc').textContent = '—';
      $('pxLum').textContent = '—';
      $('pxScore').textContent = '—';
      $('pxInk').textContent = '—';
      $('pxInk').style.color = '';
      $('pxRawSwatch').style.background = '';
      $('pxProcSwatch').style.background = '';
      return;
    }
    const i = h.y * state.w + h.x;
    const raw = state.sourceData.data;
    const layer = state.layers.findLast(item => item.visible && item.cache?.rgba?.[i * 4 + 3] >= 128);
    const processed = layer?.cache.processed || state.processed;
    const pr = processed.rgb;
    const rr = raw[i * 4], rg = raw[i * 4 + 1], rb = raw[i * 4 + 2];
    const prr = Math.round(pr[i * 3]), prg = Math.round(pr[i * 3 + 1]), prb = Math.round(pr[i * 3 + 2]);
    const lum = processed.lum[i];
    const score = prr - Math.max(prg, prb);
    const code = state.codes ? state.codes[i] : -1;
    $('pxCoord').textContent = h.x + ',' + h.y;
    $('pxRaw').textContent = '#' + B.rgbToHex(rr, rg, rb).slice(1) + '  ' + rr + ',' + rg + ',' + rb;
    $('pxProc').textContent = '#' + B.rgbToHex(prr, prg, prb).slice(1) + '  ' + prr + ',' + prg + ',' + prb;
    $('pxLum').textContent = lum.toFixed(1);
    $('pxScore').textContent = String(Math.round(score));
    $('pxInk').textContent = code < 0 ? '—' : PANELS.modes[state.colorMode].inks[code] + ' (' + code + ')';
    $('pxInk').style.color = '';
    $('pxRawSwatch').style.background = 'rgb(' + rr + ',' + rg + ',' + rb + ')';
    $('pxProcSwatch').style.background = 'rgb(' + prr + ',' + prg + ',' + prb + ')';
  }

  /* ---------------------------------------------------------------- 导出 */
  async function exportPng() {
    finishPendingRender();
    if (!state.resultCanvas) { toast('请先添加图片或手写图层', true); return; }
    try {
      const blob = await canvasBlob(state.resultCanvas);
      saveBlob(blob, baseName() + '-ink.png');
      toast('已导出合成 PNG（' + state.w + '×' + state.h + '）');
    } catch (e) { toast(e.message, true); }
  }

  async function exportLayer(kind) {
    finishPendingRender();
    const c = kind === 'bw' ? state.bwCanvas : state.redCanvas;
    if (!c) return;
    try {
      const blob = await canvasBlob(c);
      saveBlob(blob, baseName() + '-' + kind + '.png');
      toast('已导出 ' + kind.toUpperCase() + ' 层 PNG');
    } catch (e) { toast(e.message, true); }
  }

  function exportBin(which) {
    finishPendingRender();
    if (!state.pack || (which === 'red' && !state.pack.plane1)) return;
    const p = state.pack;
    let data = p.data, name = baseName() + '-' + state.colorMode + '.bin';
    if (which === 'bw') { data = p.plane0; name = baseName() + '-bw.bin'; }
    if (which === 'red') { data = p.plane1; name = baseName() + '-red.bin'; }
    saveBlob(new Blob([data], { type: 'application/octet-stream' }), name);
    toast('已导出 ' + name + ' · ' + data.length + ' B');
  }

  function paramsObject() {
    return {
      tool: 'Ink Studio', version: B.VERSION,
      panel: { w: state.w, h: state.h, colorMode: state.colorMode },
      palette: PANELS.modes[state.colorMode].colors,
      layers: state.layers.map(({ name, kind, visible, mapping, accentColor, pre, params }) => ({
        name, kind, visible, mapping, accentColor, preprocess: pre, quantize: params,
      })),
      packing: {
        encoding: state.encoding,
        invertBW: state.invertBW,
        invertRed: state.invertRed,
        bytes: state.pack ? state.pack.bytes : null,
        crc0: state.pack ? state.pack.crc0 : null,
        crc1: state.pack ? state.pack.crc1 : null,
        crcAll: state.pack ? state.pack.crcAll : null,
      },
      coverage: state.metrics ? state.metrics.coverage.map((v) => +v.toFixed(5)) : null,
      source: state.layers.find((layer) => layer.kind === 'image')?.name || '',
    };
  }

  function exportJson() {
    finishPendingRender();
    if (!state.processed) { toast('请先添加图片或手写图层', true); return; }
    const blob = new Blob([JSON.stringify(paramsObject(), null, 2)], { type: 'application/json' });
    saveBlob(blob, baseName() + '-params.json');
    toast('已导出参数 JSON');
  }

  function copyJson() {
    finishPendingRender();
    if (!state.processed) { toast('请先添加图片或手写图层', true); return; }
    const txt = JSON.stringify(paramsObject(), null, 2);
    const done = () => toast('参数已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
    } else fallbackCopy(txt, done);
  }

  function fallbackCopy(txt, done) {
    const t = document.createElement('textarea');
    t.value = txt; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请用“参数 JSON”导出', true); }
    t.remove();
  }

  /* ---------------------------------------------------------------- 预设 */
  function applyPreset(name) {
    const layer = activeImageLayer();
    if (!layer) return;
    if (!name) {
      restoreAutomatic();
      return;
    }
    const presets = {
      photo: { dither: 'fs', contrast: 4, sharpen: 45, whiteClip: 248 },
      icon: { dither: 'none', contrast: 5, sharpen: 20, whiteClip: 242 },
      redtone: { dither: 'fs', contrast: 8, saturation: 110, whiteClip: 245 },
      poster: { dither: 'bayer8', contrast: 16, sharpen: 25, whiteClip: 235 },
      text: { dither: 'none', contrast: 35, sharpen: 60, whiteClip: 232 },
      custom: { dither: 'atkinson', contrast: 10, sharpen: 55, whiteClip: 248 },
    };
    const preset = presets[name];
    if (!preset) return;
    const { dither, ...pre } = preset;
    layer.preset = name;
    layer.manual = true;
    layer.dither = dither;
    layer.mapping = name === 'icon' || name === 'photo' ? 'natural' : 'auto';
    if (name === 'text') layer.mapping = 'mono';
    layer.pre = { ...PRE_DEFAULTS, ...pre };
    layer.params = { ...EMPTY_PARAMS, dither };
    syncControls();
    reprocess();
  }

  /* ---------------------------------------------------------------- 事件 */
  function bindEvents() {
    $('debugBtn').addEventListener('click', () => setDebug(!state.debugOpen));
    $('autoBtn').addEventListener('click', restoreAutomatic);
    window.addEventListener('ink:tab', (event) => {
      if (event.detail?.tab !== 'image') {
        endStageInteraction();
        return;
      }
      // The stage was hidden while another tab was open; its size is only
      // meaningful again after the browser has laid it out.
      requestAnimationFrame(() => {
        if (state.autoFit) fitView(false);
        else drawStage();
      });
    });

    bindRange('bri', (v) => { state.pre.brightness = v; }, String);
    bindRange('con', (v) => { state.pre.contrast = v; }, String);
    bindRange('threshold', (v) => { state.params.threshold = v; }, String);
    $('hist').addEventListener('pointerdown', (e) => {
      histDrag = e.pointerId;
      $('hist').setPointerCapture(e.pointerId);
      moveHistogramThreshold(e);
    });
    $('hist').addEventListener('pointermove', (e) => {
      if (histDrag === e.pointerId) moveHistogramThreshold(e);
    });
    $('hist').addEventListener('lostpointercapture', endHistDrag);

    $('quickDither').addEventListener('change', (e) => {
      const layer = state.activeLayer;
      if (!layer) return;
      layer.dither = e.target.value === 'auto' ? null : e.target.value;
      layer.params.dither = layer.dither || layer.recommendation?.params.dither || 'none';
      scheduleProcess(false);
    });
    $('layerMapping').addEventListener('change', (e) => {
      if (!state.activeLayer) return;
      state.activeLayer.mapping = e.target.value;
      $('mapColorField').hidden = e.target.value !== 'color';
      scheduleProcess(false);
    });
    $('mapColor').addEventListener('input', (e) => {
      if (!state.activeLayer) return;
      state.activeLayer.accentColor = e.target.value;
      scheduleProcess(false);
    });
    $('presetSelect').addEventListener('change', (e) => applyPreset(e.target.value));

    $('eraseBtn').addEventListener('click', () => {
      endStageInteraction();
      state.erasing = !state.erasing;
      syncLayerUI();
    });
    for (const [id, undo, key] of [['brushWidth', 'undoStroke', 'strokes'], ['eraseWidth', 'undoErase', 'erasures']]) {
      $(id).addEventListener('input', (e) => { $(id + 'Out').textContent = e.target.value + ' px'; });
      $(undo).addEventListener('click', () => {
        const layer = state.activeLayer;
        if (!layer?.[key]?.length) return;
        endStageInteraction();
        layer[key].pop();
        layer.revision++;
        syncLayerUI();
        rebuildSource();
      });
    }
    $('addImageLayer').addEventListener('click', () => {
      $('addLayerMenu').open = false;
      chooseFile(true);
    });
    $('addInkLayer').addEventListener('click', () => {
      $('addLayerMenu').open = false;
      selectLayer(addInkLayer());
      renderLayerList();
      setView('result');
      if (state.split) setSplit(false);
      if (state.autoFit) fitView(false);
      rebuildSource();
    });
    $('addTextLayer').addEventListener('click', () => {
      $('addLayerMenu').open = false;
      addTextLayer();
    });
    $('textBody').addEventListener('input', (e) => {
      const layer = state.activeLayer;
      if (layer?.kind !== 'text') return;
      layer.text = e.target.value;
      layer.revision++;
      scheduleSource(true);
    });
    $('textSize').addEventListener('input', (e) => {
      const layer = state.activeLayer;
      if (layer?.kind !== 'text' || !e.target.validity.valid || !Number.isFinite(e.target.valueAsNumber)) return;
      layer.fontSize = e.target.valueAsNumber;
      layer.revision++;
      scheduleSource(true);
    });
    $('textSize').addEventListener('change', (e) => {
      if (state.activeLayer?.kind === 'text') e.target.value = String(state.activeLayer.fontSize);
    });
    $('textColor').addEventListener('change', (e) => {
      const layer = state.activeLayer;
      if (layer?.kind !== 'text') return;
      layer.ink = e.target.value;
      layer.revision++;
      scheduleSource();
    });
    $('layerList').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-layer]');
      if (button) selectLayer(state.layers[Number(button.dataset.layer)]);
    });
    $('layerUp').addEventListener('click', () => moveLayer(1));
    $('layerDown').addEventListener('click', () => moveLayer(-1));
    $('layerVisible').addEventListener('click', toggleLayerVisibility);
    $('removeLayer').addEventListener('click', removeLayer);

    // framing
    $('fitSelect').addEventListener('change', (e) => {
      const layer = activeImageLayer();
      if (!layer) return;
      Object.assign(layer, { fit: e.target.value, x: 0, y: 0 });
      rebuildSource();
    });
    $('angle').addEventListener('input', (e) => {
      const layer = state.activeLayer;
      if (layer) setLayerAngle(layer, +e.target.value);
    });
    $('imgZoom').addEventListener('input', (e) => {
      const layer = state.activeLayer;
      if (!layer) return;
      layer.zoom = +e.target.value;
      syncFramingUI();
      scheduleSource(true);
    });
    $('resetView').addEventListener('click', resetFraming);

    // samples / files
    document.querySelectorAll('[data-sample]').forEach((b) => {
      b.addEventListener('click', () => { loadSample(b.dataset.sample); });
    });
    $('openBtn').addEventListener('click', () => chooseFile());
    $('emptyOpen').addEventListener('click', () => chooseFile());
    $('fileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      const target = fileTarget;
      fileTarget = undefined;
      e.target.value = '';
      if (file) loadFile(file, target);
    });
    $('fileInput').addEventListener('cancel', () => { fileTarget = undefined; });
    $('pasteBtn').addEventListener('click', async () => {
      const target = activeImageLayer();
      try {
        if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('no clipboard');
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              await loadFile(new File([blob], 'clipboard.png', { type: type }), target);
              return;
            }
          }
        }
        toast('剪贴板里没有图片', true);
      } catch (e) {
        toast('浏览器没给剪贴板权限，请直接 Ctrl+V', true);
      }
    });

    // panel
    $('colorMode').addEventListener('change', (e) => applyColorMode(e.target.value));
    $('panelSelect').addEventListener('change', (e) => {
      const panel = panelById.get(e.target.value);
      if (panel) applyPanelSize(panel.w, panel.h, panel.id, panel.modes[0]);
      else applyPanelSize(state.w, state.h, 'custom');
    });
    ['customW', 'customH'].forEach((id) => {
      $(id).addEventListener('change', () => {
        $('panelSelect').value = 'custom';
        $('sizeCustom').hidden = false;
        applyPanelSize(+$('customW').value, +$('customH').value, 'custom');
      });
    });

    // stage
    const view = $('view');
    view.addEventListener('pointerdown', startStagePointer);
    view.addEventListener('pointermove', moveStagePointer);
    view.addEventListener('pointerup', endStagePointer);
    view.addEventListener('pointercancel', endStagePointer);
    view.addEventListener('lostpointercapture', endStagePointer);
    view.addEventListener('pointerleave', () => {
      if (state.debugOpen && !stageDrag && !stageTouches.size) {
        lastHoverKey = ''; state.hover = null; updateInspector(); drawStage();
      }
    });
    view.addEventListener('wheel', wheelZoom, { passive: false });
    view.addEventListener('dblclick', () => {
      if (state.debugOpen) { state.autoFit = true; fitView(); }
    });

    $('splitHandle').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const l = stageLayout();
      const move = (ev) => {
        state.splitFrac = clamp((ev.clientX - l.rect.left - l.ox) / l.iw, 0.02, 0.98);
        drawStage();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    $('splitBtn').addEventListener('click', () => setSplit(!state.split));
    $('smoothBtn').addEventListener('click', () => { state.smooth = !state.smooth; updateSmoothUI(); drawStage(); });
    $('gridChk').addEventListener('change', drawStage);
    $('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
    $('zoomOutBtn').addEventListener('click', () => zoomBy(0.8));
    $('fitBtn').addEventListener('click', () => { state.autoFit = true; fitView(); });
    $('oneBtn').addEventListener('click', () => {
      state.autoFit = false;
      state.zoom = 1; state.panX = 0; state.panY = 0; updateZoomUI(); drawStage();
    });

    // tabs / thumbs
    document.querySelectorAll('.view-tab, .thumb').forEach((b) => {
      b.addEventListener('click', () => setView(b.dataset.view));
    });

    // export
    $('topExport').addEventListener('click', exportPng);
    $('expPng').addEventListener('click', exportPng);
    $('expBW').addEventListener('click', () => exportLayer('bw'));
    $('expRED').addEventListener('click', () => exportLayer('red'));
    $('expBin').addEventListener('click', () => exportBin('all'));
    $('expBWBin').addEventListener('click', () => exportBin('bw'));
    $('expRedBin').addEventListener('click', () => exportBin('red'));
    $('expJson').addEventListener('click', exportJson);
    $('copyJson').addEventListener('click', copyJson);
    $('encoding').addEventListener('change', (e) => {
      state.encoding = e.target.value; repack(); saveSoon();
    });
    $('invBW').addEventListener('change', (e) => { state.invertBW = e.target.checked; repack(); saveSoon(); });
    $('invRed').addEventListener('change', (e) => { state.invertRed = e.target.checked; repack(); saveSoon(); });

    // drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('dropOverlay').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    // paste
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); loadFile(f); return; }
        }
      }
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (!state.debugOpen || !state.layers.length || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.target.closest?.('input, select, textarea, button, a') || e.target.isContentEditable) return;
      if (e.code === 'Space') { e.preventDefault(); state.spaceSource = true; drawStage(); return; }
      if (e.key === '1') setView('result');
      else if (e.key === '2') setView('source');
      else if (e.key === '3') setView('bw');
      else if (e.key === '4') setView('red');
      else if (e.key === 'b' || e.key === 'B') setSplit(!state.split);
      else if (e.key === 'g' || e.key === 'G') { $('gridChk').checked = !$('gridChk').checked; drawStage(); }
      else if (e.key === 'f' || e.key === 'F') fitView();
      else if (e.key === '0') { state.zoom = 1; state.panX = 0; state.panY = 0; updateZoomUI(); drawStage(); }
      else if (e.key === 'r' || e.key === 'R') resetFraming();
      else if (e.key === '[') zoomBy(0.8);
      else if (e.key === ']') zoomBy(1.25);
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && state.spaceSource) { state.spaceSource = false; drawStage(); }
    });
    window.addEventListener('blur', () => {
      state.spaceSource = false;
      endStageInteraction();
      drawStage();
    });

    // resize
    if (window.ResizeObserver) {
      let rt = 0;
      new ResizeObserver(() => {
        clearTimeout(rt);
        rt = setTimeout(() => {
          if (state.autoFit && state.layers.length) fitView();
          else drawStage();
          drawHistogram();
        }, 60);
      }).observe($('stage'));
    } else {
      window.addEventListener('resize', () => {
        if (state.autoFit && state.layers.length) fitView();
        else drawStage();
        drawHistogram();
      });
    }
  }

  function bindRange(id, apply, format) {
    const e = $(id), o = $(id + 'Out');
    e.addEventListener('input', () => {
      apply(+e.value);
      if (o) o.textContent = format ? format(+e.value) : e.value;
      scheduleProcess();
      saveSoon();
    });
  }

  function setLayerAngle(layer, angle) {
    layer.angle = angle;
    syncFramingUI();
    scheduleSource(true);
  }

  function resetFraming() {
    const layer = state.activeLayer;
    if (!layer) return;
    Object.assign(layer, DEFAULT_TRANSFORM);
    syncFramingUI();
    rebuildSource();
  }

  function availableModes(id) {
    return id.startsWith('epd') ? panelById.get(id).modes : Object.keys(PANELS.modes);
  }

  function applyColorMode(mode) {
    if (state.colorMode !== mode && availableModes(state.panelId).includes(mode)) {
      applyPanelSize(state.w, state.h, state.panelId, mode);
    }
  }

  function applyPanelSize(w, h, id, mode = state.colorMode) {
    w = clamp(Math.round(w) || 400, 8, 1024);
    h = clamp(Math.round(h) || 300, 8, 1024);
    endStageInteraction();
    const panel = panelById.get(id);
    state.panelId = panel?.w === w && panel.h === h ? id : 'custom';
    state.w = w;
    state.h = h;
    state.hover = null;
    lastHoverKey = '';
    const modes = availableModes(state.panelId);
    state.colorMode = modes.includes(mode) ? mode : modes[0];
    state.palette = B.makePalette(PANELS.modes[state.colorMode].colors);
    $('colorMode').replaceChildren(...modes.map(key => new Option(PANELS.modes[key].label, key)));
    $('customW').value = String(w);
    $('customH').value = String(h);
    $('panelSelect').value = state.panelId;
    $('sizeCustom').hidden = state.panelId !== 'custom';
    state.autoFit = true;
    syncControls();
    fitView(false);
    rebuildSource();
    saveSoon();
    scheduleFit();
  }

  /* ---------------------------------------------------------------- 保存 */
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 350);
  }

  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        panel: { w: state.w, h: state.h, id: state.panelId, colorMode: state.colorMode },
        encoding: state.encoding,
        invertBW: state.invertBW,
        invertRed: state.invertRed,
      }));
    } catch (e) { /* file:// 下 localStorage 可能不可用 */ }
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.panel && s.panel.w && s.panel.h) {
        state.w = clamp(s.panel.w, 8, 1024);
        state.h = clamp(s.panel.h, 8, 1024);
        state.panelId = s.panel.id || (state.w + 'x' + state.h);
        if (Object.hasOwn(PANELS.modes, s.panel.colorMode)) state.colorMode = s.panel.colorMode;
      }
      if (s.encoding === 'gateway' || s.encoding === 'driver') state.encoding = s.encoding;
      state.invertBW = !!s.invertBW;
      state.invertRed = !!s.invertRed;
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- 查询参数 / 自测 */
  function applyQueryOverrides() {
    let changed = false;
    const paramNums = ['warmGate', 'redBias', 'toneRed', 'dark', 'light', 'redScore', 'redSoft'];
    paramNums.forEach((k) => {
      if (!q.has(k)) return;
      const v = +q.get(k);
      if (!Number.isFinite(v)) return;
      state.params[k] = v;
      changed = true;
    });
    const preNums = ['sharpen', 'contrast', 'saturation', 'redBoost', 'brightness'];
    preNums.forEach((k) => {
      if (!q.has(k)) return;
      const v = +q.get(k);
      if (!Number.isFinite(v)) return;
      state.pre[k] = v;
      changed = true;
    });
    if (q.has('whiteClip')) { state.pre.whiteClip = +q.get('whiteClip'); changed = true; }
    if (q.has('blackClip')) { state.pre.blackClip = +q.get('blackClip'); changed = true; }
    if (q.has('strength')) {
      const v = +q.get('strength');
      state.params.strength = v > 1 ? v / 100 : v;
      changed = true;
    }
    if (q.get('mode')) {
      state.params.mode = q.get('mode');
      if (state.activeLayer) state.activeLayer.mapping = 'query';
      changed = true;
    }
    if (q.get('dither')) {
      state.params.dither = B.normalizeParams({ dither: q.get('dither') }).dither;
      if (state.activeLayer) state.activeLayer.dither = state.params.dither;
      changed = true;
    }
    if (changed && state.activeLayer) state.activeLayer.manual = true;
    if (changed || q.has('view') || q.has('zoom') || q.get('split') === '1') setDebug(true);
    if (q.get('view')) setView(q.get('view'));
    if (q.get('zoom')) {
      if (q.get('zoom') === 'fit') { state.autoFit = true; fitView(); }
      else {
        const z = parseFloat(q.get('zoom'));
        if (z > 0) { state.autoFit = false; state.zoom = clamp(z, 0.04, 32); updateZoomUI(); drawStage(); }
      }
    }
    if (q.get('split') === '1') setSplit(true);
    if (q.get('encoding') === 'driver' || q.get('encoding') === 'gateway') {
      state.encoding = q.get('encoding');
      changed = true;
    }
    if (changed) {
      syncControls();
      reprocess();
    } else {
      repack();
    }
  }

  async function runSelfTest() {
    const out = [];
    let origParams, origMapping;
    try {
      await loadSample(q.get('sample') || 'chart');
      setDebug(true);
      origParams = { ...state.params };
      origMapping = state.activeLayer.mapping;
      state.activeLayer.mapping = 'query';
      const modeInfo = PANELS.modes[state.colorMode];
      const maxCode = modeInfo.colors.length - 1;
      const planeCount = hasAccent() ? 2 : 1;
      const expectedBytes = Math.ceil(state.w * modeInfo.bits / 8) * state.h * planeCount;
      out.push('sample=' + state.activeLayer.name + ' canvas=' + state.w + 'x' + state.h + ' mode=' + state.colorMode);
      if (!state.codes || state.codes.length !== state.w * state.h) throw new Error('code buffer length');
      if (!state.pack || state.pack.bytes !== expectedBytes ||
          Boolean(state.pack.plane1) !== hasAccent()) throw new Error('pack size or plane count');
      out.push('pack bytes=' + state.pack.bytes + ' crc0=0x' + hex4(state.pack.crc0) +
        (hasAccent() ? ' crc1=0x' + hex4(state.pack.crc1) : ''));
      out.push('coverage=' + state.metrics.coverage.map((v) => (v * 100).toFixed(1) + '%').join('/'));

      let combos = 0;
      for (const mode of !hasAccent() ? ['nearest'] : ['dominant', 'nearest', 'rule', 'duotone']) {
        for (const dither of ['none', 'fs', 'atkinson', 'stucki', 'bayer4', 'bayer8']) {
          state.params.mode = mode;
          state.params.dither = dither;
          state.params.strength = 1;
          reprocess();
          if (!state.codes || state.codes.length !== state.w * state.h) throw new Error(mode + '/' + dither + ' codes');
          for (let i = 0; i < state.codes.length; i++) {
            if (state.codes[i] > maxCode) throw new Error(mode + '/' + dither + ' code value');
          }
          combos++;
        }
      }
      out.push('combos=' + combos + ' all code values 0..' + maxCode);

      // 已知 CRC：全白 400×300 的 plane0 应为 11440
      const white = new Uint8Array(400 * 300).fill(B.WHITE);
      const wp = B.pack(white, 400, 300, { colorMode: 'bw' });
      if (wp.bytes !== 15000 || wp.crc0 !== 11440) throw new Error('white CRC ' + wp.crc0);
      out.push('white pack crc0=' + wp.crc0 + ' (expected 11440)');
      if (runtimeErrors.length) throw new Error('runtime errors: ' + runtimeErrors.join(' | '));

      state.activeLayer.mapping = origMapping;
      state.params = origParams;
      syncControls();
      reprocess();
      out.push('PASS');
      document.title = 'Ink Studio · SELFTEST PASS';
      document.body.dataset.selftest = 'pass';
    } catch (e) {
      out.push('FAIL ' + (e && e.stack ? e.stack : e));
      document.title = 'Ink Studio · SELFTEST FAIL';
      document.body.dataset.selftest = 'fail';
      if (origParams) {
        state.activeLayer.mapping = origMapping;
        state.params = origParams;
        syncControls(); reprocess();
      }
    }
    const pre = $('selftest');
    pre.hidden = false;
    pre.textContent = out.join('\n');
    console.log(out.join('\n'));
  }

  /* ---------------------------------------------------------------- init */
  function init() {
    if (q.get('fresh') !== '1') loadSaved();
    const colorMode = q.get('colorMode');
    if (Object.hasOwn(PANELS.modes, colorMode)) state.colorMode = colorMode;
    const select = $('panelSelect');
    const generic = document.createElement('optgroup');
    generic.label = '常用画布';
    const arduino = document.createElement('optgroup');
    arduino.label = 'Arduino 示例';
    for (const panel of PANELS.panels) {
      const colors = panel.modes.map(key => PANELS.modes[key].label).join(' / ');
      const name = panel.name + ' · ' + panel.w + ' × ' + panel.h + ' · ' + colors;
      (panel.id.startsWith('epd') ? arduino : generic).append(new Option(name, panel.id));
    }
    select.append(generic, arduino, new Option('自定义…', 'custom'));
    bindEvents();
    updateSmoothUI();

    const model = panelById.get(q.get('panel'));
    const panel = (q.get('panel') || '').match(/^(\d+)x(\d+)$/);
    if (model) applyPanelSize(model.w, model.h, model.id);
    else if (panel) applyPanelSize(+panel[1], +panel[2], panel[0]);
    else if (q.has('w') && q.has('h')) applyPanelSize(+q.get('w'), +q.get('h'), 'custom');
    else applyPanelSize(state.w, state.h, state.panelId);

    if (q.get('selftest')) {
      runSelfTest();
      return;
    }
    const sample = q.get('sample');
    if (sample && sample !== 'none') loadSample(sample);
    applyQueryOverrides();
    document.body.dataset.ready = '1';
  }

  window.__BWR_LAB__ = {
    state: state, B: B, reprocess: reprocess, rebuildSource: rebuildSource,
    loadSample: loadSample, applyPreset: applyPreset, fitView: fitView,
    setView: setView, setSplit: setSplit, repack: repack, drawHistogram: drawHistogram,
    errors: runtimeErrors, finishPendingRender: finishPendingRender,
  };

  init();
})();
