// media-utils.js — v1.5 media export: pure, environment-free helpers.
//
// Loaded three ways:
//   - background.js (service worker):  importScripts('media-utils.js')
//   - popup.html:                      <script src="media-utils.js">
//   - tests (Node):                    require('../media-utils.js')
//
// Everything here is a pure function over plain data — no chrome.*, no fetch,
// no DOM — so the reference-detection and link-rewriting logic is fully
// testable offline (tests/ folder). Lives at the repo root because releases
// ship as a flat zip of root files.
//
// HONESTY NOTE (v1.5 draft): several platform JSON field names handled below
// are INFERRED, not verified from this repo's code (v1.4.3 drops all
// non-text content before it ever reaches disk). Each detector says which
// tier it is. Every detector is defensive: unknown shapes return null / are
// skipped, never thrown. See docs/v1.5-architecture-notes.md section 2.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;           // Node (tests)
  } else {
    root.MediaUtils = api;          // service worker / popup window
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Placeholders ----------------------------------------------------
  // While normalizing, each media ref becomes a markdown image/link whose
  // target is `asset:<id>`. After download, rewriteAssetLinks() swaps the
  // target for the real relative path (assets/<file>), or a failure note.

  function makePlaceholder(id, alt, isImage) {
    const safeAlt = String(alt == null ? '' : alt).replace(/[\[\]\n\r]/g, ' ').trim() || 'attachment';
    return (isImage === false ? '' : '!') + '[' + safeAlt + '](asset:' + id + ')';
  }

  // Matches ![alt](asset:ID) and [alt](asset:ID)
  const PLACEHOLDER_RE = /(!?)\[([^\]\n]*)\]\(asset:([A-Za-z0-9_-]+)\)/g;

  /**
   * Replace asset placeholders with their final relative paths.
   * @param {string} text
   * @param {Object<string,string>} idToPath  e.g. { m0: 'assets/photo.png' }
   *        Missing ids are rewritten to an italic "unavailable" note so the
   *        export never ships a dangling asset: link.
   */
  function rewriteAssetLinks(text, idToPath) {
    if (typeof text !== 'string' || text.indexOf('](asset:') === -1) return text;
    return text.replace(PLACEHOLDER_RE, function (whole, bang, alt, id) {
      const path = idToPath && idToPath[id];
      if (path) {
        // The alt text is the ONLY thing visible when an image fails to
        // render (viewer sandbox, un-extracted zip, relative-path resolution)
        // — and the only way to match hundreds of exported images back to
        // their spot in the log. A generic "attachment" is useless for that.
        // So: keep a meaningful original alt, else surface the FILENAME (which
        // now encodes the message position, e.g. msg012-img1.png).
        const generic = !alt || alt === 'attachment';
        const shown = generic ? path.replace(/^assets\//, '') : alt;
        return bang + '[' + shown + '](' + path + ')';
      }
      return '*[' + (alt || 'attachment') + ' -- not exported (download failed or unsupported)]*';
    });
  }

  // ---- Filenames ---------------------------------------------------------

  function sanitizeAssetName(name) {
    const s = String(name == null ? '' : name)
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '')            // no dot-files / traversal
      .substring(0, 120);
    return s || 'file';
  }

  /**
   * Return `name` made unique against `used` (a Set of lowercase names),
   * inserting -2, -3... before the extension. Registers the result in `used`.
   */
  function uniqueName(name, used) {
    let base = name, ext = '';
    const dot = name.lastIndexOf('.');
    if (dot > 0) { base = name.slice(0, dot); ext = name.slice(dot); }
    let candidate = name, n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = base + '-' + n + ext;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  // Magic-byte sniff for the image types the platforms actually serve.
  // bytes: Uint8Array (first 16 bytes suffice). Returns 'png'|'jpg'|'gif'|'webp'|null.
  function sniffImageExt(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    return null;
  }

  // If `name` has no extension (or a clearly generic one), attach the sniffed one.
  function ensureExtension(name, sniffedExt) {
    if (!sniffedExt) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    if (ext && imageExts.indexOf(ext) !== -1) return name;   // trust existing image ext
    if (!ext || ext === 'bin' || ext === 'dat') {
      return (dot > 0 ? name.slice(0, dot) : name) + '.' + sniffedExt;
    }
    return name; // has some other ext (e.g. .pdf) -- leave it
  }

  function extFromMediaType(mediaType) {
    const m = String(mediaType || '').toLowerCase().match(/^image\/(png|jpeg|jpg|gif|webp)/);
    if (!m) return null;
    return m[1] === 'jpeg' ? 'jpg' : m[1];
  }

  // ---- Claude detection ----------------------------------------------------
  // Refs produced:
  //   { kind:'claude-url',    alt, name, url, isImage }        -- binary to download (cookie auth)
  //   { kind:'inline-text',   alt, name, text, isImage:false } -- extracted_content, no download
  //   { kind:'inline-base64', alt, name, base64, mediaType }   -- image block, no download

  // OBSERVED shape (real transcript of Anthropic-format messages):
  // content[] block { type:'image', source:{ type:'base64', media_type, data } }.
  function claudeContentBlockMedia(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type !== 'image') return null;
    const src = block.source;
    if (!src || typeof src !== 'object') return null;
    if (src.type === 'base64' && typeof src.data === 'string' && src.data) {
      return {
        kind: 'inline-base64',
        alt: 'image',
        name: null,
        base64: src.data,
        mediaType: src.media_type || null,
        isImage: true
      };
    }
    // URL-sourced image block (INFERRED companion shape)
    if (typeof src.url === 'string' && src.url) {
      return { kind: 'claude-url', alt: 'image', name: null, url: src.url, isImage: true };
    }
    return null;
  }

  // INFERRED: URL fields on file/attachment entries, direct or one level deep.
  function firstUrlField(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const direct = obj.preview_url || obj.file_url || obj.url || obj.download_url;
    if (typeof direct === 'string' && direct) return direct;
    const nestKeys = ['document', 'image', 'file', 'asset', 'preview_asset', 'document_asset'];
    for (let i = 0; i < nestKeys.length; i++) {
      const v = obj[nestKeys[i]];
      if (v && typeof v === 'object') {
        const u = v.url || v.preview_url || v.file_url || v.download_url;
        if (typeof u === 'string' && u) return u;
      }
    }
    return null;
  }

  // INFERRED: msg.files / msg.files_v2 (images) and msg.attachments
  // (text-like uploads with inline extracted_content) on claude.ai web
  // messages. onSkip(reason, entry) is called for unrecognized entries.
  function collectClaudeMessageMedia(msg, orgId, onSkip) {
    const refs = [];
    if (!msg || typeof msg !== 'object') return refs;

    const fileArrays = []
      .concat(Array.isArray(msg.files) ? msg.files : [])
      .concat(Array.isArray(msg.files_v2) ? msg.files_v2 : []);

    const seen = new Set(); // dedupe files/files_v2 overlap by uuid/url

    for (const f of fileArrays) {
      if (!f || typeof f !== 'object') continue;
      const name = f.file_name || f.name || null;
      let url = firstUrlField(f);
      // Fallback guess: construct the preview endpoint from the file uuid.
      if (!url && (f.file_uuid || f.uuid) && orgId) {
        url = '/api/organizations/' + orgId + '/files/' + (f.file_uuid || f.uuid) + '/preview';
      }
      const key = (f.file_uuid || f.uuid || url || name || '') + '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      if (url) {
        refs.push({
          kind: 'claude-url',
          alt: name || 'image',
          name: name || null,
          url: url,
          isImage: (f.file_kind || '').toLowerCase() === 'image' || !f.file_kind
        });
      } else if (onSkip) {
        onSkip('claude file entry without usable url', f);
      }
    }

    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const a of atts) {
      if (!a || typeof a !== 'object') continue;
      const name = a.file_name || a.name || 'attachment';
      if (typeof a.extracted_content === 'string' && a.extracted_content) {
        // Text-like upload: content is inline in the JSON -- bundle as text.
        const txtName = /\.(txt|md|csv|json|log)$/i.test(name) ? name : name + '.txt';
        refs.push({ kind: 'inline-text', alt: name, name: txtName, text: a.extracted_content, isImage: false });
      } else {
        const url = firstUrlField(a);
        if (url) {
          refs.push({ kind: 'claude-url', alt: name, name: name, url: url, isImage: false });
        } else if (onSkip) {
          onSkip('claude attachment without content or url', a);
        }
      }
    }

    return refs;
  }

  // ---- ChatGPT detection -----------------------------------------------------
  // All INFERRED (no ChatGPT fixture was available; see architecture notes).
  // Input: one non-string entry of message.content.parts[].
  // Output: { kind:'chatgpt-file', fileId, alt, name, isImage } or null.
  // Recognized shapes:
  //   { content_type:'image_asset_pointer', asset_pointer:'file-service://file-XXX', ... }
  //   { content_type:'image_asset_pointer', asset_pointer:'sediment://file_XXX', ... }
  //   { asset_pointer:'...' } with no content_type

  const ASSET_POINTER_RE = /^(?:file-service|sediment):\/\/(file[-_][A-Za-z0-9_-]+)/;

  function chatgptPartMedia(part) {
    if (!part || typeof part !== 'object') return null;
    const ap = part.asset_pointer;
    if (typeof ap !== 'string') return null;
    const m = ap.match(ASSET_POINTER_RE);
    if (!m) return null;
    const ct = String(part.content_type || '').toLowerCase();
    return {
      kind: 'chatgpt-file',
      fileId: m[1],
      alt: 'image',
      name: null,                              // may be filled from metadata.attachments
      isImage: ct === '' || ct.indexOf('image') !== -1
    };
  }

  // message.metadata.attachments[] (INFERRED): [{id:'file-XXX', name, mimeType|mime_type}]
  // Used only to recover human filenames for asset pointers.
  function chatgptAttachmentNames(metadata) {
    const map = {};
    const list = metadata && Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const a of list) {
      if (a && typeof a === 'object' && typeof a.id === 'string' && (a.name || a.file_name)) {
        map[a.id] = a.name || a.file_name;
      }
    }
    return map;
  }

  // ---- Asset naming (shared) -----------------------------------------------
  // Given the download results, assign final unique filenames and return
  // { idToPath, named }. `assets` items: { id, name|null, bytes?:Uint8Array,
  // mediaType?, ok:boolean, ... }. Failed items pass through and get no path
  // (so rewriteAssetLinks turns their placeholders into failure notes).

  /**
   * @param {Array} assets
   * @param {Object} [opts]
   * @param {Object<string,number>} [opts.idToMsg]  asset id -> 1-based message
   *   number (its position in the conversation). When present, generated names
   *   ENCODE THE POSITION (msg012-img1.png) so hundreds of exported images stay
   *   matchable to their spot in the log — and sort in conversation order.
   */
  function assignAssetNames(assets, opts) {
    const idToMsg = (opts && opts.idToMsg) || {};
    const used = new Set();
    const idToPath = {};
    const named = [];
    let counter = 1;
    const perMsg = {};  // message number -> running image count within it
    for (const a of assets) {
      if (!a || !a.ok) { named.push(a); continue; }
      const sniffed = (a.bytes ? sniffImageExt(a.bytes) : null) || extFromMediaType(a.mediaType);
      const ext = sniffed || 'png';
      let name = a.name ? sanitizeAssetName(a.name) : null;
      if (!name) {
        const msgNo = idToMsg[a.id];
        if (msgNo != null) {
          const n = (perMsg[msgNo] = (perMsg[msgNo] || 0) + 1);
          name = 'msg' + zeroPad(msgNo, 3) + '-img' + n + '.' + ext;
        } else {
          name = 'image-' + zeroPad(counter, 3) + '.' + ext;
        }
      }
      counter++;
      name = ensureExtension(name, sniffed);
      name = uniqueName(name, used);
      const path = 'assets/' + name;
      idToPath[a.id] = path;
      named.push(Object.assign({}, a, { finalName: name, path: path }));
    }
    return { idToPath: idToPath, named: named };
  }

  function zeroPad(n, width) {
    const s = String(n);
    return s.length >= width ? s : '0'.repeat(width - s.length) + s;
  }

  return {
    makePlaceholder: makePlaceholder,
    PLACEHOLDER_RE: PLACEHOLDER_RE,
    rewriteAssetLinks: rewriteAssetLinks,
    sanitizeAssetName: sanitizeAssetName,
    uniqueName: uniqueName,
    sniffImageExt: sniffImageExt,
    ensureExtension: ensureExtension,
    extFromMediaType: extFromMediaType,
    claudeContentBlockMedia: claudeContentBlockMedia,
    collectClaudeMessageMedia: collectClaudeMessageMedia,
    chatgptPartMedia: chatgptPartMedia,
    chatgptAttachmentNames: chatgptAttachmentNames,
    assignAssetNames: assignAssetNames
  };
});
