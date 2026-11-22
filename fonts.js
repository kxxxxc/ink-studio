/* Ink Studio — 字模：在本机把字体栅格化成 1 bit 字模，打成 FNT1 字库，再通过 BLE 写进 U5。
 *
 * 为什么在浏览器里做：价签要的是"16 px 一二级 + 24 px 一级"这种 545 KB 的包，而字形只有本机
 * 有（仿宋 / 楷体 / 宋体 / 黑体…）。所以这里用 canvas 的 fillText 当光栅器 —— 字体解析、hinting、
 * 抗锯齿浏览器已经做完了，我们只需要把灰度按阈值切成 1 bit，再按 FNT1 的格子摆好。格式、字表、
 * 校验全部在 fontpack.js（纯逻辑，node 可测）；这个文件只管 DOM 和 BLE。
 *
 * 与 tools/tag_assets/pack_fullfont.py 的关系：同一套区间、同一套格子、同一个阈值语义。两处刻意
 * 的差异：
 *   1. CLI 的 gb24l1 在 24 px 里多带 3 个"卡片白名单"汉字（+222 B）。网页端不抄那份白名单：这几个
 *      字会让固件用 16 px 放大补位（rfont_t.fb），看不出区别。
 *   2. 字节不会完全一样：PIL/FreeType 有 hinting（把 0.65 px 的竖笔对齐成整像素），canvas 没有，
 *      所以这里是 4 倍超采样后按"4×4 子像素相或"降采样，笔画会比 CLI 略粗一点。所以生成后一律用
 *      fontpack.verify() 按固件的方式重新解析一遍，长度 / 索引 / CRC 有任何一条不对就不让发。
 */
(function () {
  'use strict';

  const F = window.FNTPACK;
  const ble = window.INK_BLE;
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'ink-studio-fonts';
  const DEFAULT_THRESHOLD = 150;
  const BUILD_YIELD = 192;            /* 每 192 个字让出一次主线程 */
  const UPLOAD_YIELD = 24;            /* 每 24 个 BLE 包刷一次进度 */
  const SS = 4;                       /* 超采样倍数，见 makeRaster 的注释 */
  const SPACE_LIKE = new Set([0x20, 0x00A0, 0x3000]);
  const NOTDEF_CP = 0xE000;           /* 私用区：正常字体不会给它字模，画出来就是 .notdef */

  /* 常见中文字体。families 是同一个字体在 Windows / macOS / Android 上的名字，按顺序找第一个
   * 真装了的；一个都没有就在下拉框里标"未安装"。也可以直接载入本地的 .ttf/.otf。 */
  const FACES = [
    { id: 'fangsong', label: '仿宋', families: ['FangSong', 'STFangsong', 'FZFangSong-Z02S'] },
    { id: 'kaiti', label: '楷体', families: ['KaiTi', 'STKaiti', 'Kaiti SC'] },
    { id: 'songti', label: '宋体', families: ['SimSun', 'Songti SC', 'STSong', 'NSimSun'] },
    { id: 'heiti', label: '黑体', families: ['SimHei', 'Heiti SC', 'STHeiti'] },
    { id: 'yahei', label: '微软雅黑', families: ['Microsoft YaHei', 'Microsoft YaHei UI'] },
    { id: 'dengxian', label: '等线', families: ['DengXian'] },
    { id: 'noto-sans', label: '思源黑体 / Noto Sans SC',
      families: ['Noto Sans SC', 'Source Han Sans SC', 'Noto Sans CJK SC'] },
    { id: 'noto-serif', label: '思源宋体 / Noto Serif SC',
      families: ['Noto Serif SC', 'Source Han Serif SC', 'Noto Serif CJK SC'] },
    { id: 'lishu', label: '隶书', families: ['LiSu'] },
    { id: 'youyuan', label: '幼圆', families: ['YouYuan'] },
  ];

  /* 预设只有四档（用户在 2026-11-22 定的）：16 px / 24 px 不再单独挑，ASCII 和符号跟着走。
   * id / 覆盖范围在 fontpack.js 里（PRESETS），这边只负责把体积算出来写进下拉框。 */
  const PRESET_BYTES = new Map();

  function presetList() {
    return F.PRESETS;
  }

  function presetOf(id) {
    const list = presetList();
    const pick = list.find((p) => p.id === id) ||
      list.find((p) => p.id === F.DEFAULT_PRESET) || list[0];
    return pick;
  }

  function presetBytes(preset) {
    if (!PRESET_BYTES.has(preset.id)) PRESET_BYTES.set(preset.id, F.plan(F.specs(preset.cov)).bytes);
    return PRESET_BYTES.get(preset.id);
  }

  const PREVIEW_TEXT = '杭州小雨休班11月宜忌晴';
  const ZOOM_MIN = 2;
  const ZOOM_MAX = 10;
  const ZOOM_DEFAULT = 4;
  const PREVIEW_WIDTH = 1200;                 /* 上限；实际按面板宽度取（见 previewWidth） */

  let localFaces = [];                /* 从文件载入的字体 [{ id, label, family }] */
  let detectCache = new Map();        /* family -> 装没装 */
  let blob = null;                    /* 最近一次生成的包 */
  let built = null;                   /* 最近一次生成的摘要（verify 的结果） */
  let link = null;
  let generating = false;
  let uploading = false;
  let previewToken = 0;

  /* --------------------------------------------------------------- 小工具 --- */
  function status(node, message, kind) {
    const el = $(node);
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
    el.className = 'ble-status' + (kind ? ' ' + kind : '');
  }

  function nextFrame() {
    return new Promise((resolve) => {
      if (document.hidden) setTimeout(resolve, 0);
      else requestAnimationFrame(() => resolve());
    });
  }

  function thresholdValue() {
    return Number($('fontThresh').value) || DEFAULT_THRESHOLD;
  }

  function kv(node, rows) {
    $(node).replaceChildren(...rows.map(([key, value, kind]) => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = key;
      const b = document.createElement('b');
      b.textContent = value;
      if (kind) b.className = kind;
      div.append(span, b);
      return div;
    }));
  }

  /* ------------------------------------------------------------- 字体探测 --- */
  /* "画一个汉字再看像素"判断字体装没装。document.fonts.check() 不可靠：未知字体族也返回 true
   * （有兜底字体）；量宽度又会被等宽兜底蒙住。所以用默认兜底画一遍当基线，逐像素比。 */
  let probeCanvas = null;
  let probeCtx = null;

  function probeRender(family) {
    if (!probeCanvas) {
      probeCanvas = document.createElement('canvas');
      probeCanvas.width = 48;
      probeCanvas.height = 48;
      probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
    }
    probeCtx.fillStyle = '#fff';
    probeCtx.fillRect(0, 0, 48, 48);
    probeCtx.fillStyle = '#000';
    probeCtx.textBaseline = 'alphabetic';
    probeCtx.font = '40px ' + (family ? '"' + family + '", __ink_missing__' : '__ink_missing__');
    probeCtx.fillText('永', 2, 40);
    return probeCtx.getImageData(0, 0, 48, 48).data;
  }

  function samePixels(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function installed(family) {
    if (detectCache.has(family)) return detectCache.get(family);
    const ok = !samePixels(probeRender(null), probeRender(family));
    detectCache.set(family, ok);
    return ok;
  }

  function resolveFace(face) {
    for (const family of face.families) if (installed(family)) return family;
    return null;
  }

  function faceOptions() {
    const options = FACES.map((face) => {
      const family = resolveFace(face);
      return { value: 'face:' + face.id, family, label: face.label, ok: !!family };
    });
    for (const local of localFaces) {
      options.push({ value: 'local:' + local.id, family: local.family, label: local.label, ok: true, local: true });
    }
    return options;
  }

  function renderFaceSelect() {
    const select = $('fontFace');
    const good = document.createElement('optgroup');
    const bad = document.createElement('optgroup');
    good.label = '本机可用';
    bad.label = '未安装';
    for (const option of faceOptions()) {
      const el = new Option(option.label, option.value);
      el.dataset.family = option.family || '';
      el.dataset.ok = option.ok ? '1' : '0';
      (option.ok ? good : bad).append(el);
    }
    select.replaceChildren();
    if (good.children.length) select.append(good);
    if (bad.children.length) select.append(bad);
    const saved = load();
    const want = saved && saved.face;
    const pick = [...select.options].find((o) => o.value === want && o.dataset.ok === '1') ||
      select.options[0];
    if (pick) select.value = pick.value;
  }

  function currentFamily() {
    const select = $('fontFace');
    const option = select.options[select.selectedIndex];
    return option && option.dataset.ok === '1' ? option.dataset.family : '';
  }

  function currentFaceId() {
    const select = $('fontFace');
    return select.options[select.selectedIndex]?.value || '';
  }

  /* --------------------------------------------------------------- 光栅器 --- */
  /* 一个区间的光栅化分三步：
   *   1. 定字号：从格子高往下试，直到整段字的墨迹都装进格子（pack_pak2.pick_size 的判据，那边用
   *      PIL 量，这里用 canvas 自己的字体度量 actualBoundingBox*，所以 3755 个字也只要几十毫秒）。
   *   2. 定基线：只按汉字的墨迹上下沿把整段字垂直居中（半角/符号区间没有汉字，就用全部）。
   *   3. 每个字画一次 4 倍图，水平居中、按共享基线放进格子，压成 1 bit。
   *
   * 为什么先画 4 倍再降采样：16 px 仿宋的竖笔只有 ~0.65 px 粗，Chrome 会把它摊到相邻两列、每列
   * 30% 覆盖（亮度 178），直接按阈值二值化就把竖笔切成一串虚线 —— 实测 中/永/休 全是这个毛病。
   * PIL 走 FreeType 有 hinting，所以 CLI 打的包没有这个问题。这里用 4 倍超采样 + "4×4 子像素里
   * 只要有一个过阈值就算有墨"，把被摊薄的笔画还原成连续 1 px。
   *
   * 缺字（和 .notdef 一模一样）不放进去 —— 放进去就是画方框，而丢掉它会让固件走 rfont_t.fb 的
   * 16 px 放大；空白字（空格、全角空格）必须留着，否则固件会把它画成一个 1 px 方框。
   *
   * 加粗（bold）是真的改字模，不是预览特效：1 bit 的每个字节向右再或一次，也就是把笔画统一
   * 加宽 1 px（从左往右长）。仿宋在 16 px 上只有 ~0.65 px 的竖笔，加粗之后在屏上明显实一些；
   * 代价是密排的字（「藏」「疆」这种）容易糊，所以默认不开，由用户自己看着预览决定。 */
  function makeRaster(family, threshold, bold) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function setFont(px) {
      ctx.font = (px * SS) + 'px "' + family + '"';
    }

    /* 墨迹框，单位＝目标像素，相对笔位：(left, top) 可为负，(right, bottom) 相对笔位。 */
    function metricsOf(cp, px) {
      setFont(px);
      const m = ctx.measureText(String.fromCodePoint(cp));
      return {
        left: -m.actualBoundingBoxLeft / SS,
        right: m.actualBoundingBoxRight / SS,
        top: -m.actualBoundingBoxAscent / SS,
        bottom: m.actualBoundingBoxDescent / SS,
      };
    }

    function choosePx(cps, cw, ch) {
      for (let px = ch; px >= 8; px--) {
        let fits = true;
        for (let i = 0; i < cps.length; i++) {
          const m = metricsOf(cps[i], px);
          if (m.right - m.left <= 0.05 || m.bottom - m.top <= 0.05) continue;
          if (m.right - m.left > cw + 0.5 || m.bottom - m.top > ch + 0.5) { fits = false; break; }
        }
        if (!fits) continue;
        const span = (ideograph) => {
          let top = 1e9;
          let bottom = -1e9;
          for (let i = 0; i < cps.length; i++) {
            const cp = cps[i];
            if (ideograph && (cp < 0x4E00 || cp > 0x9FFF)) continue;
            const m = metricsOf(cp, px);
            if (m.bottom - m.top <= 0.05) continue;
            if (m.top < top) top = m.top;
            if (m.bottom > bottom) bottom = m.bottom;
          }
          return top > bottom ? null : { top, bottom };
        };
        const box = span(true) || span(false);
        if (!box) return { px, baseline: Math.round(ch * 0.86) };
        return { px, baseline: Math.round((ch - (box.bottom - box.top)) / 2 - box.top) };
      }
      throw new Error(`${cw}×${ch} 的格子里放不下这个字体（缩到 8 px 还超）`);
    }

    /* 摆进格子并压成 1 bit：水平居中、按共享基线落位，每个目标像素由 4×4 子像素相或。 */
    function packGlyph(cp, px, cw, ch, baseline) {
      const stride = F.strideOf(cw);
      const bits = new Uint8Array(stride * ch);
      const m = metricsOf(cp, px);
      const w = m.right - m.left;
      const h = m.bottom - m.top;
      if (w <= 0.05 || h <= 0.05) return { bits, clipped: 0, blank: true };

      const width = (cw + 2 * px) * SS;
      const height = (2 * ch + 8) * SS;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ox = px * SS;
      const oy = (ch + 4) * SS;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      setFont(px);
      ctx.fillText(String.fromCodePoint(cp), ox, oy);
      const data = ctx.getImageData(0, 0, width, height).data;

      /* 笔位在目标格子的 (0, ch+4)：dx 让墨迹水平居中，dy 是共享基线（与具体是什么字无关）。 */
      const dx = Math.round((cw - w) / 2 - (px + m.left));
      const dy = baseline - (ch + 4);
      const cx0 = Math.floor(px + m.left + dx);
      const cx1 = Math.ceil(px + m.left + dx + w);
      const cy0 = Math.floor(ch + 4 + m.top + dy);
      const cy1 = Math.ceil(ch + 4 + m.top + dy + h);
      let clipped = 0;
      for (let cy = cy0; cy < cy1; cy++) {
        for (let cx = cx0; cx < cx1; cx++) {
          const sx0 = (cx - dx) * SS;
          const sy0 = (cy - dy) * SS;
          let on = false;
          for (let sy = 0; sy < SS && !on; sy++) {
            const syAbs = sy0 + sy;
            if (syAbs < 0 || syAbs >= height) continue;
            const row = syAbs * width;
            for (let sx = 0; sx < SS && !on; sx++) {
              const sxAbs = sx0 + sx;
              if (sxAbs < 0 || sxAbs >= width) continue;
              const at = (row + sxAbs) * 4;
              if ((data[at] * 299 + data[at + 1] * 587 + data[at + 2] * 114) / 1000 <= threshold) on = true;
            }
          }
          if (!on) continue;
          if (cy < 0 || cy >= ch || cx < 0 || cx >= cw) { clipped++; continue; }
          bits[cy * stride + (cx >> 3)] |= 0x80 >> (cx & 7);
        }
      }
      if (bold) {
        /* 右移一位再或回去：每行从右往左走，读到的左邻格永远还是原值。 */
        for (let gy = 0; gy < ch; gy++) {
          const row = gy * stride;
          for (let gx = cw - 1; gx >= 1; gx--) {
            const left = row + ((gx - 1) >> 3);
            if (!(bits[left] & (0x80 >> ((gx - 1) & 7)))) continue;
            bits[row + (gx >> 3)] |= 0x80 >> (gx & 7);
          }
        }
      }
      return { bits, clipped };
    }

    return { choosePx, packGlyph, metricsOf };
  }

  /* 一段区间 -> 筛掉缺字的字模。每 BUILD_YIELD 个字让出主线程，进度条才动得起来。 */
  async function rasterizeRange(raster, spec, onTick) {
    const { cw, ch } = spec;
    const { px, baseline } = raster.choosePx(spec.cps, cw, ch);
    const notdef = raster.packGlyph(NOTDEF_CP, px, cw, ch, baseline);
    const glyphs = [];
    const missing = [];
    let clipped = 0;
    for (let i = 0; i < spec.cps.length; i++) {
      const cp = spec.cps[i];
      const g = raster.packGlyph(cp, px, cw, ch, baseline);
      if (g.clipped) clipped++;
      const blank = g.bits.every((byte) => byte === 0);
      const isNotdef = !notdef.blank && !blank && samePixels(g.bits, notdef.bits);
      if (isNotdef || (blank && !SPACE_LIKE.has(cp))) missing.push(cp);
      else glyphs.push({ cp, bits: g.bits });
      if ((i + 1) % BUILD_YIELD === 0) {
        onTick(i + 1);
        await nextFrame();
      }
    }
    onTick(spec.cps.length);
    return { name: spec.name, cw, ch, kind: spec.kind, cps: spec.cps, baseline, px, glyphs, missing, overflow: clipped };
  }

  /* ------------------------------------------------------------ 覆盖与预算 --- */
  /* 只有一个入口：下拉框里选一档预设。不再有"16 px 选什么、24 px 选什么"这种组合 ——
   * 组合爆炸会把固件没验证过的形状（比如只有符号的 24 px 槽）放进包里。 */
  function currentPreset() {
    return presetOf($('fontPreset').value);
  }

  function coverage() {
    return currentPreset().cov;
  }

  /* 这条预设有哪几个字面（16 / 24），预览按这个排行。 */
  function activeSizes() {
    const cov = Object.assign({}, F.COVERAGE, coverage());
    const sizes = [];
    if (cov.cjk16 !== 'off') sizes.push(16);
    if (cov.cjk24 !== 'off') sizes.push(24);
    return sizes;
  }

  /* 传输时间只能估：一包 = MTU-5 字节，桌面 Windows 上大约 30–50 ms 一包。写完会显示实测速率。 */
  function estimateUpload(bytes) {
    const packets = Math.ceil(bytes / 240);
    const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);
    return `${fmt(Math.round(packets * 0.03))} – ${fmt(Math.round(packets * 0.05))}`;
  }

  function updatePlan() {
    const preset = currentPreset();
    const cov = Object.assign({}, F.COVERAGE, preset.cov);
    const plan = F.plan(F.specs(preset.cov));
    const names = {
      gb2312: 'GB2312 一二级', gb2312L1: 'GB2312 一级',
      cjkBlock: 'CJK 基本区', off: '不要',
    };
    const describe = (key, extra) => (key === 'off' ? '不要（这一级不打包）' : names[key] + extra);
    const problem = !plan.fits
      ? `放不下：${F.kb(plan.bytes)} 超过字库区 ${F.kb(F.FONT_MAX)}`
      : plan.tooManyPerSlot.length ? `每个字号最多 ${F.MAX_RANGES_PER_SLOT} 段，少选几项`
        : '';
    kv('fontPlan', [
      ['16 px', describe(cov.cjk16, ' + 半角 ASCII + 标点符号'), ''],
      ['24 px', describe(cov.cjk24, ' + 半角 ASCII + 标点符号'), ''],
      ['区间 / 字数', `${plan.ranges.length} 段 / ${plan.glyphs.toLocaleString()} 字`, ''],
      ['体积', `${F.kb(plan.bytes)}（${plan.bytes.toLocaleString()} B）`, problem ? 'bad' : ''],
      ['落点', `U5 0x${F.hex(F.FONT_BASE, 6).slice(2)} – 0x${F.hex(F.FONT_BASE + plan.bytes, 6).slice(2)}`, ''],
      ['字库区余量', plan.fits ? `${F.kb(plan.headroom)} / ${F.kb(F.FONT_MAX)}` : '超出', ''],
      ['预计上传', plan.fits ? estimateUpload(plan.bytes) : '—', ''],
    ]);
    $('fontBuild').disabled = generating || uploading || !!problem;
    return { plan, problem };
  }

  /* ------------------------------------------------------------------ 预览 --- */
  /* 预览就是价签上的字模：一格一个 1 bit 字面，格子边框画出来，格子里的每个小方点就是一个像素，
   * 所以"这个字在格子里占多满"是能数出来的（每格下面标了墨迹占比）。放大倍数只改画多大，
   * 不改字模；加粗会真的改字模 —— 预览看到的就是要打进去的那份。 */
  function zoomValue() {
    const raw = Number($('fontZoom') && $('fontZoom').value);
    if (!Number.isFinite(raw)) return ZOOM_DEFAULT;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(raw)));
  }

  function boldOn() {
    return !!($('fontBold') && $('fontBold').checked);
  }

  /* 排成"每个字号若干行"：每行放得下几个就放几个，一个格子的边长是 size×zoom。
   * 画布宽度取面板的实际宽度（1 画布像素 = 1 CSS 像素），这样点阵不会被 CSS 缩放拉花：
   * 3 px 的点被缩到 2.2 px 之后，16 px 的竖笔看起来就像虚线了。 */
  function previewLayout(sizes, zoom, chars, width) {
    const pad = 12;
    const labelW = 32;
    const gap = Math.max(6, Math.round(zoom * 1.5));
    const labelH = 15;
    const lines = [];
    let y = pad;
    for (const size of sizes) {
      const cell = size * zoom;
      const step = cell + gap;
      const per = Math.max(1, Math.floor((width - pad * 2 - labelW + gap) / step));
      for (let at = 0; at < chars.length; at += per) {
        lines.push({
          size, y, cell,
          cells: chars.slice(at, at + per).map((ch, i) => ({ cp: ch.codePointAt(0), x: pad + labelW + i * step })),
        });
        y += cell + labelH;
      }
      y += gap;
    }
    return { lines, width, height: Math.max(48, y + pad - gap) };
  }

  function previewWidth(canvas) {
    const host = canvas.parentElement;
    if (!host) return PREVIEW_WIDTH;
    /* 从面板的 content box 算，不能从画布自己的 rect 算 —— 画布宽度一变 rect 就跟着变，
     * 每次重画都少 2 px，几十次之后预览就成了一条。 */
    const style = window.getComputedStyle(host);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const avail = host.clientWidth - padL - padR - 2;        /* 减掉画布自己的 1 px 边框 */
    if (avail >= 320) return Math.min(PREVIEW_WIDTH, Math.round(avail));
    return PREVIEW_WIDTH;
  }

  async function drawPreview() {
    const canvas = $('fontPreview');
    const ctx = canvas.getContext('2d');
    const token = ++previewToken;
    const family = currentFamily();
    const zoom = zoomValue();
    const bold = boldOn();
    const sizes = activeSizes();
    if ($('fontZoomOut')) $('fontZoomOut').textContent = zoom + '×';
    if (!family) {
      canvas.width = previewWidth(canvas);
      canvas.height = 48;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#a32432';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('这个字体没装：换一个，或「载入字体文件…」', 12, 30);
      $('fontFaceHint').textContent = '本机找不到这个字体族，生成出来会是空包。';
      return;
    }

    const chars = [...PREVIEW_TEXT];
    const raster = makeRaster(family, thresholdValue(), bold);
    const layout = previewLayout(sizes, zoom, chars, previewWidth(canvas));
    canvas.width = layout.width;
    canvas.height = layout.height;
    canvas.dataset.zoom = String(zoom);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    /* 每个字号定一次字号/基线（和打包时同一个判据）。 */
    const picks = new Map();
    for (const size of sizes) {
      try {
        picks.set(size, raster.choosePx(chars.map((ch) => ch.codePointAt(0)), size, size));
      } catch (error) {
        $('fontFaceHint').textContent = error.message;
        return;
      }
    }

    let inkPixels = 0;
    let cellArea = 0;
    let glyphs = 0;
    for (const line of layout.lines) {
      if (token !== previewToken) return;
      const pick = picks.get(line.size);
      const stride = F.strideOf(line.size);
      const dot = zoom >= 4 ? zoom - 1 : zoom;    /* 每个像素留 1 px 缝，点阵看得出来 */
      ctx.fillStyle = '#8a8f9c';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(line.size + 'px', 6, line.y + line.cell - 2);
      for (const item of line.cells) {
        const g = raster.packGlyph(item.cp, pick.px, line.size, line.size, pick.baseline);
        ctx.fillStyle = '#14181f';
        let on = 0;
        for (let gy = 0; gy < line.size; gy++) {
          for (let gx = 0; gx < line.size; gx++) {
            if (!(g.bits[gy * stride + (gx >> 3)] & (0x80 >> (gx & 7)))) continue;
            on++;
            ctx.fillRect(item.x + gx * zoom, line.y + gy * zoom, dot, dot);
          }
        }
        ctx.strokeStyle = '#b9c0d0';
        ctx.lineWidth = 1;
        ctx.strokeRect(item.x + 0.5, line.y + 0.5, line.cell, line.cell);
        const pct = (100 * on) / (line.size * line.size);
        ctx.fillStyle = '#8a8f9c';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillText(`${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`, item.x + 1, line.y + line.cell + 11);
        inkPixels += on;
        cellArea += line.size * line.size;
        glyphs++;
      }
      await nextFrame();
    }
    if (token !== previewToken) return;
    const ink = glyphs ? ((100 * inkPixels) / cellArea).toFixed(1) : '0';
    $('fontFaceHint').textContent = `${family} · ${bold ? '加粗 · ' : ''}阈值 ${thresholdValue()}`
      + ` · ${glyphs} 个字面 · 墨迹平均 ${ink}%（格子下面的百分比就是这个字的占比）`;
  }

  /* ------------------------------------------------------------------ 生成 --- */
  async function buildNow() {
    if (generating) return;
    const family = currentFamily();
    if (!family) throw new Error('先选一个本机装了的字体');
    const { problem } = updatePlan();
    if (problem) throw new Error(problem);
    generating = true;
    $('fontBuild').disabled = true;
    $('fontDownload').disabled = true;
    $('fontUpload').disabled = true;
    blob = null;
    built = null;
    kv('fontResult', []);
    $('fontBuildProgress').hidden = false;
    $('fontBuildProgress').value = 0;
    const started = Date.now();
    try {
      const list = F.specs(coverage());
      const bold = boldOn();
      const raster = makeRaster(family, thresholdValue(), bold);
      const total = list.reduce((n, spec) => n + spec.cps.length, 0);
      const results = [];
      let done = 0;
      for (const spec of list) {
        status('fontBuildStatus', `正在光栅化 ${spec.name}（${spec.cw}×${spec.ch}，${spec.cps.length.toLocaleString()} 字）…`);
        results.push(await rasterizeRange(raster, spec, (n) => {
          $('fontBuildProgress').value = (done + n) / total;
        }));
        done += spec.cps.length;
      }
      status('fontBuildStatus', '正在打包并按固件的方式校验…');
      $('fontBuildProgress').value = 1;
      built = F.finish(results);
      blob = built.blob;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const missingTotal = built.missing.reduce((n, m) => n + m.cps.length, 0);
      /* 几十个字的毛边被格子裁 1 px 是正常的，只有成片被裁才值得标红。 */
      const clippedBad = built.overflow > built.table.glyphs * 0.02;
      kv('fontResult', [
        ['字体', family, ''],
        ['预设', currentPreset().label, ''],
        ['加粗', bold ? '是（笔画加宽 1 px）' : '否', ''],
        ['体积', `${F.kb(blob.length)}（${blob.length.toLocaleString()} B）`, ''],
        ['区间 / 字数', `${built.table.ranges.length} 段 / ${built.table.glyphs.toLocaleString()} 字`, ''],
        ['缺字', missingTotal ? `${missingTotal.toLocaleString()} 个（字体里没有，已丢字）` : '无',
          missingTotal > 50 ? 'bad' : ''],
        ['边缘被裁', built.overflow ? `${built.overflow.toLocaleString()} 个字（1 px 毛边）` : '无',
          clippedBad ? 'bad' : ''],
        ['耗时', `${secs} s`, ''],
        ['CRC32', F.hex(F.crc32(blob), 8), ''],
        ['校验', '目录 CRC / 索引有序 / 地址与包尾全对', 'good'],
      ]);
      const detail = built.missing.filter((m) => m.cps.length)
        .map((m) => `${m.range} 缺 ${m.cps.length} 个（首个 ${String.fromCodePoint(m.cps[0])}）`);
      status('fontBuildStatus', `生成完成：${F.kb(blob.length)}，${built.table.glyphs.toLocaleString()} 字，${secs} s。`
        + (detail.length ? ` ${detail.join('；')}。` : ' 没有缺字。')
        + ' 可以下载存档，或直接写进价签。', 'good');
      $('fontDownload').disabled = false;
    } finally {
      generating = false;
      $('fontBuildProgress').hidden = true;
      updatePlan();
      updateControls();
    }
  }

  function download() {
    if (!blob) return;
    const family = (currentFamily() || 'font').replace(/[^\w.-]+/g, '_');
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ink-font-${family}-${blob.length}.fnt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------------ 写入 --- */
  function be32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  }

  function be16(bytes, at) {
    return (bytes[at] << 8) | bytes[at + 1];
  }

  async function upload() {
    if (uploading) return;
    if (!blob) throw new Error('先生成字库');
    if (!ble || !ble.isConnected()) throw new Error('先连接价签');
    uploading = true;
    updateControls();
    $('fontProgress').hidden = false;
    $('fontProgress').value = 0;
    const size = blob.length;
    const crc = F.crc32(blob);
    const started = Date.now();
    try {
      status('fontStatus', '正在查询 ATT MTU…');
      const mtu = await ble.queryMtu();
      const payload = Math.min(242, mtu - 5);
      if (payload < 20) throw new Error(`ATT MTU 只有 ${mtu}，一包装不下数据`);
      const plan = F.uploadPlan(size, payload);
      status('fontStatus', `写入 U5 0x${F.hex(F.FONT_BASE, 6).slice(2)}：${F.kb(size)}，`
        + `${plan.packets.toLocaleString()} 包（每包 ${payload} B）…`);
      const ack = await ble.command(F.beginFrame(F.FONT_UPLOAD_ADDR, size, crc),
        (p) => p[0] === 0xC7 && p.length >= 9, 20000, '0x47 开始');
      if (ack[1] !== 1) {
        throw new Error(`价签拒绝了这次写入（它解析到地址 0x${be32(ack, 2).toString(16)}、长度 ${be32(ack, 6)}）`);
      }
      if (be32(ack, 2) !== F.FONT_UPLOAD_ADDR || be32(ack, 6) !== size) {
        throw new Error(`价签回显的地址/长度不对：0x${be32(ack, 2).toString(16)} / ${be32(ack, 6)}`);
      }
      let sent = 0;
      for (let at = 0; at < size; at += payload) {
        await ble.writeWithResponse(F.dataFrame(blob.subarray(at, Math.min(size, at + payload))));
        sent = Math.min(size, at + payload);
        $('fontProgress').value = sent / size;
        if ((at / payload) % UPLOAD_YIELD === 0) {
          const rate = sent / Math.max(0.05, (Date.now() - started) / 1000);
          const left = Math.ceil((size - sent) / Math.max(1, rate));
          status('fontStatus', `已写 ${(100 * sent / size).toFixed(1)}% · ${(rate / 1024).toFixed(1)} KB/s`
            + ` · 还有约 ${left} s`);
          await nextFrame();
        }
      }
      status('fontStatus', '正在提交：价签会逐页回读比对，再算整包 CRC…');
      const done = await ble.command(F.COMMIT_FRAME, (p) => p[0] === 0xC7 && p.length >= 7, 90000, '0x47 提交');
      const got = be32(done, 2);
      const bad = be16(done, 5);
      if (done[1] !== 0 || got !== size || bad) {
        const reason = ['', '没在传输中', '长度 / CRC / 回读不一致'][done[1]] || `状态 ${done[1]}`;
        throw new Error(`提交失败：${reason}；已收 ${got.toLocaleString()} / ${size.toLocaleString()} B，坏页 ${bad}`);
      }
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      $('fontProgress').value = 1;
      status('fontStatus', `写完了：${F.kb(size)} 全部逐页回读一致（${secs} s，CRC ${F.hex(crc, 8)}）。`
        + ' 现在给价签断电重启 —— 字库只在开机那一次加载（pak_init_u5），重启前画的还是旧字库。', 'good');
    } finally {
      uploading = false;
      updateControls();
      setTimeout(() => { $('fontProgress').hidden = true; }, 5000);
    }
  }

  /* -------------------------------------------------------------- 本地字体 --- */
  async function loadFontFile(file) {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const family = 'ink-local-' + Date.now().toString(36);
    const face = new FontFace(family, buffer);
    try {
      await face.load();
    } catch {
      throw new Error(`${file.name} 载入失败 —— 字体集（.ttc）一般不支持，改用字体名选`);
    }
    document.fonts.add(face);
    detectCache.set(family, true);
    localFaces.push({ id: family, label: file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, ''), family });
    renderFaceSelect();
    const option = [...$('fontFace').options].find((o) => o.dataset.family === family);
    if (option) $('fontFace').value = option.value;
    invalidate('换了字体');
    persist();
    updatePlan();
    await drawPreview();
    return family;
  }

  /* -------------------------------------------------------------- 控件状态 --- */
  function updateControls() {
    const connected = !!(link && link.connected);
    $('fontConnect').hidden = connected;
    $('fontConnect').disabled = uploading || !(link && link.canConnect);
    $('fontDisconnect').hidden = !connected;
    $('fontDisconnect').disabled = uploading || !connected;
    $('fontUpload').disabled = uploading || generating || !blob || !connected;
    $('fontBuild').disabled = generating || uploading;
    $('fontLinkBadge').textContent = connected ? (link.name || 'ESL 价签') : '未连接';
    $('fontLinkBadge').classList.toggle('ble-connected', connected);
    const hint = link && !link.canConnect
      ? '蓝牙直连需要 HTTPS（或 localhost）和支持 Web Bluetooth 的 Chrome / Edge；生成字库不需要蓝牙。'
      : '';
    $('fontSupport').hidden = !hint;
    $('fontSupport').textContent = hint;
  }

  /* 换了字体 / 阈值 / 预设 / 加粗，手里的包就不再是屏幕上写的那份了 —— 作废掉，
   * 免得把旧参数打的包写进 U5。放大只影响预览，不作废。 */
  function invalidate(reason) {
    if (!blob || generating || uploading) return;
    blob = null;
    built = null;
    kv('fontResult', []);
    $('fontDownload').disabled = true;
    updateControls();
    status('fontBuildStatus', `${reason}，重新生成一次再写。`, 'bad');
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        face: currentFaceId(), threshold: thresholdValue(),
        preset: currentPreset().id, bold: boldOn(), zoom: zoomValue(),
      }));
    } catch { /* 存储被禁用时表单照样能用 */ }
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data) return null;
      return {
        face: typeof data.face === 'string' ? data.face : '',
        threshold: Number(data.threshold) || 0,
        preset: typeof data.preset === 'string' ? data.preset : '',
        bold: !!data.bold,
        zoom: Number(data.zoom) || 0,
      };
    } catch {
      return null;
    }
  }

  /* 下拉框里的体积是现算的（plan 的字节数），所以预设一改大小这里就跟着变，不会写死。 */
  function renderPresetSelect() {
    const select = $('fontPreset');
    const options = presetList().map((preset) =>
      new Option(`${preset.label}（${F.kb(presetBytes(preset))}）`, preset.id));
    select.replaceChildren(...options);
    const saved = load();
    select.value = presetOf(saved && saved.preset).id;
  }

  function restore() {
    const saved = load();
    if (saved && saved.threshold >= 90 && saved.threshold <= 210) $('fontThresh').value = String(saved.threshold);
    $('fontThreshOut').textContent = String(thresholdValue());
    if (saved && saved.zoom >= ZOOM_MIN && saved.zoom <= ZOOM_MAX) $('fontZoom').value = String(saved.zoom);
    $('fontZoomOut').textContent = zoomValue() + '×';
    if (saved) $('fontBold').checked = saved.bold;
  }

  function applyPreset(id) {
    $('fontPreset').value = presetOf(id).id;
    invalidate('换了预设');
    persist();
    updatePlan();
    drawPreview().catch(() => {});
  }

  /* ------------------------------------------------------------------ 绑定 --- */
  const run = (action, output) => (event) => {
    if (event) event.preventDefault();
    status(output, '');
    return Promise.resolve().then(action)
      .catch((error) => status(output, String((error && error.message) || error), 'bad'));
  };

  function bind() {
    if (!$('fontFace')) return;
    renderFaceSelect();
    renderPresetSelect();
    restore();
    updatePlan();
    drawPreview().catch(() => {});
    updateControls();
    $('fontRefresh').addEventListener('click', () => {
      detectCache = new Map();
      for (const local of localFaces) detectCache.set(local.family, true);
      renderFaceSelect();
      updatePlan();
      drawPreview().catch(() => {});
    });
    $('fontFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      loadFontFile(file).catch((error) => status('fontBuildStatus', error.message, 'bad'));
    });
    $('fontFace').addEventListener('change', () => {
      invalidate('换了字体');
      persist();
      updatePlan();
      drawPreview().catch(() => {});
    });
    $('fontPreset').addEventListener('change', (event) => applyPreset(event.target.value));
    $('fontBold').addEventListener('change', () => {
      invalidate('加粗改了');
      persist();
      drawPreview().catch(() => {});
    });
    $('fontZoom').addEventListener('input', () => {
      $('fontZoomOut').textContent = zoomValue() + '×';
      persist();
      drawPreview().catch(() => {});
    });
    $('fontThresh').addEventListener('input', () => {
      invalidate('笔画阈值改了');
      $('fontThreshOut').textContent = String(thresholdValue());
      persist();
      drawPreview().catch(() => {});
    });
    $('fontBuild').addEventListener('click', run(buildNow, 'fontBuildStatus'));
    $('fontDownload').addEventListener('click', download);
    $('fontConnect').addEventListener('click', () => {
      status('fontStatus', '');
      return ble.connect((error) => status('fontStatus', error, 'bad'));
    });
    $('fontDisconnect').addEventListener('click', () => ble.disconnect());
    $('fontUpload').addEventListener('click', () => {
      status('fontStatus', '');
      return ble.runBusy(upload, (error) => status('fontStatus', String((error && error.message) || error), 'bad'));
    });
  }

  bind();
  if (ble) ble.subscribe((state) => { link = state; updateControls(); });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawPreview().catch(() => {}); }, 150);
  });
  window.addEventListener('ink:tab', (event) => {
    if (event.detail && event.detail.tab === 'fonts') {
      updateControls();
      drawPreview().catch(() => {});
    }
  });
  window.INK_FONTS = {
    faces: FACES, presets: F.PRESETS, defaultPreset: F.DEFAULT_PRESET,
    installed, resolveFace, currentFamily, currentPreset, activeSizes, zoomValue,
    buildNow, upload, download, rasterizeRange, makeRaster, drawPreview,
    get blob() { return blob; },
    get built() { return built; },
  };
})();
