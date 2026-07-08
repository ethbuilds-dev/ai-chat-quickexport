// popup.js — Multi-platform AI Conversation Exporter

// Load saved labels
chrome.storage.sync.get(
  { userLabel: '', assistantLabel: '' },
  (settings) => {
    document.getElementById('userLabel').value = settings.userLabel;
    document.getElementById('assistantLabel').value = settings.assistantLabel;
    updateFilenamePreview();
  }
);

function setStatus(text, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = type;
}

function saveLabels() {
  const userLabel = document.getElementById('userLabel').value.trim() || 'USER';
  const assistantLabel = document.getElementById('assistantLabel').value.trim() || 'ASSISTANT';
  chrome.storage.sync.set({ userLabel, assistantLabel });
  return { userLabel, assistantLabel };
}

// Detect platform and conversation ID from URL
function detectPlatform(url) {
  if (!url) return null;

  // ChatGPT
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) return { platform: 'chatgpt', conversationId: match[1], name: 'ChatGPT' };
  }

  // Claude
  if (url.includes('claude.ai')) {
    const match = url.match(/\/chat\/([a-f0-9-]+)/);
    if (match) return { platform: 'claude', conversationId: match[1], name: 'Claude' };
  }

  // Gemini
  if (url.includes('gemini.google.com')) {
    const match = url.match(/\/app\/([a-f0-9]+)/);
    if (match) return { platform: 'gemini', conversationId: match[1], name: 'Gemini' };
  }

  // Grok
  if (url.includes('grok.com')) {
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) return { platform: 'grok', conversationId: match[1], name: 'Grok' };
  }

  return null;
}

// Build the base filename (no extension): Platform_UserLabel_AssistantLabel_Date_ConversationID
function buildBaseFilename(detected, userLabel, assistantLabel) {
  return `${detected.name}_${sanitize(userLabel)}_${sanitize(assistantLabel)}_${new Date().toISOString().slice(0, 10)}_${detected.conversationId.slice(0, 8)}`;
}

// Refresh the filename preview from the active tab + current label inputs. Runs
// on popup open and whenever a label changes. Leaves the field empty when the
// active tab isn't a supported conversation.
async function updateFilenamePreview() {
  const field = document.getElementById('exportFilename');
  if (!field) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const detected = detectPlatform(tab?.url);
    if (!detected || !detected.conversationId) {
      field.value = '';
      return;
    }
    const userLabel = document.getElementById('userLabel').value.trim() || 'USER';
    const assistantLabel = document.getElementById('assistantLabel').value.trim() || 'ASSISTANT';
    field.value = buildBaseFilename(detected, userLabel, assistantLabel);
  } catch (err) {
    field.value = '';
  }
}

async function doExport(format) {
  const labels = saveLabels();
  setStatus('Detecting platform...', 'info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const detected = detectPlatform(tab?.url);

    if (!detected) {
      setStatus('Open a supported AI conversation (ChatGPT, Claude, Gemini, Grok)', 'error');
      return;
    }

    if (!detected.conversationId) {
      setStatus(detected.name + ' — not yet supported', 'error');
      return;
    }

    setStatus(`Extracting from ${detected.name}...`, 'info');

    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_FETCH',
      conversationId: detected.conversationId,
      tabId: tab.id,
      platform: detected.platform
    });

    if (response.error) {
      setStatus('Error: ' + response.error, 'error');
      return;
    }

    const data = response.data;
    const title = data.title || 'Untitled';
    const messages = data.messages || [];

    if (messages.length === 0) {
      setStatus('No exportable messages found', 'error');
      return;
    }

    // v1.5: conversations that carry media refs take the bundle path (zip
    // with an assets/ folder). `media` is only ever present when background
    // found at least one image/attachment, so plain conversations continue
    // through the unchanged v1.4.3 code below.
    const media = Array.isArray(data.media) ? data.media : [];
    if (media.length > 0) {
      await doMediaExport(detected, tab, media, messages, labels, format, title);
      return;
    }

    setStatus(`${messages.length} messages, preparing ${format}...`, 'info');

    let content, mimeType;

    if (format === 'json') {
      content = generateJSON(title, messages, labels.userLabel, labels.assistantLabel);
      mimeType = 'application/json';
    } else if (format === 'html') {
      // v1.5: text-only conversations go through the SAME generator as media
      // ones -- with no maps every message is plain escaped text, no data URIs.
      content = generateHTML(title, messages, labels.userLabel, labels.assistantLabel);
      mimeType = 'text/html';
    } else {
      content = generateMD(title, messages, labels.userLabel, labels.assistantLabel);
      mimeType = 'text/markdown';
    }

    // Use whatever is in the filename field (the user may have edited it),
    // falling back to the auto-generated base, then append the format extension.
    const base = document.getElementById('exportFilename').value.trim() ||
      buildBaseFilename(detected, labels.userLabel, labels.assistantLabel);
    const filename = sanitize(base) + '.' + format;

    // Download via the chrome.downloads API (needs the "downloads" permission).
    // The old anchor-click from the popup context was fragile — large blobs +
    // popup teardown produced Chrome "failed due to insufficient permissions"
    // even with site auto-downloads allowed. chrome.downloads is the robust path.
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({ url, filename, saveAs: false }, () => {
        if (chrome.runtime.lastError) {
          setStatus('Download blocked: ' + chrome.runtime.lastError.message, 'error');
        }
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // Word count
    const counts = countWords(messages);
    setStatus(`Exported ${messages.length} messages from ${detected.name}`, 'success');
    showWordCount(counts);

  } catch (err) {
    setStatus('Failed: ' + err.message, 'error');
  }
}

// ── v1.5 media export ────────────────────────────────────────────────
// Downloads the referenced assets via background, rewrites the asset
// placeholders inside the message texts to relative assets/ paths, runs the
// SAME generators as the plain path, and downloads one zip. If every asset
// fails, falls back to a plain single file whose placeholders become
// human-readable failure notes — the export never silently disappears.

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Same chrome.downloads call as the v1.4.3 path (kept separate on purpose —
// the plain-export code below stays byte-identical to v1.4.3).
// Anchor-based download: respects the `download` filename synchronously,
// avoiding the chrome.downloads blob-URL-UUID fallback seen on larger zips.
function downloadBlobViaAnchor(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadBlobFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Download blocked: ' + chrome.runtime.lastError.message, 'error');
      }
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function doMediaExport(detected, tab, media, messages, labels, format, title) {
  setStatus(`Downloading ${media.length} attachment${media.length === 1 ? '' : 's'}...`, 'info');

  let assets = [];
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'FETCH_MEDIA',
      media,
      platform: detected.platform,
      tabId: tab.id
    });
    if (resp && Array.isArray(resp.assets)) {
      assets = resp.assets;
    } else if (resp && resp.error) {
      console.warn('[Exporter] media fetch error:', resp.error);
    }
  } catch (err) {
    console.warn('[Exporter] media fetch failed:', err);
  }

  // Decode to bytes (needed for sniffing and for the zip entries).
  const withBytes = assets.map(a => {
    if (!a || !a.ok || typeof a.base64 !== 'string') return a;
    try {
      return Object.assign({}, a, { bytes: base64ToBytes(a.base64) });
    } catch (e) {
      return Object.assign({}, a, { ok: false, error: 'base64 decode failed' });
    }
  });

  // Map each asset id to its 1-based message position, so asset filenames can
  // encode WHERE in the log the image lives (msg012-img1.png) — the fix for
  // matching hundreds of images back to the conversation. Scan message texts
  // in order for ](asset:ID) placeholders.
  const idToMsg = {};
  messages.forEach((m, i) => {
    const t = (m && typeof m.text === 'string') ? m.text : '';
    if (t.indexOf('](asset:') === -1) return;
    const re = /\]\(asset:([A-Za-z0-9_-]+)\)/g;
    let match;
    while ((match = re.exec(t)) !== null) {
      if (idToMsg[match[1]] == null) idToMsg[match[1]] = i + 1;
    }
  });

  const assigned = MediaUtils.assignAssetNames(withBytes, { idToMsg: idToMsg });

  // v1.5 HTML deliverable: images embed as base64 data URIs at their
  // placeholder positions -- ONE self-contained .html, no assets folder,
  // double-click opens in any browser. Handled before the md/json rewrite
  // below so those code paths stay byte-identical to before.
  if (format === 'html') {
    doHtmlMediaExport(detected, media, messages, labels, title, assigned);
    return;
  }

  // Rewrite placeholders in the message texts BEFORE generating, so both
  // .md and .json formats carry the final relative links (or failure notes).
  const rewritten = messages.map(m =>
    Object.assign({}, m, { text: MediaUtils.rewriteAssetLinks(m.text, assigned.idToPath) })
  );

  setStatus(`${rewritten.length} messages, preparing ${format}...`, 'info');

  let content, mimeType;
  if (format === 'json') {
    content = generateJSON(title || 'Untitled', rewritten, labels.userLabel, labels.assistantLabel);
    mimeType = 'application/json';
  } else {
    content = generateMD(title || 'Untitled', rewritten, labels.userLabel, labels.assistantLabel);
    mimeType = 'text/markdown';
  }

  const base = sanitize(
    document.getElementById('exportFilename').value.trim() ||
    buildBaseFilename(detected, labels.userLabel, labels.assistantLabel)
  );

  const okAssets = assigned.named.filter(a => a && a.ok && a.path && a.bytes);
  const failedCount = media.length - okAssets.length;

  if (okAssets.length === 0) {
    // Nothing downloadable — ship the plain file; placeholders are already
    // rewritten into visible "not exported" notes.
    downloadBlobFile(new Blob([content], { type: mimeType }), base + '.' + format);
    const counts = countWords(rewritten);
    setStatus(`Exported ${rewritten.length} messages — attachments could not be downloaded`, 'info');
    showWordCount(counts);
    return;
  }

  setStatus('Packing zip...', 'info');
  let zipBytes;
  try {
    const entries = [{ name: base + '.' + format, data: content }];
    for (const a of okAssets) entries.push({ name: a.path, data: a.bytes });
    zipBytes = ZipWriter.createZip(entries);
  } catch (err) {
    // Zip failure must not lose the conversation text.
    console.warn('[Exporter] zip failed, exporting plain file:', err);
    downloadBlobFile(new Blob([content], { type: mimeType }), base + '.' + format);
    setStatus(`Exported ${rewritten.length} messages (zip failed: ${err.message})`, 'info');
    return;
  }

  // Bug: the larger zip blob intermittently downloaded as the blob-URL UUID
  // instead of `base` (chrome.downloads race on a blob that outlives the
  // popup). The anchor-download path respects the `download` attribute name
  // synchronously — use it for the zip; the plain-text path is untouched.
  downloadBlobViaAnchor(new Blob([zipBytes], { type: 'application/zip' }), base + '.zip');

  const counts = countWords(rewritten);
  const failNote = failedCount > 0 ? `, ${failedCount} failed` : '';
  setStatus(
    `Exported ${rewritten.length} messages + ${okAssets.length} attachment${okAssets.length === 1 ? '' : 's'}${failNote} from ${detected.name}`,
    failedCount > 0 ? 'info' : 'success'
  );
  showWordCount(counts);
}

// ── v1.5 HTML export ─────────────────────────────────────────────────
// Self-contained .html with images embedded as data URIs. If the embedded
// payload would be too large for one file, falls back to the zip layout
// (html + assets/ folder with relative links) with a clear status message.

// Size guard: browsers/editors choke on multi-hundred-MB single documents,
// and base64 inflates bytes by 4/3. Above ~80 MB of *embedded* (base64)
// size we switch to the zip fallback instead of producing an .html that
// may not open. 80 MB embedded ≈ 60 MB of raw image bytes.
const HTML_EMBED_CAP_BYTES = 80 * 1024 * 1024;

function doHtmlMediaExport(detected, media, messages, labels, title, assigned) {
  // Final position-encoded filenames (msgNNN-imgN.ext) double as alt/title
  // text so every image stays matchable to its spot in the conversation.
  const idToName = {};
  for (const a of assigned.named) {
    if (a && a.ok && a.finalName) idToName[a.id] = a.finalName;
  }

  // Which refs are images? The media refs carry isImage from detection;
  // only images can be embedded as <img> data URIs.
  const imageIds = new Set(
    media.filter(r => r && r.isImage !== false && r.id != null).map(r => r.id)
  );

  const okAssets = assigned.named.filter(a => a && a.ok && a.path && a.bytes);
  const embeddable = okAssets.filter(a => imageIds.has(a.id) && typeof a.base64 === 'string');
  const failedCount = media.length - okAssets.length;

  const base = sanitize(
    document.getElementById('exportFilename').value.trim() ||
    buildBaseFilename(detected, labels.userLabel, labels.assistantLabel)
  );

  // Embedded size = the base64 text that will actually sit inside the file.
  const embeddedSize = embeddable.reduce((sum, a) => sum + a.base64.length, 0);

  if (embeddedSize > HTML_EMBED_CAP_BYTES) {
    // Too big for one self-contained file -- zip fallback: the html links
    // images via relative assets/ paths (renders fine once extracted) and
    // non-image files ride along in assets/ as clickable links.
    const html = generateHTML(title || 'Untitled', messages, labels.userLabel, labels.assistantLabel, {
      idToSrc: assigned.idToPath,
      idToName: idToName
    });
    setStatus('Packing zip...', 'info');
    let zipBytes;
    try {
      const entries = [{ name: base + '.html', data: html }];
      for (const a of okAssets) entries.push({ name: a.path, data: a.bytes });
      zipBytes = ZipWriter.createZip(entries);
    } catch (err) {
      console.warn('[Exporter] zip failed, exporting plain html:', err);
      const plain = generateHTML(title || 'Untitled', messages, labels.userLabel, labels.assistantLabel, { idToName: idToName });
      downloadBlobViaAnchor(new Blob([plain], { type: 'text/html' }), base + '.html');
      setStatus(`Exported ${messages.length} messages (zip failed: ${err.message})`, 'info');
      return;
    }
    downloadBlobViaAnchor(new Blob([zipBytes], { type: 'application/zip' }), base + '.zip');
    const mb = Math.round(embeddedSize / (1024 * 1024));
    setStatus(
      `Media too large to embed (~${mb} MB > 80 MB cap) — exported zip with assets folder instead`,
      'info'
    );
    showWordCount(countWords(messages));
    return;
  }

  // Normal path: every downloaded image becomes a data URI at its exact
  // placeholder position. Failed downloads render as italic notes; non-image
  // attachments render as labeled "not embeddable" notes (both handled by
  // MediaUtils.convertPlaceholdersToHtml inside generateHTML).
  const idToSrc = {};
  for (const a of embeddable) {
    const ext = MediaUtils.sniffImageExt(a.bytes) || MediaUtils.extFromMediaType(a.mediaType) || 'png';
    idToSrc[a.id] = 'data:' + MediaUtils.mimeFromExt(ext) + ';base64,' + a.base64;
  }

  setStatus(`${messages.length} messages, preparing html...`, 'info');
  const html = generateHTML(title || 'Untitled', messages, labels.userLabel, labels.assistantLabel, {
    idToSrc: idToSrc,
    idToName: idToName
  });

  // Large embedded-image .html hits the same chrome.downloads blob-UUID race
  // as the zip did (filename dropped to the blob id). Anchor download keeps it.
  downloadBlobViaAnchor(new Blob([html], { type: 'text/html' }), base + '.html');

  const embeddedCount = Object.keys(idToSrc).length;
  const noteParts = [];
  if (failedCount > 0) noteParts.push(`${failedCount} failed`);
  const notEmbeddable = okAssets.length - embeddable.length;
  if (notEmbeddable > 0) noteParts.push(`${notEmbeddable} non-image noted`);
  const note = noteParts.length ? ` (${noteParts.join(', ')})` : '';
  setStatus(
    `Exported ${messages.length} messages + ${embeddedCount} image${embeddedCount === 1 ? '' : 's'} embedded${note} from ${detected.name}`,
    failedCount > 0 ? 'info' : 'success'
  );
  showWordCount(countWords(messages));
}

// Generators
function generateMD(title, messages, userLabel, assistantLabel) {
  const counts = countWords(messages);
  const lines = [];
  lines.push(`# ${title}`);
  lines.push(`\n> Word count — ${userLabel}: ${counts.userWords.toLocaleString()} · ${assistantLabel}: ${counts.assistantWords.toLocaleString()} · Total: ${counts.total.toLocaleString()}`);
  let current = null;

  for (const msg of messages) {
    const label = msg.role === 'user' ? userLabel : assistantLabel;
    if (label !== current) {
      current = label;
      lines.push(`\n\n[${label}]`);
    }
    lines.push(msg.text);
  }

  return lines.join('\n').trim();
}

function generateJSON(title, messages, userLabel, assistantLabel) {
  const counts = countWords(messages);
  return JSON.stringify({
    title,
    exported: new Date().toISOString(),
    message_count: messages.length,
    word_count: {
      user: counts.userWords,
      assistant: counts.assistantWords,
      total: counts.total
    },
    messages: messages.map(m => ({
      speaker: m.role === 'user' ? userLabel : assistantLabel,
      role: m.role,
      text: m.text
    }))
  }, null, 2);
}

// v1.5: self-contained HTML export. Same content conventions as generateMD
// (word-count header, [Label] speaker markers on alternation) rendered as
// clean semantic HTML with inline CSS -- readable in any browser (and Word/
// LibreOffice, which both open .html). ALL user/platform text is escaped via
// MediaUtils (XSS-safe); line breaks are preserved with white-space:pre-wrap.
// mediaMaps (optional): { idToSrc, idToName } -- see
// MediaUtils.convertPlaceholdersToHtml for how asset placeholders become
// <img> tags, links, or visible failure/not-embeddable notes. Without maps
// (text-only conversations) messages pass through as escaped text.
function generateHTML(title, messages, userLabel, assistantLabel, mediaMaps) {
  const esc = MediaUtils.escapeHtml;
  const idToSrc = (mediaMaps && mediaMaps.idToSrc) || {};
  const idToName = (mediaMaps && mediaMaps.idToName) || {};
  const counts = countWords(messages);

  const body = [];
  let current = null;
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const label = msg.role === 'user' ? userLabel : assistantLabel;
    if (label !== current) {
      current = label;
      body.push(`<div class="speaker ${role}">[${esc(label)}]</div>`);
    }
    body.push(`<div class="msg ${role}">${MediaUtils.convertPlaceholdersToHtml(msg.text, idToSrc, idToName)}</div>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body {
    font-family: Georgia, 'Times New Roman', serif;
    line-height: 1.6;
    color: #222;
    background: #fdfdfa;
    max-width: 46rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }
  h1 {
    font-size: 1.6rem;
    line-height: 1.3;
    margin: 0 0 0.5rem;
  }
  .meta {
    color: #666;
    font-size: 0.85rem;
    border-bottom: 1px solid #ddd;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
  }
  .speaker {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 1.75rem 0 0.5rem;
  }
  .speaker.user { color: #1a5fb4; }
  .speaker.assistant { color: #613583; }
  .msg {
    white-space: pre-wrap;      /* preserve the conversation's line breaks */
    overflow-wrap: break-word;
    margin: 0 0 0.75rem;
  }
  .msg img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0.75rem 0;
    border: 1px solid #ddd;
    border-radius: 6px;
  }
  .msg em { color: #888; }      /* failure / not-embeddable notes */
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">Word count — ${esc(userLabel)}: ${counts.userWords.toLocaleString()} · ${esc(assistantLabel)}: ${counts.assistantWords.toLocaleString()} · Total: ${counts.total.toLocaleString()}</div>
${body.join('\n')}
</body>
</html>
`;
}

function countWords(messages) {
  let userWords = 0;
  let assistantWords = 0;
  for (const msg of messages) {
    const wc = msg.text ? msg.text.trim().split(/\s+/).filter(w => w.length > 0).length : 0;
    if (msg.role === 'user') userWords += wc;
    else assistantWords += wc;
  }
  return { userWords, assistantWords, total: userWords + assistantWords };
}

function showWordCount(counts) {
  const el = document.getElementById('wordcount');
  if (el) {
    el.style.display = 'block';
    el.innerHTML =
      `<span class="wc-label">User:</span> <span class="wc-num">${counts.userWords.toLocaleString()}</span> · ` +
      `<span class="wc-label">Assistant:</span> <span class="wc-num">${counts.assistantWords.toLocaleString()}</span> · ` +
      `<span class="wc-label">Total:</span> <span class="wc-num">${counts.total.toLocaleString()}</span>`;
  }
}

function sanitize(title) {
  return title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').substring(0, 100);
}

// Event listeners
document.getElementById('exportMd').addEventListener('click', () => doExport('md'));
document.getElementById('exportJson').addEventListener('click', () => doExport('json'));
document.getElementById('exportHtml').addEventListener('click', () => doExport('html'));

// Keep the filename preview in sync with the labels as they're typed.
document.getElementById('userLabel').addEventListener('input', updateFilenamePreview);
document.getElementById('assistantLabel').addEventListener('input', updateFilenamePreview);
