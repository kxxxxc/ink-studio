/* Ink Studio — .eslfw firmware package parsing and signature checks.
 *
 * The package is exactly 116 B of header followed by the image:
 *   0   4  "ESLF"
 *   4   1  manifest version (1)
 *   5   1  key id (0 or 1)
 *   6   2  reserved
 *   8   4  image length (little endian)
 *  12   4  image CRC-32 (zlib, little endian)
 *  16   4  sequence (little endian, anti-downgrade)
 *  20  32  SHA-256(image)
 *  52  64  ECDSA P-256 signature over SHA-256(bytes [0, 52)), r||s big endian
 *
 * This file has no DOM dependency so it can be loaded by the page and by Node.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OTA_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADER = 116;
  const MANIFEST = 52;
  const MIN_IMAGE = 0x1000;       // 4 KiB, the tag's lower bound
  const MAX_IMAGE = 0x20000;      // 128 KiB, one internal slot

  // The two public halves compiled into firmware/tag-tlsr8359-ble/src/crypto.c.
  // key id 0 = ota_pubkey.h, key id 1 = ota_pubkey1.h.
  const KEY_HEX = {
    0: '93889f46a6599bd1c2e2c272c42e68f5f0c85b58fb92c4d8994494bdbbe73ae0' +
       'ce13fd6335df45acf68ba4116d6391a03f4875e92a8d456ade85525d038cfd4c',
    1: '6358013a8921ea09037dbe4361f774747ea2e6075f9db292d0dd70181346e5bb' +
       '401b9ae874ee550e8e875ab157fec714897d8279205b44f58a83ffef01f3855e',
  };

  function hexToBytes(hex) {
    if (hex.length % 2) throw new Error('十六进制长度不是偶数');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const KEYS = {};
  for (const [id, hex] of Object.entries(KEY_HEX)) KEYS[id] = hexToBytes(hex);

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error('固件包必须是 Uint8Array / ArrayBuffer');
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function hex(bytes) {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function parsePackage(value) {
    const buf = toBytes(value);
    if (buf.length < HEADER + MIN_IMAGE) {
      throw new Error('文件太小，不是 .eslfw 固件包（至少 ' + (HEADER + MIN_IMAGE) + ' B）');
    }
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'ESLF') {
      throw new Error('magic 不是 ESLF：这不是签名过的固件包');
    }
    const view = new DataView(buf.buffer, buf.byteOffset, HEADER);
    const ver = buf[4];
    const keyId = buf[5];
    const len = view.getUint32(8, true);
    const crc = view.getUint32(12, true);
    const seq = view.getUint32(16, true);
    if (ver !== 1) throw new Error('不支持的固件包版本 ' + ver);
    if (keyId > 1) throw new Error('未知的 OTA 密钥编号 ' + keyId);
    if (len < MIN_IMAGE || len > MAX_IMAGE) {
      throw new Error('镜像长度 ' + len + ' B 超出 4 KiB–128 KiB');
    }
    if (buf.length !== HEADER + len) {
      throw new Error('包长度不符：声明 ' + len + ' B，头部加镜像应为 ' + (HEADER + len) +
        ' B，实际 ' + buf.length + ' B');
    }
    return {
      ver, keyId, len, crc, seq,
      sha: buf.subarray(20, 52),
      sig: buf.subarray(52, 116),
      manifest: buf.subarray(0, MANIFEST),
      image: buf.subarray(HEADER, HEADER + len),
      header: buf.subarray(0, HEADER),
      total: buf.length,
    };
  }

  async function verifyPackage(pkg, options = {}) {
    const subtle = options.subtle || (globalThis.crypto && globalThis.crypto.subtle);
    if (!subtle) throw new Error('当前浏览器不支持 WebCrypto，无法校验签名');
    const image = pkg.image;
    const actualCrc = crc32(image);
    const digest = new Uint8Array(await subtle.digest('SHA-256', image));
    const crcOk = actualCrc === pkg.crc;
    const shaOk = bytesEqual(digest, pkg.sha);
    const keyBytes = (options.keys && options.keys[pkg.keyId]) || KEYS[pkg.keyId];
    let sigOk = false;
    if (keyBytes) {
      // WebCrypto's ECDSA "raw" key is the uncompressed point 04 || X || Y,
      // while the firmware headers store X || Y (64 B).
      const point = new Uint8Array(1 + keyBytes.length);
      point[0] = 0x04;
      point.set(keyBytes, 1);
      const key = await subtle.importKey(
        'raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      // WebCrypto's ECDSA verify hashes `manifest` with SHA-256 and expects r||s,
      // exactly the construction fw_sign.py writes.
      sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, pkg.sig, pkg.manifest);
    }
    return {
      crc: actualCrc,
      sha: digest,
      crcOk,
      shaOk,
      sigOk,
      ok: crcOk && shaOk && sigOk,
    };
  }

  return {
    HEADER, MANIFEST, MIN_IMAGE, MAX_IMAGE,
    KEYS, parsePackage, verifyPackage, crc32, hex, hexToBytes, bytesEqual,
  };
});
