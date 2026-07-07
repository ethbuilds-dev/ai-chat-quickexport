// zipwriter.js — minimal ZIP archive writer (STORE method, no compression).
//
// Why not JSZip: vendoring ~100 KB of minified third-party code into a
// human-reviewed extension is unreviewable; the store package stays small and
// every byte in the archive is produced by ~150 readable lines below.
// STORE is deliberate: the assets are already-compressed PNG/JPEG/WebP and
// the markdown is tiny, so DEFLATE would buy nothing.
//
// Format reference: PKWARE APPNOTE.TXT (local file headers + central
// directory + end-of-central-directory). No ZIP64 — a single conversation
// export is far below the 4 GiB / 65535-entry limits; createZip throws if
// that assumption is ever violated rather than emitting a corrupt archive.
//
// Loaded three ways (same pattern as media-utils.js): importScripts, <script>,
// and require() for the Node tests.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ZipWriter = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- CRC-32 (IEEE 802.3), table-driven ----
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- helpers ----
  function encodeUtf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Node fallback (tests)
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return encodeUtf8(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error('zipwriter: unsupported entry data type');
  }

  // MS-DOS date/time encoding (2-second resolution, fine for exports).
  function dosDateTime(d) {
    const date = d || new Date();
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function writeU16(view, off, v) { view.setUint16(off, v & 0xffff, true); }
  function writeU32(view, off, v) { view.setUint32(off, v >>> 0, true); }

  /**
   * Build a ZIP archive.
   * @param {Array<{name:string, data:(Uint8Array|string|ArrayBuffer), date?:Date}>} entries
   *        `name` uses forward slashes (e.g. "assets/photo.png").
   * @returns {Uint8Array} the complete archive bytes.
   */
  function createZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('zipwriter: no entries');
    }
    if (entries.length > 0xffff) throw new Error('zipwriter: too many entries');

    const localParts = [];   // Uint8Arrays in output order
    const centralParts = [];
    let offset = 0;
    const seenNames = new Set();

    for (const entry of entries) {
      const nameBytes = encodeUtf8(String(entry.name).replace(/\\/g, '/'));
      if (nameBytes.length === 0 || nameBytes.length > 0xffff) {
        throw new Error('zipwriter: bad entry name');
      }
      const nameKey = String(entry.name).toLowerCase();
      if (seenNames.has(nameKey)) throw new Error('zipwriter: duplicate entry name: ' + entry.name);
      seenNames.add(nameKey);

      const data = toBytes(entry.data);
      if (data.length >= 0xffffffff) throw new Error('zipwriter: entry too large (no ZIP64)');
      const crc = crc32(data);
      const dt = dosDateTime(entry.date);

      // Local file header: 30 bytes fixed + name
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      writeU32(lv, 0, 0x04034b50);        // local file header signature
      writeU16(lv, 4, 20);                // version needed: 2.0
      writeU16(lv, 6, 0x0800);            // flags: UTF-8 names
      writeU16(lv, 8, 0);                 // method: STORE
      writeU16(lv, 10, dt.time);
      writeU16(lv, 12, dt.date);
      writeU32(lv, 14, crc);
      writeU32(lv, 18, data.length);      // compressed size (== raw for STORE)
      writeU32(lv, 22, data.length);      // uncompressed size
      writeU16(lv, 26, nameBytes.length);
      writeU16(lv, 28, 0);                // extra field length
      lfh.set(nameBytes, 30);

      localParts.push(lfh, data);

      // Central directory header: 46 bytes fixed + name
      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      writeU32(cv, 0, 0x02014b50);        // central directory signature
      writeU16(cv, 4, 20);                // version made by
      writeU16(cv, 6, 20);                // version needed
      writeU16(cv, 8, 0x0800);            // flags: UTF-8 names
      writeU16(cv, 10, 0);                // method: STORE
      writeU16(cv, 12, dt.time);
      writeU16(cv, 14, dt.date);
      writeU32(cv, 16, crc);
      writeU32(cv, 20, data.length);
      writeU32(cv, 24, data.length);
      writeU16(cv, 28, nameBytes.length);
      // 30 extra len, 32 comment len, 34 disk start, 36 internal attrs: all 0
      writeU32(cv, 38, 0);                // external attrs
      writeU32(cv, 42, offset);           // local header offset
      cdh.set(nameBytes, 46);
      centralParts.push(cdh);

      offset += lfh.length + data.length;
      if (offset >= 0xffffffff) throw new Error('zipwriter: archive too large (no ZIP64)');
    }

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const centralOffset = offset;

    // End of central directory record: 22 bytes
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    writeU32(ev, 0, 0x06054b50);
    // 4 disk number, 6 cd start disk: 0
    writeU16(ev, 8, entries.length);
    writeU16(ev, 10, entries.length);
    writeU32(ev, 12, centralSize);
    writeU32(ev, 16, centralOffset);
    // 20 comment length: 0

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of localParts) { out.set(p, pos); pos += p.length; }
    for (const p of centralParts) { out.set(p, pos); pos += p.length; }
    out.set(eocd, pos);
    return out;
  }

  return { createZip: createZip, crc32: crc32 };
});
