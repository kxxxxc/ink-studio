/* bwr-core.js — 三色墨水屏（黑 / 白 / 红）图像转换核心
 *
 * 这个文件不碰 DOM，既能被 index.html 当普通 <script> 用（挂到 window.BWR），
 * 也能在 Node 里 require 做单元测试。所有颜色都是 sRGB 0..255。
 *
 * 管线：
 *   preprocess(rgba)                 亮度/对比度/伽马/饱和/红增强/锐化
 *   quantize({rgb,palette,params})   最近色 / 规则映射 / 红当灰阶 + 抖动
 *   analyze(codes,rgb,...)           覆盖率、视觉误差、红连通块
 *   pack(codes,...)                  网关双平面 / 驱动双平面 + CRC16
 *
 * 重要约定（与 gateway-idf/main/prism_image.cpp 一致）：
 *   code 0 = 黑，1 = 白，2 = 红
 *   网关平面：plane0 的 bit=1 表示白，plane1 的 bit=1 表示红
 *   每行按 MSB-first 打包，行尾不足 8 px 的位补 0；plane0 后紧跟 plane1。
 *   CRC16 = CCITT-FALSE（init 0xFFFF, poly 0x1021），与设备 /epd/info.last 同款。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BWR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BLACK = 0, WHITE = 1, RED = 2;
  const INK_NAMES = ['黑', '白', '红'];
  const VERSION = '1.0.0';

  /* ------------------------------------------------------------------ 色彩 */

  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function finite(v, def) { const n = +v; return Number.isFinite(n) ? n : def; }

  function smoothstep(a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    let t = (x - a) / (b - a);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return t * t * (3 - 2 * t);
  }

  function hexToRgb(hex) {
    if (Array.isArray(hex)) return [hex[0] | 0, hex[1] | 0, hex[2] | 0];
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(r, g, b) {
    const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }

  /* sRGB -> OKLab。out 至少 3 个元素，从 off 开始写。 */
  function rgbToOklab(r, g, b, out, off) {
    off = off || 0;
    const lr = LIN[r < 0 ? 0 : (r > 255 ? 255 : r | 0)];
    const lg = LIN[g < 0 ? 0 : (g > 255 ? 255 : g | 0)];
    const lb = LIN[b < 0 ? 0 : (b > 255 ? 255 : b | 0)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[off] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[off + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[off + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }

  function linToSrgb(v) {
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
  }

  /* OKLab -> sRGB 0..255。out 至少 3 个元素。 */
  function oklabToRgb(L, a, b, out, off) {
    off = off || 0;
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    out[off] = linToSrgb(r);
    out[off + 1] = linToSrgb(g);
    out[off + 2] = linToSrgb(bb);
  }

  function makePalette(colors) {
    const src = colors || ['#000000', '#ffffff', '#c80000'];
    const rgb = src.map(hexToRgb);
    const lab = rgb.map((c) => {
      const t = new Float32Array(3);
      rgbToOklab(c[0], c[1], c[2], t, 0);
      return t;
    });
    return { rgb: rgb, lab: lab };
  }

  /* ---------------------------------------------------------------- 预处理 */

  function boxBlur(src, w, h, radius) {
    const r = radius | 0;
    if (r <= 0) return src.slice();
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const div = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / div;
        sum -= src[row + clamp(x - r, 0, w - 1)];
        sum += src[row + clamp(x + r + 1, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / div;
        sum -= tmp[clamp(y - r, 0, h - 1) * w + x];
        sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  /**
   * RGBA -> 处理后 RGB（Float32，0..255）+ 亮度。
   * options: brightness(-100..100) contrast(-100..100) gamma(0.4..2.5)
   *          saturation(0..200) redBoost(0..200) sharpen(0..150) invert(bool)
   */
  function preprocess(rgba, w, h, options) {
    const o = Object.assign({
      brightness: 0, contrast: 0, gamma: 1, saturation: 100,
      redBoost: 0, sharpen: 0, invert: false, blackClip: 0, whiteClip: 255,
    }, options || {});
    const n = w * h;
    if (!rgba || rgba.length < n * 4) throw new Error('preprocess: RGBA buffer too small');
    const rgb = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    const con = 1 + o.contrast / 100;
    const bright = o.brightness * 0.8;
    const invGamma = o.gamma > 0 ? 1 / o.gamma : 1;
    const doGamma = Math.abs(o.gamma - 1) > 0.001;

    for (let i = 0; i < n; i++) {
      const s = i * 4;
      let r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
      const a = rgba[s + 3] / 255;
      if (a < 1) {
        r = r * a + 255 * (1 - a);
        g = g * a + 255 * (1 - a);
        b = b * a + 255 * (1 - a);
      }
      r = (r - 128) * con + 128 + bright;
      g = (g - 128) * con + 128 + bright;
      b = (b - 128) * con + 128 + bright;
      if (doGamma) {
        r = 255 * Math.pow(clamp(r, 0, 255) / 255, invGamma);
        g = 255 * Math.pow(clamp(g, 0, 255) / 255, invGamma);
        b = 255 * Math.pow(clamp(b, 0, 255) / 255, invGamma);
      }
      rgb[i * 3] = clamp(r, 0, 255);
      rgb[i * 3 + 1] = clamp(g, 0, 255);
      rgb[i * 3 + 2] = clamp(b, 0, 255);
    }

    const doSat = Math.abs(o.saturation - 100) > 0.001 || o.redBoost > 0.001;
    if (doSat) {
      const lab = new Float32Array(3);
      const out = new Float32Array(3);
      const sat = o.saturation / 100;
      const boost = o.redBoost / 100;
      for (let i = 0; i < n; i++) {
        const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
        rgbToOklab(r, g, b, lab, 0);
        const warm = clamp((r - Math.max(g, b)) / 80, 0, 1);
        const f = sat * (1 + boost * warm);
        oklabToRgb(lab[0], lab[1] * f, lab[2] * f, out, 0);
        rgb[i * 3] = out[0];
        rgb[i * 3 + 1] = out[1];
        rgb[i * 3 + 2] = out[2];
      }
    }

    if (o.sharpen > 0) {
      for (let i = 0; i < n; i++) {
        lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      }
      const blur = boxBlur(lum, w, h, 1);
      const amount = (o.sharpen / 100) * 1.8;
      for (let i = 0; i < n; i++) {
        const d = (lum[i] - blur[i]) * amount;
        rgb[i * 3] = clamp(rgb[i * 3] + d, 0, 255);
        rgb[i * 3 + 1] = clamp(rgb[i * 3 + 1] + d, 0, 255);
        rgb[i * 3 + 2] = clamp(rgb[i * 3 + 2] + d, 0, 255);
      }
    }

    if (o.invert) {
      for (let i = 0; i < n * 3; i++) rgb[i] = 255 - rgb[i];
    }

    for (let i = 0; i < n; i++) {
      lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    }

    // 高光 / 暗部裁切：纸张接近白、墨接近黑，超出的部分不该再拿网点去模拟。
    // 这比"把阈值调低"更直接：纯白区不会因为一点点暖色而长出红点。
    let blackClip = clamp(+o.blackClip || 0, 0, 254);
    let whiteClip = clamp(o.whiteClip === undefined ? 255 : +o.whiteClip, 1, 255);
    if (whiteClip <= blackClip) whiteClip = Math.min(255, blackClip + 1);
    if (blackClip > 0 || whiteClip < 255) {
      for (let i = 0; i < n; i++) {
        if (lum[i] <= blackClip) {
          rgb[i * 3] = 0; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 0; lum[i] = 0;
        } else if (lum[i] >= whiteClip) {
          rgb[i * 3] = 255; rgb[i * 3 + 1] = 255; rgb[i * 3 + 2] = 255; lum[i] = 255;
        }
      }
    }
    return { rgb: rgb, lum: lum };
  }

  function colorMix(rgba, inkMask) {
    const counts = [0, 0, 0];
    let neutral = 0, pixels = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (inkMask && inkMask[i + 3] >= 128) continue;
      pixels++;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b);
      if (max - Math.min(r, g, b) < 20) {
        neutral++;
        continue;
      }
      // 饱和的黄、青、品红把一票平分给并列的通道。
      const weight = 1 / (Number(r === max) + Number(g === max) + Number(b === max));
      if (r === max) counts[0] += weight;
      if (g === max) counts[1] += weight;
      if (b === max) counts[2] += weight;
    }
    const maxCount = Math.max(...counts);
    return {
      channel: maxCount > 0 ? counts.indexOf(maxCount) : null,
      ratios: counts.map(count => count / (pixels || 1)),
      neutral: neutral / (pixels || 1),
    };
  }

  /* 自动档只分析缩小后的原图，避免把适配画布产生的留白当成图片内容。 */
  function recommend(rgba, w, h, panelW, panelH, sourceAspect = w / h) {
    const lumHist = new Uint32Array(256);
    const paperHist = new Uint32Array(256);
    const colorBins = new Uint32Array(4096);
    const pixels = w * h;
    let paper = 0, neutralDark = 0, warm = 0, red = 0, colored = 0;
    let flat = 0, edges = 0, neighbors = 0;

    function compare(a, b) {
      const diff = Math.max(
        Math.abs(rgba[a] - rgba[b]),
        Math.abs(rgba[a + 1] - rgba[b + 1]),
        Math.abs(rgba[a + 2] - rgba[b + 2]),
      );
      neighbors++;
      if (diff <= 5) flat++;
      if (diff >= 45) edges++;
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const redScore = r - Math.max(g, b);
        lumHist[lum]++;
        colorBins[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
        if (lum >= 225 && chroma <= 18) { paper++; paperHist[lum]++; }
        if (lum < 158 && chroma < 20) neutralDark++;
        if (redScore >= 25 && redScore < 70 && lum > 70) warm++;
        if (redScore >= 70) red++;
        if (chroma >= 20) colored++;
        if (x) compare(i, i - 4);
        if (y) compare(i, i - w * 4);
      }
    }

    function percentile(hist, count, fraction) {
      let target = Math.ceil(count * fraction);
      for (let i = 0; i < hist.length; i++) {
        target -= hist[i];
        if (target <= 0) return i;
      }
      return 255;
    }

    colorBins.sort();
    const topColors = colorBins.subarray(-4).reduce((sum, n) => sum + n, 0) / pixels;
    // 留白多的小图标也能按局部边缘识别。
    const hardEdges = edges > Math.min(neighbors * 0.004, (neighbors - flat) * 0.35);
    const flatGraphic = hardEdges && flat > neighbors * 0.87 && topColors >= 0.78;
    // 少量彩色强调仍可按文档处理，大色块图标保留图形参数。
    const document = flatGraphic && paper > pixels * 0.64
      && neutralDark > pixels * 0.008 && colored <= pixels * 0.06;
    const aspectMismatch = sourceAspect / (panelW / panelH);
    const fit = !flatGraphic && aspectMismatch >= 1 / 1.12 && aspectMismatch <= 1.12 ? 'cover' : 'contain';

    if (flatGraphic) {
      return {
        fit,
        kind: document ? 'document' : 'graphic',
        pre: {
          contrast: document ? 18 : 5,
          sharpen: document ? 45 : 24,
          blackClip: document ? 14 : 10,
          whiteClip: document ? clamp(percentile(paperHist, paper, 0.1) - 3, 225, 246) : 244,
        },
        params: { mode: 'dominant', dither: 'none' },
      };
    }

    const median = percentile(lumHist, pixels, 0.5);
    const high = percentile(lumHist, pixels, 0.9);
    const monochrome = colored < pixels * 0.015;
    const warmPhoto = !monochrome && warm > pixels * 0.18 && red < pixels * 0.07;
    // Atkinson 的误差衰减让小屏浅调照片的高光更干净，其他照片用 FS 保连续灰阶。
    const lightSmallPhoto = panelW * panelH <= 60000 && median >= 145 && high >= 215;
    return {
      fit,
      kind: monochrome ? 'monochrome' : warmPhoto ? 'warm' : 'photo',
      pre: {
        gamma: median < 100 && high < 200 ? clamp(1 + (100 - median) / 320, 1, 1.2) : 1,
        saturation: monochrome || warmPhoto ? 100 : 108,
        sharpen: panelW * panelH <= 60000 ? 42 : 28,
        blackClip: 4,
        whiteClip: 250,
      },
      params: {
        mode: 'dominant',
        dither: lightSmallPhoto ? 'atkinson' : 'fs',
      },
    };
  }

  /* ------------------------------------------------------------------ 抖动 */

  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const BAYER8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];

  function kernelFor(name) {
    if (name === 'fs') {
      return { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] };
    }
    if (name === 'atkinson') {
      return { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] };
    }
    if (name === 'stucki') {
      return {
        div: 42,
        taps: [
          [1, 0, 8], [2, 0, 4],
          [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
          [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
        ],
      };
    }
    return null;
  }

  function normalizeParams(input) {
    const p = Object.assign({
      mode: 'nearest',        // nearest | rule | duotone | dominant
      space: 'oklab',         // nearest: oklab | rgb
      dither: 'fs',           // none | fs | atkinson | stucki | bayer4 | bayer8
      strength: 1,            // 0..1
      serpentine: true,
      redBias: 0,             // -100..100，正数更爱用红墨
      warmOnly: true,
      warmGate: 60,
      dark: 64,
      light: 192,
      redScore: 42,
      redFirst: true,
      redSoft: 12,
      toneRed: 130,
    }, input || {});
    const s = +p.strength;
    p.strength = Number.isFinite(s) ? clamp(s, 0, 1) : 1;
    p.redBias = clamp(finite(p.redBias, 0), -100, 100);
    p.warmGate = clamp(finite(p.warmGate, 60), 0, 160);
    p.dark = clamp(Math.round(finite(p.dark, 64)), 1, 254);
    p.light = clamp(Math.round(finite(p.light, 192)), 2, 255);
    if (p.light <= p.dark) p.light = Math.min(255, p.dark + 1);
    p.redScore = clamp(Math.round(finite(p.redScore, 42)), 0, 255);
    p.redSoft = clamp(Math.round(finite(p.redSoft, 12)), 0, 80);
    p.toneRed = clamp(Math.round(finite(p.toneRed, 130)), 16, 220);
    if (!kernelFor(p.dither) && p.dither !== 'bayer4' && p.dither !== 'bayer8') p.dither = 'none';
    return p;
  }

  function redBiasCost(p) {
    // OKLab 距离平方大致 0..1.2；把 ±100 映射到 ±0.10，足够改变中间调判断。
    return (p.redBias / 100) * 0.10;
  }

  function warmEnough(score, r, gate) {
    return score >= gate && r >= 24;
  }

  /* 找到最近的两个墨色，并把当前颜色投影到它们的连线上。
   * 这不是"选一个最近的色"，而是得到两种墨的混合比例 t：
   *   t=0 → 全用 A，t=1 → 全用 B。
   * 之后的抖动只负责把这个比例变成疏密，因此一维误差扩散是稳定的。 */
  function pickTwoLab(L, a, b, palette, p, warm, out) {
    const pal = palette.lab;
    let ai = -1, bi = -1, da = Infinity, db = Infinity;
    const bias = redBiasCost(p);
    for (let k = 0; k < 3; k++) {
      if (k === RED && p.warmOnly && !warm) continue;
      const q = pal[k];
      const dl = L - q[0], dA = a - q[1], dB = b - q[2];
      let d = dl * dl + dA * dA + dB * dB;
      if (k === RED) d -= bias;
      if (d < da) { db = da; bi = ai; da = d; ai = k; }
      else if (d < db) { db = d; bi = k; }
    }
    if (ai < 0) { ai = BLACK; bi = WHITE; }
    if (bi < 0) bi = ai === BLACK ? WHITE : BLACK;
    out.a = ai; out.b = bi; out.t = 0;
  }

  function pickTwoRgb(r, g, b, palette, p, warm, out) {
    const pal = palette.rgb;
    let ai = -1, bi = -1, da = Infinity, db = Infinity;
    const bias = (p.redBias / 100) * 1600;
    for (let k = 0; k < 3; k++) {
      if (k === RED && p.warmOnly && !warm) continue;
      const q = pal[k];
      const dr = r - q[0], dg = g - q[1], dbb = b - q[2];
      let d = dr * dr + dg * dg + dbb * dbb;
      if (k === RED) d -= bias;
      if (d < da) { db = da; bi = ai; da = d; ai = k; }
      else if (d < db) { db = d; bi = k; }
    }
    if (ai < 0) { ai = BLACK; bi = WHITE; }
    if (bi < 0) bi = ai === BLACK ? WHITE : BLACK;
    const A = pal[ai], B = pal[bi];
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    const den = dx * dx + dy * dy + dz * dz;
    let t = 0;
    if (den > 1e-10) {
      t = ((r - A[0]) * dx + (g - A[1]) * dy + (b - A[2]) * dz) / den;
    }
    out.a = ai; out.b = bi; out.t = clamp(t, 0, 1);
  }

  /* 按 Rec601 亮度权重投影：黑/白混合时 t 就是 gray/255，
   * 和题目里的 gray 公式一致；蓝色不会因为 R=G=0 被当成"33% 白"。 */
  function projectRgbLuma(r, g, b, A, B) {
    const wr = 0.299, wg = 0.587, wb = 0.114;
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    const den = wr * dx * dx + wg * dy * dy + wb * dz * dz;
    if (den <= 1e-10) return 0;
    const num = wr * (r - A[0]) * dx + wg * (g - A[1]) * dy + wb * (b - A[2]) * dz;
    return clamp(num / den, 0, 1);
  }

  /* 有序抖动的阈值：0..1 均匀分布。strength=0 时退化为 0.5 硬阈值。 */
  function thresholdAt(name, x, y, strength, phase) {
    const m = name === 'bayer4' ? BAYER4 : BAYER8;
    const s = m.length;
    const px = (x + (phase || 0)) % s, py = (y + (phase || 0)) % s;
    const v = (m[py][px] + 0.5) / (s * s);
    return 0.5 + (v - 0.5) * strength;
  }

  function diffuseScalar(err, x, y, w, h, dir, kernel, e, skip) {
    const taps = kernel.taps, div = kernel.div;
    for (let t = 0; t < taps.length; t++) {
      const nx = x + dir * taps[t][0], ny = y + taps[t][1];
      if (nx < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (skip && skip[j]) continue;
      err[j] += e * (taps[t][2] / div);
    }
  }

  /* 一维误差扩散：把密度 0..1 变成 0/1。
   * skip 里的像素不参与（规则模式下已是红墨的点不再分黑白）。 */
  function ditherDensity(density, w, h, p, skip, out) {
    const kernel = kernelFor(p.dither);
    const err = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const dir = p.serpentine && (y & 1) ? -1 : 1;
      for (let xi = 0; xi < w; xi++) {
        const x = dir > 0 ? xi : w - 1 - xi;
        const i = y * w + x;
        if (skip && skip[i]) { out[i] = 0; continue; }
        const d = density[i];
        if (d <= 1e-5) { out[i] = 0; err[i] = 0; continue; }
        if (d >= 1 - 1e-5) { out[i] = 1; err[i] = 0; continue; }
        let v = d + err[i];
        v = clamp(v, -0.5, 1.5);
        const q = v > 0.5 ? 1 : 0;
        out[i] = q;
        const e = (v - q) * p.strength;
        if (e) diffuseScalar(err, x, y, w, h, dir, kernel, e, skip);
      }
    }
  }

  function nearest(w, h, rgb, lab, lum, score, palette, p) {
    const n = w * h;
    const codes = new Uint8Array(n);
    const oklab = p.space !== 'rgb';
    const useBayer = p.dither === 'bayer4' || p.dither === 'bayer8';
    const kernel = kernelFor(p.dither);
    const useError = !!kernel && p.strength > 0;
    const err = useError ? new Float32Array(n) : null;
    const two = { a: BLACK, b: WHITE, t: 0 };

    for (let y = 0; y < h; y++) {
      const dir = p.serpentine && (y & 1) ? -1 : 1;
      for (let xi = 0; xi < w; xi++) {
        const x = dir > 0 ? xi : w - 1 - xi;
        const i = y * w + x;
        const warm = warmEnough(score[i], rgb[i * 3], p.warmGate);
        if (oklab) {
          pickTwoLab(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], palette, p, warm, two);
          // 选色用 OKLab（感知），混合比用 sRGB（和题目里的 gray/FS 同一套数字）。
          // 否则 OKLab 的 L 会被当成"白墨比例"，中间调会明显偏亮。
          two.t = projectRgbLuma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2],
            palette.rgb[two.a], palette.rgb[two.b]);
        } else {
          pickTwoRgb(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], palette, p, warm, two);
        }
        if (p.dither === 'none' || p.strength <= 0 || (!useBayer && !useError)) {
          codes[i] = two.a;
          continue;
        }
        // 纯端点（纸白 / 实黑 / 纯红）不参与误差扩散：否则相邻深色区的
        // 残差会一直飘进白纸，最后把整片留白点脏。
        if (two.t <= 1e-4) { codes[i] = two.a; if (err) err[i] = 0; continue; }
        if (two.t >= 1 - 1e-4) { codes[i] = two.b; if (err) err[i] = 0; continue; }
        if (useBayer) {
          const th = thresholdAt(p.dither, x, y, p.strength, 0);
          codes[i] = two.t > th ? two.b : two.a;
          continue;
        }
        const v = clamp(two.t + err[i], -0.5, 1.5);
        const q = v > 0.5 ? 1 : 0;
        codes[i] = q ? two.b : two.a;
        const e = (v - q) * p.strength;
        if (e) diffuseScalar(err, x, y, w, h, dir, kernel, e, null);
      }
    }
    return codes;
  }

  function rule(w, h, lum, score, p) {
    const n = w * h;
    const codes = new Uint8Array(n);
    const mid = (p.dark + p.light) / 2;

    // 关抖动时保留用户最直观的硬规则：红度过线 → 红；否则按亮度两阈值。
    if (p.dither === 'none' || p.strength <= 0) {
      for (let i = 0; i < n; i++) {
        const L = lum[i], s = score[i];
        const inWindow = p.redFirst || (L >= p.dark && L <= p.light);
        if (s >= p.redScore && inWindow) codes[i] = RED;
        else if (L < p.dark) codes[i] = BLACK;
        else if (L > p.light) codes[i] = WHITE;
        else codes[i] = L >= mid ? WHITE : BLACK;
      }
      return codes;
    }

    // 连续密度：pRed 是红墨比例，pBlack 是"非红像素里黑墨的比例"。
    // 两者各自做一维抖动，互不抢误差，避免三维误差扩散在纯白区堆积。
    const pRed = new Float32Array(n);
    const pBlack = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = lum[i], s = score[i];
      let pr = smoothstep(p.redScore - p.redSoft, p.redScore + p.redSoft, s);
      if (!p.redFirst) {
        pr *= smoothstep(p.dark - p.redSoft, p.dark + p.redSoft, L);
        pr *= 1 - smoothstep(p.light - p.redSoft, p.light + p.redSoft, L);
      }
      pRed[i] = clamp(pr, 0, 1);
      pBlack[i] = clamp((p.light - L) / Math.max(1, p.light - p.dark), 0, 1);
    }

    if (p.dither === 'bayer4' || p.dither === 'bayer8') {
      const s = p.dither === 'bayer4' ? 4 : 8;
      const phase = s >> 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const th1 = thresholdAt(p.dither, x, y, p.strength, 0);
          const th2 = thresholdAt(p.dither, x, y, p.strength, phase);
          if (pRed[i] > th1) codes[i] = RED;
          else if (pBlack[i] > th2) codes[i] = BLACK;
          else codes[i] = WHITE;
        }
      }
      return codes;
    }

    const isRed = new Uint8Array(n);
    ditherDensity(pRed, w, h, p, null, isRed);
    const isBlack = new Uint8Array(n);
    ditherDensity(pBlack, w, h, p, isRed, isBlack);
    for (let i = 0; i < n; i++) codes[i] = isRed[i] ? RED : (isBlack[i] ? BLACK : WHITE);
    return codes;
  }

  function duotone(w, h, rgb, lum, palette, p) {
    const n = w * h;
    const codes = new Uint8Array(n);
    const tr = p.toneRed;
    const seg = { a: 0, b: 255, ca: BLACK, cb: WHITE, t: 0 };

    function segment(v) {
      if (v <= tr) {
        seg.a = 0; seg.b = tr; seg.ca = BLACK; seg.cb = RED;
        seg.t = tr > 0 ? clamp(v / tr, 0, 1) : 0;
      } else {
        seg.a = tr; seg.b = 255; seg.ca = RED; seg.cb = WHITE;
        seg.t = (255 - tr) > 0 ? clamp((v - tr) / (255 - tr), 0, 1) : 0;
      }
    }

    if (p.dither === 'none' || p.strength <= 0) {
      for (let i = 0; i < n; i++) {
        const v = lum[i];
        codes[i] = v < tr / 2 ? BLACK : (v < (tr + 255) / 2 ? RED : WHITE);
      }
      return codes;
    }

    if (p.dither === 'bayer4' || p.dither === 'bayer8') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          segment(lum[i]);
          const th = thresholdAt(p.dither, x, y, p.strength, 0);
          codes[i] = seg.t > th ? seg.cb : seg.ca;
        }
      }
      return codes;
    }

    const kernel = kernelFor(p.dither);
    const err = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const dir = p.serpentine && (y & 1) ? -1 : 1;
      for (let xi = 0; xi < w; xi++) {
        const x = dir > 0 ? xi : w - 1 - xi;
        const i = y * w + x;
        segment(lum[i]);
        if (seg.t <= 1e-5) { codes[i] = seg.ca; err[i] = 0; continue; }
        if (seg.t >= 1 - 1e-5) { codes[i] = seg.cb; err[i] = 0; continue; }
        const v = clamp(seg.t + err[i], -0.5, 1.5);
        const q = v > 0.5 ? 1 : 0;
        codes[i] = q ? seg.cb : seg.ca;
        const e = (v - q) * p.strength;
        if (e) diffuseScalar(err, x, y, w, h, dir, kernel, e, null);
      }
    }
    return codes;
  }

  function monochrome(w, h, rgb, p) {
    const density = new Float32Array(w * h);
    const codes = new Uint8Array(density.length);
    for (let i = 0; i < density.length; i++) {
      density[i] = clamp((0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255, 0, 1);
    }
    if (p.strength > 0 && kernelFor(p.dither)) {
      ditherDensity(density, w, h, p, null, codes);
    } else {
      const ordered = p.dither === 'bayer4' || p.dither === 'bayer8';
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const threshold = ordered ? thresholdAt(p.dither, x, y, p.strength, 0) : 0.5;
          codes[i] = density[i] > threshold ? WHITE : BLACK;
        }
      }
    }
    return codes;
  }

  function dominant(w, h, rgb, source, channel, p) {
    if (channel == null || !source) return monochrome(w, h, rgb, p);
    const lum = new Float32Array(w * h);
    const score = new Float32Array(w * h);
    for (let i = 0, j = 0, k = 0; i < lum.length; i++, j += 3, k += 4) {
      lum[i] = 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2];
      const r = source[k], g = source[k + 1], b = source[k + 2];
      const max = Math.max(r, g, b);
      if (source[k + channel] === max) score[i] = max - Math.min(r, g, b);
    }
    // 低彩度保留灰阶。鲜艳的主色直接落红墨，过渡色按彩度产生红点。
    return rule(w, h, lum, score, { ...p, redScore: 40, redSoft: 20, redFirst: true });
  }

  /**
   * 主量化入口。
   * @param {{w:number,h:number,rgb:Float32Array,palette:object,params:object,colorMode?:'bw'|'bwr',sourceRGBA?:Uint8ClampedArray,accentChannel?:number|null}} opts
   * @returns {Uint8Array} 每像素 code：0 黑 / 1 白 / 2 红
   */
  function quantize(opts) {
    const w = opts.w | 0, h = opts.h | 0, rgb = opts.rgb;
    const n = w * h;
    if (!rgb || rgb.length < n * 3) throw new Error('quantize: RGB buffer too small');
    const palette = opts.palette || makePalette();
    const p = normalizeParams(opts.params);
    if (opts.colorMode === 'bw') return monochrome(w, h, rgb, p);
    if (p.mode === 'dominant') return dominant(w, h, rgb, opts.sourceRGBA, opts.accentChannel, p);
    if (p.mode === 'duotone') {
      const lum = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      }
      return duotone(w, h, rgb, lum, palette, p);
    }
    const lab = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    const score = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      rgbToOklab(r, g, b, lab, i * 3);
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      score[i] = r - Math.max(g, b);
    }
    if (p.mode === 'rule') return rule(w, h, lum, score, p);
    return nearest(w, h, rgb, lab, lum, score, palette, p);
  }

  /* ------------------------------------------------------------------ 指标 */

  function crc16(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  function analyze(codes, rgb, w, h, palette) {
    const n = w * h;
    const count = [0, 0, 0];
    let transitions = 0, pairs = 0, isolated = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = codes[i];
        count[c]++;
        if (x + 1 < w) { pairs++; if (c !== codes[i + 1]) transitions++; }
        if (y + 1 < h) { pairs++; if (c !== codes[i + w]) transitions++; }
        if (c === RED) {
          let nb = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              if (codes[yy * w + xx] === RED) nb++;
            }
          }
          if (nb <= 1) isolated++;
        }
      }
    }

    // 红连通块：8 邻接，只统计含 >=2 px 的块，避免把抖动网点数成“块”。
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let redComponents = 0, largestRed = 0, redPixelsInBlocks = 0;
    for (let i = 0; i < n; i++) {
      if (codes[i] !== RED || seen[i]) continue;
      let top = 0;
      stack[top++] = i;
      seen[i] = 1;
      let size = 0;
      while (top) {
        const j = stack[--top];
        size++;
        const x = j % w, y = (j / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const k = yy * w + xx;
            if (codes[k] === RED && !seen[k]) { seen[k] = 1; stack[top++] = k; }
          }
        }
      }
      if (size >= 2) {
        redComponents++;
        redPixelsInBlocks += size;
        if (size > largestRed) largestRed = size;
      }
    }

    // 视觉误差：对源图与结果各做 5x5 均值，再在 OKLab 里算平均 ΔE。
    // 抖动图案本身不应被惩罚，所以先模糊；这个数越小说明明暗/色调越接近。
    const srcL = new Float32Array(n), srcA = new Float32Array(n), srcB = new Float32Array(n);
    const dstL = new Float32Array(n), dstA = new Float32Array(n), dstB = new Float32Array(n);
    const lab = new Float32Array(3);
    for (let i = 0; i < n; i++) {
      rgbToOklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, 0);
      srcL[i] = lab[0]; srcA[i] = lab[1]; srcB[i] = lab[2];
      const q = palette.rgb[codes[i]];
      rgbToOklab(q[0], q[1], q[2], lab, 0);
      dstL[i] = lab[0]; dstA[i] = lab[1]; dstB[i] = lab[2];
    }
    const r = 2;
    const bL = boxBlur(srcL, w, h, r), bA = boxBlur(srcA, w, h, r), bB = boxBlur(srcB, w, h, r);
    const cL = boxBlur(dstL, w, h, r), cA = boxBlur(dstA, w, h, r), cB = boxBlur(dstB, w, h, r);
    let sumDE = 0, maxDE = 0;
    for (let i = 0; i < n; i++) {
      const dL = bL[i] - cL[i], dA = bA[i] - cA[i], dB = bB[i] - cB[i];
      const de = Math.sqrt(dL * dL + dA * dA + dB * dB) * 100;
      sumDE += de;
      if (de > maxDE) maxDE = de;
    }

    let srcRed = 0;
    for (let i = 0; i < n; i++) {
      const rr = rgb[i * 3], gg = rgb[i * 3 + 1], bb = rgb[i * 3 + 2];
      if (rr - Math.max(gg, bb) >= 60) srcRed++;
    }

    return {
      count: count,
      coverage: [count[0] / n, count[1] / n, count[2] / n],
      transitions: pairs ? transitions / pairs : 0,
      isolatedRed: isolated,
      redComponents: redComponents,
      largestRed: largestRed,
      redPixelsInBlocks: redPixelsInBlocks,
      deltaE: sumDE / n,
      maxDeltaE: maxDE,
      sourceRedRatio: srcRed / n,
    };
  }

  /* ------------------------------------------------------------------ 打包 */

  function invertBytes(a) {
    for (let i = 0; i < a.length; i++) a[i] ^= 0xff;
  }

  /**
   * @param {Uint8Array} codes
   * @param {number} w @param {number} h
   * @param {{encoding?:'gateway'|'driver',invertBW?:boolean,invertRed?:boolean,colorMode?:'bw'|'bwr'}} opt
   *   gateway: 红像素 BW=0、RED=1（网关/prism_image 的线上格式）
   *   driver : 红像素 BW=1、RED=1（红点下面也铺白，直接喂控制器更稳）
   */
  function pack(codes, w, h, opt) {
    const o = Object.assign({ encoding: 'gateway', invertBW: false, invertRed: false }, opt || {});
    const stride = (w + 7) >> 3;
    const planeBytes = stride * h;
    const plane0 = new Uint8Array(planeBytes);
    const plane1 = o.colorMode === 'bw' ? null : new Uint8Array(planeBytes);
    const driver = plane1 && o.encoding === 'driver';
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let x = 0; x < w; x++) {
        const c = codes[y * w + x];
        const idx = row + (x >> 3), bit = 0x80 >> (x & 7);
        const white = driver ? (c !== BLACK) : (c === WHITE);
        if (white) plane0[idx] |= bit;
        if (plane1 && c === RED) plane1[idx] |= bit;
      }
    }
    if (o.invertBW) invertBytes(plane0);
    let data = plane0;
    if (plane1) {
      if (o.invertRed) invertBytes(plane1);
      data = new Uint8Array(planeBytes * 2);
      data.set(plane0, 0);
      data.set(plane1, planeBytes);
    }
    const crc0 = crc16(plane0);
    return {
      stride: stride,
      planeBytes: planeBytes,
      bytes: data.length,
      plane0: plane0,
      plane1: plane1,
      data: data,
      encoding: o.encoding,
      crc0: crc0,
      crc1: plane1 ? crc16(plane1) : null,
      crcAll: plane1 ? crc16(data) : crc0,
    };
  }

  /* ---------------------------------------------------------------- 小工具 */

  function codesToRGBA(codes, palette) {
    const n = codes.length;
    const out = new Uint8ClampedArray(n * 4);
    const pal = palette.rgb;
    for (let i = 0; i < n; i++) {
      const q = pal[codes[i]];
      out[i * 4] = q[0];
      out[i * 4 + 1] = q[1];
      out[i * 4 + 2] = q[2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  function rgbToRGBA(rgb) {
    const n = rgb.length / 3;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  return {
    VERSION,
    BLACK, WHITE, RED, INK_NAMES,
    clamp, smoothstep, hexToRgb, rgbToHex,
    rgbToOklab, oklabToRgb, makePalette,
    preprocess, boxBlur, recommend, colorMix,
    normalizeParams, quantize,
    analyze, pack, crc16,
    codesToRGBA, rgbToRGBA,
    BAYER4, BAYER8, kernelFor,
  };
});
