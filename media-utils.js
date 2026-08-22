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
  function rewriteAssetLinks(text, idToPath, idToNote) {
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
      const why = idToNote && idToNote[id];
      return why
        ? '*[' + (alt || 'attachment') + ' -- ' + why + ']*'
        : '*[' + (alt || 'attachment') + ' -- not exported (download failed or unsupported)]*';
    });
  }

  // ---- HTML export (v1.5) --------------------------------------------------
  // The self-contained .html deliverable embeds images as data URIs at their
  // placeholder positions. Everything here is pure string logic so the
  // XSS-safety and placeholder conversion are offline-testable.

  // Escape a string for safe interpolation into HTML text OR double-quoted
  // attribute values. Covers the five characters that matter; everything a
  // platform or user typed goes through here before touching the document.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ext (as returned by sniffImageExt/extFromMediaType) -> MIME for data URIs.
  function mimeFromExt(ext) {
    switch (String(ext || '').toLowerCase()) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      default: return 'application/octet-stream';
    }
  }

  /**
   * Convert one message text (raw, still carrying asset placeholders) into
   * HTML. ALL text is escaped -- a message containing "<script>" renders as
   * literal text, never as markup. Placeholders become, in order of priority:
   *
   *   ![alt](asset:id) + idToSrc[id]      -> <img src="..." alt/title="name">
   *        src may be a data URI (self-contained export) or a relative
   *        assets/ path (zip-fallback export) -- the caller decides.
   *   ![alt](asset:id) + no src           -> italic failure note, same wording
   *        convention as rewriteAssetLinks so the two formats stay consistent.
   *   [alt](asset:id)  + idToSrc[id]      -> <a href="src">name</a>
   *        (zip fallback: non-image files exist on disk next to the html).
   *   [alt](asset:id)  + no src           -> italic "not embeddable" note
   *        (self-contained export: non-image attachments have no inline form).
   *
   * @param {string} text
   * @param {Object<string,string>} idToSrc   asset id -> img src / link href
   * @param {Object<string,string>} idToName  asset id -> final filename
   *        (position-encoded, e.g. msg012-img1.png) used as alt/title so an
   *        image that fails to render still says where it belongs.
   */
  function convertPlaceholdersToHtml(text, idToSrc, idToName) {
    if (typeof text !== 'string') return '';
    if (text.indexOf('](asset:') === -1) return escapeHtml(text);
    // Fresh regex: PLACEHOLDER_RE is shared and sticky lastIndex across
    // callers would drop matches.
    const re = new RegExp(PLACEHOLDER_RE.source, 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      last = m.index + m[0].length;
      const isImage = m[1] === '!';
      const alt = m[2];
      const id = m[3];
      const src = idToSrc ? idToSrc[id] : null;
      const name = (idToName && idToName[id]) || null;
      // Prefer the position-encoded final filename; fall back to the
      // placeholder alt, then the raw id -- never an empty label.
      const label = name || alt || id;
      if (isImage) {
        if (src) {
          out += '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(label) +
                 '" title="' + escapeHtml(label) + '">';
        } else {
          out += '<em>[' + escapeHtml(alt || 'attachment') +
                 ' -- not exported (download failed or unsupported)]</em>';
        }
      } else {
        if (src) {
          out += '<a href="' + escapeHtml(src) + '">' + escapeHtml(label) + '</a>';
        } else {
          out += '<em>[' + escapeHtml(label) +
                 ' -- attachment, not embeddable in HTML export]</em>';
        }
      }
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  // ---- Grok: the <grok:render> image cards -------------------------------
  // MEASURED 2026-08-22 on a live conversation (30 cards), not inferred.
  // Grok writes image cards into the message text as custom tags:
  //   <grok:render card_id=".." card_type="image_card" type="render_searched_image">
  //     <argument name="image_id">nGhqr</argument>
  //     <argument name="size">"LARGE"</argument></grok:render>
  // and the matching card sits in response.cardAttachmentsJson as
  //   { id, type, cardType:'image_card', size,
  //     image: { thumbnail, source, title, link, original, image_id, ... } }
  //
  // These are WEB-SEARCH results, not Grok's own images and not the user's:
  // in the measured conversation every thumbnail was on Google's cache and the
  // originals sat on fourteen different third-party sites. So the exporter
  // does NOT download them. Bundling other people's photographs would need a
  // wildcard host permission -- the extension would become a bulk scraper of
  // arbitrary hosts, which is not what anyone installed. What it does instead
  // is keep the reference intact and readable: what was shown, where it came
  // from, and where to click. An archive that says "here was a photo from
  // katedaviesdesigns.com, here is the link" is honest; raw markup is not.
  const GROK_RENDER_RE = /<grok:render[^>]*?card_id="([^"]*)"[^>]*>([\s\S]*?)<\/grok:render>/g;

  // Every card, keyed by BOTH its own id and (for searched images) the
  // image_id the tag carries. Generated-image tags are EMPTY -- they identify
  // their card only through card_id -- so an index keyed on image_id alone
  // finds nothing for them. (Measured 2026-08-22 on both kinds.)
  function grokCardIndex(response) {
    const byId = {};
    const cards = response && response.cardAttachmentsJson;
    if (!Array.isArray(cards)) return byId;
    for (const c of cards) {
      let p = c;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { continue; } }
      if (!p || typeof p !== 'object') continue;
      if (p.id) byId[String(p.id)] = p;
      const img = p.image;
      if (img && typeof img === 'object') {
        const key = img.image_id || img.imageId;
        if (key) byId[String(key)] = p;
      }
    }
    return byId;
  }

  // Grok's own generated images. Shape measured 2026-08-22:
  //   { id, type:'render_generated_image', cardType:'generated_image_card',
  //     prompt, image_chunk:{ imageUrl:'users/<uid>/generated/<gid>/image.jpg',
  //                           imageTitle, imageModel, mimeType, resolution } }
  // imageUrl is RELATIVE to https://assets.grok.com/. Unlike the searched
  // images, these ARE the user's -- she asked for them, Grok made them, they
  // sit on Grok's own asset host -- so they get downloaded like any other
  // attachment. The prompt rides along as the alt text, because a generated
  // image without its prompt is half a record.
  const GROK_ASSETS = 'https://assets.grok.com/';

  function grokGeneratedCardRef(card) {
    if (!card || typeof card !== 'object') return null;
    if (String(card.cardType || '') !== 'generated_image_card') return null;
    const chunk = card.image_chunk || card.imageChunk;
    if (!chunk || typeof chunk !== 'object') return null;
    const rel = chunk.imageUrl || chunk.image_url;
    if (typeof rel !== 'string' || !rel) return null;
    const url = /^https?:\/\//i.test(rel) ? rel : GROK_ASSETS + rel.replace(/^\/+/, '');
    const prompt = String(card.prompt || '').replace(/[\[\]\n\r]/g, ' ').trim();
    const idx = (typeof chunk.imageIndex === 'number') ? chunk.imageIndex + 1 : null;
    const ext = /jpe?g/i.test(String(chunk.mimeType || '')) ? 'jpg' : 'png';
    return {
      kind: 'grok-url',
      url: url,
      name: 'grok-generated' + (idx ? '-' + idx : '') + '.' + ext,
      alt: prompt ? prompt.slice(0, 120) : (chunk.imageTitle || 'generated image'),
      isImage: true,
      generated: true,
      cardId: card.id ? String(card.id) : null
    };
  }

  function collectGrokCardMedia(response) {
    const refs = [];
    const byId = grokCardIndex(response);
    const seen = {};
    for (const key of Object.keys(byId)) {
      const card = byId[key];
      if (!card || !card.id || seen[card.id]) continue;
      const ref = grokGeneratedCardRef(card);
      if (ref) { seen[card.id] = true; refs.push(ref); }
    }
    return refs;
  }

  function hostOf(url) {
    const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
    return m ? m[1].replace(/^www\./, '') : '';
  }

  /**
   * Replace <grok:render> image-card tags with a readable reference line.
   * Unknown cards degrade to a plain note; nothing is ever left as raw markup.
   */
  function rewriteGrokRenderTags(text, response, idToPlaceholder) {
    if (typeof text !== 'string' || text.indexOf('<grok:render') === -1) return text;
    const byId = grokCardIndex(response);
    return text.replace(GROK_RENDER_RE, function (whole, cardId, inner) {
      const idm = /<argument name="image_id">([^<]*)<\/argument>/.exec(inner || '');
      const id = (idm ? idm[1].trim() : '') || String(cardId || '').trim();
      // A generated image was downloaded like any attachment: drop its
      // placeholder in, exactly where the card sat.
      const ph = idToPlaceholder && (idToPlaceholder[id] || idToPlaceholder[String(cardId || '')]);
      if (ph) return ph;
      const card = id && byId[id];
      if (card && String(card.cardType || '') === 'generated_image_card') {
        // The card data is right here; only the download did not happen. Say
        // that, and keep the prompt and the address -- "no card data" would be
        // a lie, and a generated image without its prompt is half a record.
        const ref = grokGeneratedCardRef(card);
        if (ref) {
          const label = ref.alt || 'generated image';
          return '[' + label + '](' + ref.url + ')';
        }
      }
      const img = card && card.image;
      if (!img) return '*[image card' + (id ? ' ' + id : '') + ' -- no card data in the export]*';
      const url = img.original || img.thumbnail || img.link || '';
      const title = String(img.title || '').replace(/[\[\]\n\r]/g, ' ').trim() || 'image';
      const site = hostOf(img.link) || hostOf(img.source) || hostOf(url);
      const label = site ? title + ' -- ' + site : title;
      if (!url) return '*[' + label + ' -- image card without a url]*';
      let out = '[' + label + '](' + url + ')';
      if (img.link && img.link !== url) out += ' ([source page](' + img.link + '))';
      return out;
    });
  }

  // Files the USER uploaded into a Grok conversation. Measured 2026-08-22/23
  // on a live chat, after an export came back without them:
  //   response.fileAttachments[i]              -> the file uuid (a bare string)
  //   response.fileAttachmentsMetadata[i]      -> { fileName, fileMimeType, fileUri }
  //   response.fileAttachmentAssetMetadata[i]  -> { assetId, key, previewImageKey,
  //                                                 sizeBytes, mimeType, name }
  // `key` is a path under https://assets.grok.com/ ending in /content and it
  // serves the ORIGINAL bytes -- for one measured upload, 324,893 bytes, the
  // exact sizeBytes from the metadata. `previewImageKey` ends in /preview-image
  // and gave 7,196 bytes for the same file, so it is only a fallback.
  // The three arrays line up by index. These are the user's own files on the
  // platform's own host: they are downloaded like any attachment.
  function collectGrokUploadMedia(response, onSkip) {
    const refs = [];
    if (!response || typeof response !== 'object') return refs;
    const meta = Array.isArray(response.fileAttachmentsMetadata) ? response.fileAttachmentsMetadata : [];
    const assets = Array.isArray(response.fileAttachmentAssetMetadata) ? response.fileAttachmentAssetMetadata : [];
    const count = Math.max(meta.length, assets.length);
    for (let i = 0; i < count; i++) {
      const m = meta[i] || {};
      const a = assets[i] || {};
      const rel = a.key || a.previewImageKey;
      const name = m.fileName || a.name || null;
      if (typeof rel !== 'string' || !rel) {
        if (name && onSkip) onSkip('grok upload without a storage key', { name: name });
        continue;
      }
      const mime = String(m.fileMimeType || a.mimeType || '');
      refs.push({
        kind: 'grok-url',
        url: /^https?:\/\//i.test(rel) ? rel : GROK_ASSETS + rel.replace(/^\/+/, ''),
        name: name,
        alt: name || 'attachment',
        isImage: mime.indexOf('image/') === 0,
        uploaded: true
      });
    }
    return refs;
  }

  // ---- Filenames ---------------------------------------------------------

  function sanitizeAssetName(name) {
    const s = String(name == null ? '' : name)
      // Control characters first: a NUL inside a zip entry name is malformed
      // and some extractors truncate the name there, which is a quiet way to
      // land a file somewhere other than where the archive says.
      .replace(/[\u0000-\u001f\u007f]/g, '')
      // Bidirectional overrides: "photo<U+202E>gnp.exe" DISPLAYS as
      // "photoexe.png" in every file manager while being an .exe on disk.
      // The platform supplies these names; we are the ones writing them to a
      // real filesystem, so we are the ones who strip the trick.
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[<>:"/\\|?*]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '')            // no dot-files / traversal
      .replace(/[. ]+$/, '')           // Windows silently drops these, which
                                       // turns "a." and "a" into a collision
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
    const base = dot > 0 ? name.slice(0, dot) : name;
    if (ext && imageExts.indexOf(ext) !== -1) {
      // The BYTES are the truth, not the name the human uploaded. Measured on
      // claude.ai 2026-08-22: its /files/{uuid}/preview endpoint re-encodes
      // everything to WebP and keeps the original filename, so "Evermore.png"
      // arrives as image/webp (1344x896) and "photo.JPG" likewise. A .png that
      // holds WebP bytes opens in some viewers and silently fails in others.
      // So the extension follows the signature; the base name — the part a
      // human recognises months later — is kept exactly.
      const same = (ext === sniffedExt) || (ext === 'jpeg' && sniffedExt === 'jpg');
      return same ? name : base + '.' + sniffedExt;
    }
    if (!ext || ext === 'bin' || ext === 'dat') {
      return base + '.' + sniffedExt;
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
      const fileKind = String(f.file_kind || '').toLowerCase();
      const looksImage = fileKind === 'image' || !fileKind;
      let url = firstUrlField(f);
      // Fallback guess: construct the preview endpoint from the file uuid --
      // but ONLY for images. Measured 2026-08-22 on a live account: an
      // uploaded document arrives as file_kind:'blob' with no url fields at
      // all and a `path` of /mnt/user-data/uploads/... (a container path, not
      // a URL), and EVERY file endpoint 404s for it -- /preview, /download,
      // /content, /document, /raw, bare, on both /api/{org}/ and
      // /api/organizations/{org}/. Guessing a preview URL for those turned a
      // platform limitation into a fake "download failed", which reads like
      // our bug in an archive someone keeps for years.
      if (!url && looksImage && (f.file_uuid || f.uuid) && orgId) {
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
          isImage: looksImage
        });
      } else if (f.file_uuid || f.uuid || name) {
        // A real upload we cannot reach -- not a failure of ours: say so in
        // the export. (An entry with neither a name nor a uuid is not a file
        // at all; those stay silently skipped, as before.)
        refs.push({
          kind: 'unavailable',
          alt: name || 'file',
          name: name || null,
          isImage: false,
          reason: 'uploaded file - claude.ai does not serve its contents through the web API'
        });
        if (onSkip) onSkip('claude file entry without usable url', f);
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

  // ---- Grok detection (INFERRED) -------------------------------------------
  // Grok's REST load-responses payload is normalized in background.js from
  // `responses[].message` (text) — that path is VERIFIED. Whether Grok exposes
  // ASSISTANT-GENERATED images (Aurora/Flux) in that same response object, and
  // under which field, is entirely INFERRED: no Grok media fixture or live
  // sample was available. This detector is therefore purely defensive —
  // feature-detect a small set of plausible image-URL-bearing shapes, return a
  // list of refs, and return [] (never throw) for anything unrecognized.
  //
  // Recognized (guessed) shapes on a single `response` object:
  //   response.generatedImageUrls: [ 'https://...' , ... ]   (array of urls)
  //   response.imageUrls / response.image_urls: [ url, ... ]
  //   response.attachments / response.mediaAttachments: [ { url|imageUrl|image_url, fileName|name } ]
  //   response.image / response.generatedImage: { url|imageUrl|image_url }
  // Each url becomes a { kind:'grok-url', url, name, alt:'generated image',
  // isImage:true, generated:true } ref. onSkip(reason, entry) is called for
  // entries that look media-ish but carry no usable url.
  function collectGrokResponseMedia(response, onSkip) {
    const refs = [];
    if (!response || typeof response !== 'object') return refs;

    const pushUrl = function (url, name) {
      if (typeof url !== 'string' || !url) return false;
      refs.push({
        kind: 'grok-url',
        url: url,
        name: name || null,
        alt: name || 'generated image',
        isImage: true,
        generated: true
      });
      return true;
    };

    // 1) Plain url-array fields.
    const urlArrayKeys = ['generatedImageUrls', 'imageUrls', 'image_urls'];
    for (let i = 0; i < urlArrayKeys.length; i++) {
      const arr = response[urlArrayKeys[i]];
      if (Array.isArray(arr)) {
        for (const u of arr) pushUrl(u, null);
      }
    }

    // 2) Attachment-like arrays of objects.
    const attArrayKeys = ['attachments', 'mediaAttachments', 'media', 'images'];
    for (let i = 0; i < attArrayKeys.length; i++) {
      const arr = response[attArrayKeys[i]];
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        if (!a || typeof a !== 'object') {
          if (typeof a === 'string' && a) { pushUrl(a, null); continue; }
          continue;
        }
        const url = a.url || a.imageUrl || a.image_url || a.downloadUrl || a.download_url || firstUrlField(a);
        const name = a.fileName || a.file_name || a.name || null;
        if (url) pushUrl(url, name);
        else if (onSkip) onSkip('grok attachment without usable url', a);
      }
    }

    // 3) Single nested image object.
    const objKeys = ['image', 'generatedImage', 'generated_image'];
    for (let i = 0; i < objKeys.length; i++) {
      const o = response[objKeys[i]];
      if (o && typeof o === 'object') {
        const url = o.url || o.imageUrl || o.image_url || firstUrlField(o);
        const name = o.fileName || o.file_name || o.name || null;
        if (url) pushUrl(url, name);
        else if (onSkip) onSkip('grok image object without usable url', o);
      }
    }

    return refs;
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
    escapeHtml: escapeHtml,
    mimeFromExt: mimeFromExt,
    convertPlaceholdersToHtml: convertPlaceholdersToHtml,
    sanitizeAssetName: sanitizeAssetName,
    uniqueName: uniqueName,
    sniffImageExt: sniffImageExt,
    ensureExtension: ensureExtension,
    extFromMediaType: extFromMediaType,
    claudeContentBlockMedia: claudeContentBlockMedia,
    collectClaudeMessageMedia: collectClaudeMessageMedia,
    chatgptPartMedia: chatgptPartMedia,
    chatgptAttachmentNames: chatgptAttachmentNames,
    collectGrokResponseMedia: collectGrokResponseMedia,
    rewriteGrokRenderTags: rewriteGrokRenderTags,
    collectGrokCardMedia: collectGrokCardMedia,
    collectGrokUploadMedia: collectGrokUploadMedia,
    grokGeneratedCardRef: grokGeneratedCardRef,
    grokCardIndex: grokCardIndex,
    assignAssetNames: assignAssetNames
  };
});
