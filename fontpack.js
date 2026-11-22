/* Ink Studio — FNT1 字库格式、GB2312 字表、U5 分区表。
 *
 * 这个文件不碰 DOM、不碰 canvas：浏览器里挂 window.FNTPACK，Node 里 require 做单元测试
 * （node tools/bwr-studio/test-fonts.js）。真正把字栅格化成 1 bit 的活在上层的 fonts.js，
 * 所以这里的每个函数都能在测试里用假字模跑通。
 *
 * FNT1 是价签从 U5 读的字库格式（firmware/tag-tlsr8359-ble/src/render.c: pak_init_u5），
 * 由 tools/tag_assets/pack_fullfont.py 定义，这里是一份逐字段对齐的 JavaScript 实现：
 *
 *   包头 32 B   "FNT1" | ver u16 | commit u8 | flags u8 | total u32 | table_crc u32
 *               | n_ranges u8 | face u8 | rsv u16 | range_off u32 | build_id u32 | hdr_crc u32
 *   目录 16 B   first_cp u16 | last_cp u16 | cell_w u8 | cell_h u8 | kind u8 | baseline u8
 *               | data_off u32 | count_flags u32          (count_flags = glyphs<<1 | indexed)
 *   数据        每个区间：可选的 u16 码点索引（稀疏区间），然后连续字模
 *
 * 只有两种字面进得去：cell_h 16 和 24（render.c: fnt_slot()）。缺哪个字就不打哪个字模，
 * 固件会用另一级放大补位（rfont_t.fb）；本文件只负责"字库里有什么"。
 *
 * 字库区固定在 U5 的 0x022000，长度上限 FONT_MAX = 750 KiB（用户 2026-11-22 的预算）。
 * 四档预设见 PRESETS，最大那档 767 732 B 正好装得下。改地址要同时改固件 FNT_ADDR 和这里。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FNTPACK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------- U5 分区 --- */
  /* 2 MiB 的 U5（第二颗 NOR，挂在 tag 自己的 SPI 主机上）。基址和长度都是 4 KiB 对齐，
   * 因为固件按 4 KiB 扇区擦。字库区只给 750 KiB —— 四档预设最大的一档是 767 732 B，
   * 再多留也没有别的"档"能用（用户 2026-11-22：「给字库分配的空间太大了，750K 即可」）。 */
  const U5_SIZE = 0x200000;
  const FONT_BASE = 0x022000;               /* render.h: FNT_ADDR */
  const FONT_MAX = 750 * 1024;              /* 768 000 B */
  const FONT_END = FONT_BASE + FONT_MAX;    /* 0x0DD800：包尾上限（不含） */
  const FONT_SECTOR_END = 0x0DE000;         /* 4 KiB 对齐：0x47 会把最后一个扇区擦到这里 */
  const REST_BASE = 0x1F0000;               /* card.c: REST_ADDR */
  const FONT_UPLOAD_ADDR = 0x80000000 | FONT_BASE;   /* 0x47 的地址高位置 1 = 写 U5 */

  const U5_REGIONS = [
    { base: 0x000000, end: 0x020000, name: 'OTA 暂存', kind: 'reserved',
      note: '128 KiB，保留；0x47 的 U5 写入从 0x20000 起，动不到这里' },
    { base: 0x020000, end: 0x022000, name: 'U5 目录', kind: 'reserved',
      note: '8 KiB，预留；将来放「U5 里装了什么」的自描述记录' },
    { base: FONT_BASE, end: FONT_END, name: 'FNT1 字库', kind: 'font',
      note: '固定基址 0x022000，上限 750 KiB（768 000 B）；最大的一档 767 732 B' },
    { base: FONT_END, end: FONT_SECTOR_END, name: '扇区补齐', kind: 'guard',
      note: '2 KiB，空着；0x47 按 4 KiB 扇区擦，擦到这里为止' },
    { base: FONT_SECTOR_END, end: REST_BASE, name: '未分配', kind: 'spare',
      note: '1096 KiB，空着；以后要更大的字库再往这里划，地址一次定死' },
    { base: REST_BASE, end: REST_BASE + 0x1000, name: '调休表 REST', kind: 'rest',
      note: '4 KiB，固件 REST_ADDR；一张表 3 年才 1 KB' },
    { base: REST_BASE + 0x1000, end: U5_SIZE, name: '备用', kind: 'spare',
      note: '60 KiB，留给以后的资产（古诗包之类）' },
  ];

  const HDR_SIZE = 32;
  const RANGE_SIZE = 16;
  const VERSION = 1;
  const COMMIT = 0xA5;
  const MAX_RANGES = 16;          /* render.c: pak_init_u5 的 `n > 16` 拒绝 */
  const MAX_RANGES_PER_SLOT = 6;  /* render.h: PAK_MAX_RANGES */

  /* ---------------------------------------------------------------- crc32 --- */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xEDB88320 : 0);
      table[i] = c >>> 0;
    }
    return table;
  })();

  /* zlib 的 CRC-32：初值 0xFFFFFFFF、反射多项式 0xEDB88320、末尾取反。传 seed 就是接着算
   * （内部先反一次，和 zlib.crc32(data, prev) 的约定一致），价签 0x47 比的就是这个值。 */
  function crc32(bytes, seed) {
    let crc = (seed === undefined ? 0xFFFFFFFF : (seed ^ 0xFFFFFFFF)) >>> 0;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------------------------------------------------------- 字节流 --- */
  function putU16(b, at, v) {
    b[at] = (v >>> 8) & 255;
    b[at + 1] = v & 255;
  }

  function putU32(b, at, v) {
    b[at] = (v >>> 24) & 255;
    b[at + 1] = (v >>> 16) & 255;
    b[at + 2] = (v >>> 8) & 255;
    b[at + 3] = v & 255;
  }

  function u16(b, at) {
    return (b[at] << 8) | b[at + 1];
  }

  function u32(b, at) {
    return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  }

  function hex(v, width) {
    return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width || 0, '0');
  }

  /* ------------------------------------------------------------- 字表 --- */
  /* GB2312 用 TextDecoder('gb2312') 解码 0xA1A1–0xF7FE 的字节对；Chrome / Edge / Node 都自带。
   * Python 侧（pack_fullfont.py: gb2312_chars）是同一个枚举顺序，两个工具产出的字表一致：
   * 全集 8178 字（6763 汉字 + 682 符号）、一级 3760 字（3755 汉字）。 */
  let decoder;
  function gbDecoder() {
    if (decoder === undefined) {
      try {
        decoder = new TextDecoder('gb2312');
      } catch (error) {
        decoder = null;
      }
      if (!decoder) throw new Error('这个浏览器不支持 GB2312 解码（TextDecoder），无法生成字库');
    }
    return decoder;
  }

  const gbCache = { all: null, l1: null };
  /* level: 'all' = GB2312 一二级（0xA1A1–0xF7FE）, 1 = 一级（0xB0A1–0xD7FE） */
  function gb2312(level) {
    const key = level === 1 ? 'l1' : 'all';
    if (gbCache[key]) return gbCache[key];
    const dec = gbDecoder();
    const hi0 = key === 'l1' ? 0xB0 : 0xA1;
    const hi1 = key === 'l1' ? 0xD7 : 0xF7;
    const out = [];
    for (let hi = hi0; hi <= hi1; hi++) {
      for (let lo = 0xA1; lo <= 0xFE; lo++) {
        const s = dec.decode(Uint8Array.of(hi, lo));
        if (s.length === 1 && s !== '\uFFFD') out.push(s);
      }
    }
    gbCache[key] = out.join('');
    return gbCache[key];
  }

  function rangeChars(lo, hi) {
    let out = '';
    for (let cp = lo; cp <= hi; cp++) out += String.fromCodePoint(cp);
    return out;
  }

  const CJK_FIRST = 0x4E00;
  const CJK_LAST = 0x9FFF;

  /* 和 pack_fullfont.py 的 profile() 一模一样的区间顺序（24 px 先、16 px 后）。
   * name 只用于显示，固件认的是 (cell_h, kind)。 */
  const CHARSETS = {
    ascii: () => rangeChars(0x20, 0x7E),
    punct: () => rangeChars(0x3000, 0x303F),
    fullwidth: () => rangeChars(0xFF01, 0xFF5E),
    latin1: () => rangeChars(0x00A0, 0x00FF),
    genpunct: () => rangeChars(0x2010, 0x2027),
    letterlike: () => rangeChars(0x2100, 0x2113),
    gb2312: () => gb2312('all'),
    gb2312L1: () => gb2312(1),
    cjkBlock: () => rangeChars(CJK_FIRST, CJK_LAST),
  };

  /* 覆盖选项 → 区间列表。默认就是线上那套：16 px 一二级、24 px 只有一级。
   * 网页端只让用户选 PRESETS 里的四档，这三项是给测试和 CLI 对拍用的底层开关。 */
  const COVERAGE = {
    cjk16: 'gb2312',      /* 'gb2312' | 'gb2312L1' | 'off' */
    cjk24: 'gb2312L1',    /* 'gb2312' | 'gb2312L1' | 'cjkBlock' | 'off' */
    ascii16: true,
    ascii24: true,
    symbols: true,        /* 标点 / 全角 / Latin-1 / 常用符号（5 个区间） */
  };

  /* 网页端只认这四档（用户 2026-11-22：「只允许通过预设选择，16px 和 24px 不再支持单独设置」）。
   * 'off' 会把整个字号连带它的 ASCII / 符号区间一起砍掉 —— 除了汉字什么都没有的 24 px 槽
   * 没有意义，还会白占 PAK_MAX_RANGES。体积由 plan() 现算，UI 上不写死。 */
  const PRESETS = [
    { id: 'l1', label: '仅 16 px 一级',
      cov: { cjk16: 'gb2312L1', cjk24: 'off' } },
    { id: 'gb16', label: '仅 16 px 一二级',
      cov: { cjk16: 'gb2312', cjk24: 'off' } },
    { id: 'std', label: '16 px 一二级 + 24 px 一级',
      cov: { cjk16: 'gb2312', cjk24: 'gb2312L1' } },
    { id: 'full', label: '16 px 一二级 + 24 px 一二级',
      cov: { cjk16: 'gb2312', cjk24: 'gb2312' } },
  ];
  const DEFAULT_PRESET = 'std';

  const EXTRA = [
    ['latin1', 'latin1'],
    ['genpunct', 'genpunct'],
    ['letterlike', 'letterlike'],
  ];

  /* 字面的尺寸与类型：kind 0 = 全角（中文），1 = 半角（ASCII）。
   * 这两个数字是固件认字面的唯一依据，不能改。 */
  const CELLS = {
    cjk16: { cw: 16, ch: 16, kind: 0 },
    ascii16: { cw: 8, ch: 16, kind: 1 },
    cjk24: { cw: 24, ch: 24, kind: 0 },
    ascii24: { cw: 12, ch: 24, kind: 1 },
  };

  function cellOf(name) {
    return CELLS[name];
  }

  function strideOf(cw) {
    return (cw + 7) >> 3;
  }

  function slotOf(ch, kind) {
    if (kind === 0) return ch === 16 ? 'cjk16' : (ch === 24 ? 'cjk24' : null);
    if (kind === 1) return ch === 16 ? 'ascii16' : (ch === 24 ? 'ascii24' : null);
    return null;
  }

  /* 码点：去重、升序。区间必须是"有序且无重复"的，固件的二分查找依赖这一点。 */
  function codepoints(chars) {
    const seen = new Set();
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp <= 0xFFFF) seen.add(cp);         /* FNT1 的索引是 u16，BMP 以外进不去 */
    }
    return Uint16Array.from([...seen].sort((a, b) => a - b));
  }

  /* 汉字区间只取 CJK 基本区（U+4E00–U+9FFF），和 pack_fullfont.py 的 cjk_of() 一致：
   * GB2312 的字节区里还混着 5 个私用区码点（U+E810–U+E814）和一批符号，它们分别属于
   * 符号区间或根本不该进汉字区间；混进来会让同一个槽里出现重复码点。 */
  function cjkOnly(chars) {
    let out = '';
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp >= CJK_FIRST && cp <= CJK_LAST) out += ch;
    }
    return out;
  }

  /* 覆盖选项 → [{name, kind, cw, ch, chars, cps}]。顺序同 pack_fullfont.py。
   * 某个字号被设成 'off' 就整个跳过（连 ASCII 和符号一起）：预设说的就是"这一级要不要"。 */
  function specs(coverage) {
    const opt = Object.assign({}, COVERAGE, coverage || {});
    const out = [];
    const push = (name, cellName, charsetKey, onlyCjk) => {
      const cell = CELLS[cellName];
      const chars = onlyCjk ? cjkOnly(CHARSETS[charsetKey]()) : CHARSETS[charsetKey]();
      out.push({ name, kind: cell.kind, cw: cell.cw, ch: cell.ch, chars, cps: codepoints(chars) });
    };
    const has24 = opt.cjk24 !== 'off';
    const has16 = opt.cjk16 !== 'off';
    if (has24) {
      push('cjk24', 'cjk24', opt.cjk24, true);
      if (opt.ascii24) push('ascii24', 'ascii24', 'ascii', false);
      if (opt.symbols) {
        push('punct24', 'cjk24', 'punct', false);
        push('full24w', 'cjk24', 'fullwidth', false);
        for (const [name, key] of EXTRA) push(name + '24', 'cjk24', key, false);
      }
    }
    if (has16) {
      push('cjk16', 'cjk16', opt.cjk16, true);
      if (opt.ascii16) push('ascii16', 'ascii16', 'ascii', false);
      if (opt.symbols) {
        push('punct16', 'cjk16', 'punct', false);
        push('full16w', 'cjk16', 'fullwidth', false);
        for (const [name, key] of EXTRA) push(name + '16', 'cjk16', key, false);
      }
    }
    return out;
  }

  /* 不栅格化时的账：每个区间多少字、多少字节（含索引），总共多大、能不能放进字库区。 */
  function plan(list) {
    const ranges = [];
    let bytes = HDR_SIZE + RANGE_SIZE * list.length;
    let glyphs = 0;
    const perSlot = {};
    for (const spec of list) {
      const cps = spec.cps;
      const count = cps.length;
      const stride = strideOf(spec.cw);
      const glyphBytes = count * stride * spec.ch;
      const indexed = count !== (cps[count - 1] - cps[0] + 1);
      const indexBytes = indexed ? count * 2 : 0;
      const size = glyphBytes + indexBytes;
      bytes += size;
      glyphs += count;
      const slot = slotOf(spec.ch, spec.kind);
      perSlot[slot] = (perSlot[slot] || 0) + 1;
      ranges.push({ name: spec.name, cw: spec.cw, ch: spec.ch, kind: spec.kind, count,
        stride, glyphBytes, indexBytes, indexed, bytes: size, slot });
    }
    return {
      ranges, glyphs, bytes,
      fits: bytes <= FONT_MAX,
      headroom: FONT_MAX - bytes,
      rangesPerSlot: perSlot,
      tooManyRanges: list.length > MAX_RANGES,
      tooManyPerSlot: Object.keys(perSlot).filter((slot) => perSlot[slot] > MAX_RANGES_PER_SLOT),
    };
  }

  /* --------------------------------------------------------------- 打包 --- */
  /* rasterize(spec) -> {px, baseline, glyphs: [{cp, bits}], missing: [cp...], overflow}
   *
   * 返回的 glyphs 可以少字：字体里没有的字**不要**塞进包里，这样固件会走 rfont_t.fb 回退
   * （24 px 缺字用 16 px 放大），而不是把一个方框当成字模画出来。空白字（空格、全角空格）
   * 必须留着，否则固件会把它画成一个 1 px 方框（render.c: rc_text 的缺字标记）。 */
  function build(list, rasterize, onProgress) {
    const total = list.reduce((n, spec) => n + spec.cps.length, 0);
    const seen = { glyphs: 0 };
    const results = list.map((spec) => {
      const r = rasterize(spec, (n) => {
        seen.glyphs += n || 0;
        if (onProgress) onProgress(seen.glyphs, total, spec.name);
      });
      return Object.assign({ cps: spec.cps, name: spec.name, cw: spec.cw, ch: spec.ch, kind: spec.kind }, r);
    });
    return finish(results);
  }

  /* 已经栅格化好的区间 -> 包。分出来是为了浏览器里可以一段一段 await 着做（每 256 个字让出
   * 一次主线程），而不是把十几秒的循环卡在一个同步调用里。每段要带 name/cw/ch/kind/cps。 */
  function finish(results) {
    const missing = [];
    let overflow = 0;
    const ranges = [];
    for (const r of results) {
      const stride = strideOf(r.cw);
      const glyphBytes = stride * r.ch;
      const byCp = new Map();
      for (const g of r.glyphs) byCp.set(g.cp, g.bits);
      const cps = [];
      for (const cp of r.cps) if (byCp.has(cp)) cps.push(cp);
      if (!cps.length) continue;
      const bits = new Uint8Array(cps.length * glyphBytes);
      const index = (cps.length !== (cps[cps.length - 1] - cps[0] + 1)) ? new Uint8Array(cps.length * 2) : null;
      for (let i = 0; i < cps.length; i++) {
        const g = byCp.get(cps[i]);
        if (!g || g.length !== glyphBytes) {
          throw new Error(`${r.name}：码点 U+${cps[i].toString(16).toUpperCase()} 的字模长度不对`);
        }
        bits.set(g, i * glyphBytes);
        if (index) putU16(index, i * 2, cps[i]);
      }
      if (r.missing && r.missing.length) missing.push({ range: r.name, cps: r.missing });
      if (r.overflow) overflow += r.overflow;
      ranges.push({ name: r.name, cw: r.cw, ch: r.ch, kind: r.kind,
        baseline: r.baseline, px: r.px, cps: Uint16Array.from(cps), bits, index });
    }
    const blob = assemble(ranges, { faceId: 0, buildId: Math.floor(Date.now() / 1000) });
    const summary = verify(blob);
    return { blob, table: summary, missing, overflow };
  }

  /* 把已经栅格化好的区间拼成 FNT1。ranges 的顺序就是目录顺序，也是固件分配 idx0 的顺序。 */
  function assemble(ranges, opts) {
    const options = opts || {};
    if (!ranges.length) throw new Error('没有可打包的区间');
    if (ranges.length > MAX_RANGES) throw new Error(`区间最多 ${MAX_RANGES} 个`);
    const perSlot = {};
    for (const r of ranges) {
      const slot = slotOf(r.ch, r.kind);
      if (!slot) throw new Error(`${r.name}：${r.cw}×${r.ch} 不是价签支持的字面（只有 16/24 px）`);
      perSlot[slot] = (perSlot[slot] || 0) + 1;
    }
    for (const slot of Object.keys(perSlot)) {
      if (perSlot[slot] > MAX_RANGES_PER_SLOT) {
        throw new Error(`${slot} 有 ${perSlot[slot]} 个区间，PAK_MAX_RANGES 只有 ${MAX_RANGES_PER_SLOT}`);
      }
    }

    const dirOff = HDR_SIZE;
    let cursor = dirOff + RANGE_SIZE * ranges.length;
    const table = new Uint8Array(RANGE_SIZE * ranges.length);
    const body = [];
    ranges.forEach((r, i) => {
      const count = r.cps.length;
      if (!count) throw new Error(`${r.name}：空区间`);
      if (count > 0x7FFF) throw new Error(`${r.name}：${count} 个字超过 u16 能表示的范围`);
      const stride = strideOf(r.cw);
      if (r.bits.length !== count * stride * r.ch) {
        throw new Error(`${r.name}：字模长度 ${r.bits.length} != ${count}×${stride * r.ch}`);
      }
      const at = i * RANGE_SIZE;
      putU16(table, at, r.cps[0]);
      putU16(table, at + 2, r.cps[count - 1]);
      table[at + 4] = r.cw;
      table[at + 5] = r.ch;
      table[at + 6] = r.kind;
      table[at + 7] = r.baseline;
      putU32(table, at + 8, cursor);
      putU32(table, at + 12, ((count << 1) | (r.index ? 1 : 0)) >>> 0);
      if (r.index) {
        body.push(r.index);
        cursor += r.index.length;
      }
      body.push(r.bits);
      cursor += r.bits.length;
    });
    const total = cursor;
    if (total > FONT_MAX) {
      throw new Error(`字库 ${total} B 超过字库区上限 ${FONT_MAX} B（U5 0x022000–0x0DD7FF）`);
    }

    const blob = new Uint8Array(total);
    let at = HDR_SIZE + RANGE_SIZE * ranges.length;
    for (const part of body) {
      blob.set(part, at);
      at += part.length;
    }
    blob.set(table, HDR_SIZE);
    blob[0] = 0x46; blob[1] = 0x4E; blob[2] = 0x54; blob[3] = 0x31;   /* "FNT1" */
    putU16(blob, 4, VERSION);
    blob[6] = COMMIT;
    blob[7] = 0;
    putU32(blob, 8, total);
    putU32(blob, 12, crc32(table));
    blob[16] = ranges.length;
    blob[17] = (options.faceId || 0) & 255;         /* 给人和工具看的字体编号，固件不读 */
    putU16(blob, 18, 0);
    putU32(blob, 20, dirOff);
    putU32(blob, 24, (options.buildId || 1) >>> 0);
    putU32(blob, 28, crc32(blob.subarray(0, 28)));
    return blob;
  }

  /* 按固件的方式再解析一遍：这是"包里到底是什么"的唯一解释，UI 的摘要就是它。 */
  function parse(blob) {
    if (blob.length < HDR_SIZE) throw new Error('字库包太短');
    if (blob[0] !== 0x46 || blob[1] !== 0x4E || blob[2] !== 0x54 || blob[3] !== 0x31) {
      throw new Error('不是 FNT1 字库包');
    }
    const total = u32(blob, 8);
    const count = blob[16];
    const rangeOff = u32(blob, 20);
    const ranges = [];
    for (let i = 0; i < count; i++) {
      const at = rangeOff + i * RANGE_SIZE;
      if (at + RANGE_SIZE > blob.length) throw new Error('区间目录越界');
      const flags = u32(blob, at + 12);
      ranges.push({
        first: u16(blob, at), last: u16(blob, at + 2),
        cw: blob[at + 4], ch: blob[at + 5], kind: blob[at + 6], baseline: blob[at + 7],
        off: u32(blob, at + 8), glyphs: flags >>> 1, indexed: (flags & 1) !== 0,
        stride: strideOf(blob[at + 4]), slot: slotOf(blob[at + 5], blob[at + 6]),
      });
    }
    return {
      version: u16(blob, 4), commit: blob[6], faceId: blob[17],
      total, tableCrc: u32(blob, 12), hdrCrc: u32(blob, 28),
      buildId: u32(blob, 24), rangeOff, ranges,
      glyphs: ranges.reduce((n, r) => n + r.glyphs, 0),
    };
  }

  /* 逐个地址再算一遍（和 pack_fullfont.py: verify 同样的断言）。任何一条不成立都抛错：
   * 宁可在这里失败，也不要让价签开机后才发现表是错的。 */
  function verify(blob) {
    const info = parse(blob);
    if (info.commit !== COMMIT) throw new Error(`commit 字节是 ${info.commit}，不是 0xA5`);
    if (info.total !== blob.length) throw new Error(`包头总长 ${info.total} != 实际 ${blob.length}`);
    if (info.rangeOff !== HDR_SIZE) throw new Error(`目录偏移 ${info.rangeOff} 不是 ${HDR_SIZE}`);
    if (!info.ranges.length) throw new Error('没有区间');
    if (info.ranges.length > MAX_RANGES) throw new Error(`区间 ${info.ranges.length} 个，固件上限 ${MAX_RANGES}`);
    const table = blob.subarray(info.rangeOff, info.rangeOff + RANGE_SIZE * info.ranges.length);
    if (crc32(table) !== info.tableCrc) throw new Error('区间目录 CRC 不符');
    if (crc32(blob.subarray(0, 28)) !== info.hdrCrc) throw new Error('包头 CRC 不符');

    const perSlot = {};
    for (const r of info.ranges) {
      if (!r.slot) throw new Error(`区间 ${hex(r.first, 4)} 的字面 ${r.cw}×${r.ch} 不被支持`);
      if (!r.glyphs) throw new Error(`区间 ${hex(r.first, 4)} 没有字模`);
      if (r.last < r.first) throw new Error(`区间 ${hex(r.first, 4)} 的 first/last 反了`);
      if (r.glyphs > r.last - r.first + 1) throw new Error(`区间 ${hex(r.first, 4)} 字数超过码点范围`);
      const head = r.indexed ? r.glyphs * 2 : 0;
      const body = r.glyphs * r.stride * r.ch;
      if (r.off + head + body > info.total) throw new Error(`区间 ${hex(r.first, 4)} 越过包尾`);
      if (r.indexed) {
        let prev = -1;
        if (u16(blob, r.off) !== r.first) throw new Error('索引首项与 first 不符');
        if (u16(blob, r.off + (r.glyphs - 1) * 2) !== r.last) throw new Error('索引末项与 last 不符');
        for (let i = 0; i < r.glyphs; i++) {
          const cp = u16(blob, r.off + i * 2);
          if (cp <= prev) throw new Error(`区间 ${hex(r.first, 4)} 的索引不是严格升序`);
          prev = cp;
        }
      } else if (r.glyphs !== r.last - r.first + 1) {
        throw new Error(`区间 ${hex(r.first, 4)} 是连续区间却有洞`);
      }
      perSlot[r.slot] = (perSlot[r.slot] || 0) + 1;
    }
    for (const slot of Object.keys(perSlot)) {
      if (perSlot[slot] > MAX_RANGES_PER_SLOT) throw new Error(`${slot} 有 ${perSlot[slot]} 个区间，上限 ${MAX_RANGES_PER_SLOT}`);
    }
    const tail = info.ranges[info.ranges.length - 1];
    const end = tail.off + (tail.indexed ? tail.glyphs * 2 : 0) + tail.glyphs * tail.stride * tail.ch;
    if (end !== info.total) throw new Error(`包尾有 ${info.total - end} B 多余数据`);
    return info;
  }

  /* --------------------------------------------------------- 0x47 帧 --- */
  /* card.c: asset_begin 读 d[2..13]，全部小端；asset_data 从 d[2] 开始是数据；0x02 是提交。 */
  function beginFrame(addr, length, crc) {
    const f = new Uint8Array(14);
    f[0] = 0x47;
    f[1] = 0x00;
    f[2] = addr & 255; f[3] = (addr >>> 8) & 255; f[4] = (addr >>> 16) & 255; f[5] = (addr >>> 24) & 255;
    f[6] = length & 255; f[7] = (length >>> 8) & 255; f[8] = (length >>> 16) & 255; f[9] = (length >>> 24) & 255;
    f[10] = crc & 255; f[11] = (crc >>> 8) & 255; f[12] = (crc >>> 16) & 255; f[13] = (crc >>> 24) & 255;
    return f;
  }

  function dataFrame(payload) {
    const f = new Uint8Array(payload.length + 2);
    f[0] = 0x47;
    f[1] = 0x01;
    f.set(payload, 2);
    return f;
  }

  const COMMIT_FRAME = Uint8Array.of(0x47, 0x02);

  /* 一次上传需要多少个包（给 UI 估时间用）。一包数据 = payload 字节。 */
  function uploadPlan(length, payload) {
    const packets = Math.ceil(length / payload) + 1;         /* + begin */
    return { packets, bytes: length, payload };
  }

  function kb(bytes) {
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  return {
    U5_SIZE, FONT_BASE, FONT_END, FONT_MAX, FONT_SECTOR_END, REST_BASE, FONT_UPLOAD_ADDR,
    U5_REGIONS,
    HDR_SIZE, RANGE_SIZE, VERSION, COMMIT, MAX_RANGES, MAX_RANGES_PER_SLOT,
    CJK_FIRST, CJK_LAST, CELLS, CHARSETS, COVERAGE, PRESETS, DEFAULT_PRESET,
    UPLOAD_ADDR: FONT_UPLOAD_ADDR,
    crc32, hex, putU16, putU32, u16, u32,
    gb2312, rangeChars, codepoints, specs, plan, build, finish, assemble, parse, verify,
    cellOf, strideOf, slotOf,
    beginFrame, dataFrame, COMMIT_FRAME, uploadPlan, kb,
  };
});
