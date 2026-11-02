#!/usr/bin/env node
// tests/run-tests.js — offline quality gate for the v1.5 media-export logic.
// Run:  node tests/run-tests.js
// No dependencies. Tests only the pure root modules (background.js/popup.js
// need chrome.* and are covered by docs/v1.5-MANUAL-TEST-PLAN.md instead) -
// except the theme section at the end, which runs popup.js itself in a vm
// sandbox with a stub chrome.* and DOM.

'use strict';

const path = require('path');
const fs = require('fs');

const MediaUtils = require(path.join(__dirname, '..', 'media-utils.js'));
const ZipWriter = require(path.join(__dirname, '..', 'zipwriter.js'));
// background.js exports the pure tree-walker under Node (importScripts is
// guarded; MediaUtils is require()'d there) so the REAL walker — not a copy —
// is exercised against fixtures.
const { walkChatGPTTree, fetchRetrying, aistudioReadPage, aistudioTurnsToMessages, aistudioCleanTitle } =
  require(path.join(__dirname, '..', 'background.js'));

let passed = 0, failed = 0;
let RETRY_SUITE = Promise.resolve();
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (detail ? ' -- got: ' + detail : '')); }
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// ---- 1. Claude media detection ----------------------------------------
console.log('\n[claude detection]');
{
  const fx = loadFixture('claude-messages.json');
  const skips = [];
  const all = fx.messages.map(m =>
    MediaUtils.collectClaudeMessageMedia(m, fx.org_id, (why) => skips.push(why)));

  check('msg0: one image ref', all[0].length === 1, all[0].length);
  check('msg0: url from preview_url', all[0][0] && all[0][0].url === '/api/organizations/org-1234/files/aaaa-bbbb-cccc/preview');
  check('msg0: keeps original filename', all[0][0] && all[0][0].name === 'bug screenshot.png');
  check('msg0: kind claude-url', all[0][0] && all[0][0].kind === 'claude-url');

  check('msg1 (plain text): no refs', all[1].length === 0, all[1].length);

  check('msg2: inline-text attachment captured', all[2].length === 1 && all[2][0].kind === 'inline-text');
  check('msg2: extracted content preserved', all[2][0] && all[2][0].text.includes('NullPointerException'));
  check('msg2: .log name kept', all[2][0] && all[2][0].name === 'server.log');

  check('msg3: files_v2 uuid -> constructed preview url', all[3].length === 1 &&
    all[3][0].url === '/api/organizations/org-1234/files/dddd-eeee-ffff/preview');

  check('msg4: unknown shape skipped, not thrown', all[4].length === 0, all[4].length);
  check('msg4: skip was reported', skips.length === 1, skips.length);

  // OBSERVED shape: inline base64 image content block
  const imgBlock = fx.messages[5].content[1];
  const ref = MediaUtils.claudeContentBlockMedia(imgBlock);
  check('msg5: inline base64 image block detected', !!ref && ref.kind === 'inline-base64');
  check('msg5: media_type carried', !!ref && ref.mediaType === 'image/png');
  check('msg5: base64 payload carried', !!ref && ref.base64.length > 20);
  check('text block -> null', MediaUtils.claudeContentBlockMedia(fx.messages[5].content[0]) === null);
  check('thinking block -> null', MediaUtils.claudeContentBlockMedia({ type: 'thinking', thinking: 'x' }) === null);
  check('malformed image block -> null (not thrown)', MediaUtils.claudeContentBlockMedia({ type: 'image', source: 'oops' }) === null);
}

// ---- 2. ChatGPT media detection ----------------------------------------
console.log('\n[chatgpt detection]');
{
  const fx = loadFixture('chatgpt-mapping.json');
  const n1 = fx.mapping.n1.message;
  const n3 = fx.mapping.n3.message;

  const ref1 = MediaUtils.chatgptPartMedia(n1.content.parts[0]);
  check('file-service pointer detected', !!ref1 && ref1.fileId === 'file-AbC123xyz', ref1 && ref1.fileId);
  check('pointer flagged as image', !!ref1 && ref1.isImage === true);

  const names = MediaUtils.chatgptAttachmentNames(n1.metadata);
  check('attachment name recovered', names['file-AbC123xyz'] === 'wiring diagram.png');

  const ref2 = MediaUtils.chatgptPartMedia(n3.content.parts[1]);
  check('sediment pointer detected', !!ref2 && ref2.fileId === 'file_00001111222233334444', ref2 && ref2.fileId);

  check('string part -> null', MediaUtils.chatgptPartMedia(n3.content.parts[0]) === null);
  check('unknown object part -> null (not thrown)', MediaUtils.chatgptPartMedia(n3.content.parts[2]) === null);
  check('no metadata -> empty name map', Object.keys(MediaUtils.chatgptAttachmentNames(undefined)).length === 0);
}

// ---- 3. Placeholders & link rewriting ----------------------------------
console.log('\n[placeholders + rewriting]');
{
  const ph = MediaUtils.makePlaceholder('m0', 'bug screenshot.png', true);
  check('image placeholder shape', ph === '![bug screenshot.png](asset:m0)', ph);
  const phFile = MediaUtils.makePlaceholder('m1', 'server.log', false);
  check('non-image placeholder (no bang)', phFile === '[server.log](asset:m1)', phFile);
  const phEvil = MediaUtils.makePlaceholder('m2', 'a]b[c\nd', true);
  check('alt sanitized against ] [ newline', phEvil.indexOf(']b') === -1 && phEvil.indexOf('\n') === -1, phEvil);

  const text = 'Before\n' + ph + '\nmid ' + phFile + ' after\n![gone](asset:m9)';
  const out = MediaUtils.rewriteAssetLinks(text, { m0: 'assets/bug-screenshot.png', m1: 'assets/server.log' });
  check('image link rewritten', out.includes('![bug screenshot.png](assets/bug-screenshot.png)'));
  check('file link rewritten', out.includes('[server.log](assets/server.log)'));
  check('missing id -> failure note', out.includes('not exported') && !out.includes('asset:m9'));
  check('surrounding text untouched', out.startsWith('Before\n') && out.includes('mid ') && out.includes(' after'));

  const plain = 'no placeholders here ![real](https://x/y.png)';
  check('text without placeholders returned unchanged (identity)', MediaUtils.rewriteAssetLinks(plain, {}) === plain);
}

// ---- 4. Filenames, sniffing, dedupe ------------------------------------
console.log('\n[names + sniff]');
{
  check('sanitize strips reserved chars', MediaUtils.sanitizeAssetName('a<b>?.png') === 'ab.png', MediaUtils.sanitizeAssetName('a<b>?.png'));
  check('sanitize spaces -> dashes', MediaUtils.sanitizeAssetName('my file.png') === 'my-file.png');
  check('sanitize traversal prefix stripped', !MediaUtils.sanitizeAssetName('..\\..\\evil').startsWith('.'));
  check('sanitize empty -> file', MediaUtils.sanitizeAssetName('') === 'file');

  const used = new Set();
  check('uniqueName first', MediaUtils.uniqueName('a.png', used) === 'a.png');
  check('uniqueName second -> a-2.png', MediaUtils.uniqueName('a.png', used) === 'a-2.png');
  check('uniqueName case-insensitive collision', MediaUtils.uniqueName('A.png', used) === 'A-3.png', [...used].join(','));

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  check('sniff png', MediaUtils.sniffImageExt(png) === 'png');
  check('sniff jpg', MediaUtils.sniffImageExt(jpg) === 'jpg');
  check('sniff webp', MediaUtils.sniffImageExt(webp) === 'webp');
  check('sniff garbage -> null', MediaUtils.sniffImageExt(new Uint8Array([1, 2, 3, 4])) === null);

  check('ensureExtension adds sniffed', MediaUtils.ensureExtension('photo', 'png') === 'photo.png');
  check('ensureExtension: sniffed bytes beat a wrong image ext', MediaUtils.ensureExtension('photo.jpg', 'png') === 'photo.png');
  check('ensureExtension keeps .pdf', MediaUtils.ensureExtension('doc.pdf', 'png') === 'doc.pdf');
  check('extFromMediaType image/jpeg -> jpg', MediaUtils.extFromMediaType('image/jpeg') === 'jpg');
  check('extFromMediaType text/plain -> null', MediaUtils.extFromMediaType('text/plain') === null);

  const res = MediaUtils.assignAssetNames([
    { id: 'm0', name: 'bug shot.png', bytes: png, ok: true },
    { id: 'm1', name: null, bytes: jpg, ok: true },
    { id: 'm2', name: 'bug shot.png', bytes: png, ok: true },  // dupe name
    { id: 'm3', name: 'x.png', ok: false, error: 'download failed' },
    { id: 'm4', name: null, mediaType: 'image/webp', ok: true } // ext via media type
  ]);
  check('named path for m0', res.idToPath.m0 === 'assets/bug-shot.png', res.idToPath.m0);
  check('nameless asset gets sniffed ext', /^assets\/image-\d+\.jpg$/.test(res.idToPath.m1), res.idToPath.m1);
  check('duplicate deduped', res.idToPath.m2 === 'assets/bug-shot-2.png', res.idToPath.m2);
  check('failed asset gets no path', !('m3' in res.idToPath));
  check('failed asset passes through', res.named.some(a => a && a.id === 'm3' && !a.ok));
  check('mediaType fallback ext', /\.webp$/.test(res.idToPath.m4), res.idToPath.m4);
}

// ---- 5. Zip writer round-trip (independent reader below) ----------------
console.log('\n[zipwriter]');

// Tiny independent ZIP reader for verification -- parses via the central
// directory, deliberately not sharing any code with the writer.
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let e = 0; e < count; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central header');
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nlen = dv.getUint16(off + 28, true);
    const xlen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = Buffer.from(buf.slice(off + 46, off + 46 + nlen)).toString('utf8');
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('bad local header');
    const lnlen = dv.getUint16(lho + 26, true);
    const lxlen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnlen + lxlen;
    const data = buf.slice(dataStart, dataStart + csize);
    entries.push({ name, method, crc, csize, usize, data });
    off += 46 + nlen + xlen + clen;
  }
  return entries;
}

{
  const md = '# Export\n\n![shot](assets/shot.png)\n';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
  const zip = ZipWriter.createZip([
    { name: 'conversation.md', data: md },
    { name: 'assets/shot.png', data: png },
    { name: 'assets/note-utf8-name-é✓.txt', data: 'utf8 name test' }
  ]);

  check('archive is Uint8Array', zip instanceof Uint8Array);
  check('starts with PK\\x03\\x04', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4);

  const entries = readZip(Buffer.from(zip));
  check('3 entries in central directory', entries.length === 3, entries.length);
  check('entry names preserved', entries[0].name === 'conversation.md' && entries[1].name === 'assets/shot.png');
  check('utf8 name round-trips', entries[2].name === 'assets/note-utf8-name-é✓.txt', entries[2].name);
  check('method is STORE', entries.every(e => e.method === 0));
  check('md content round-trips', Buffer.from(entries[0].data).toString('utf8') === md);
  check('binary content round-trips byte-exact', Buffer.compare(Buffer.from(entries[1].data), Buffer.from(png)) === 0);
  check('crc matches independent computation', entries[1].crc === ZipWriter.crc32(png));
  check('sizes are raw sizes', entries[1].csize === png.length && entries[1].usize === png.length);

  let threw = false;
  try { ZipWriter.createZip([]); } catch (e) { threw = true; }
  check('empty entry list throws', threw);
  threw = false;
  try { ZipWriter.createZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]); } catch (e) { threw = true; }
  check('duplicate names throw', threw);

  // Write the archive so an external tool (PowerShell Expand-Archive /
  // Python zipfile) can independently validate it. Not committed (gitignored).
  const outPath = path.join(__dirname, 'out-sample.zip');
  fs.writeFileSync(outPath, Buffer.from(zip));
  console.log('  info external verification sample written: ' + outPath);
}

// ---- v1.5.1 fixes: position-aware naming + descriptive alt ---------------
{
  const png = new Uint8Array([0x89,0x50,0x4e,0x47]);
  const assets = [
    { id: 'a', ok: true, bytes: png },
    { id: 'b', ok: true, bytes: png },
    { id: 'c', ok: true, bytes: png },
  ];
  const asg = MediaUtils.assignAssetNames(assets, { idToMsg: { a: 12, b: 12, c: 3 } });
  check('msg12 first image name', asg.idToPath.a === 'assets/msg012-img1.png', asg.idToPath.a);
  check('msg12 second image name', asg.idToPath.b === 'assets/msg012-img2.png', asg.idToPath.b);
  check('msg3 first image zero-padded', asg.idToPath.c === 'assets/msg003-img1.png', asg.idToPath.c);

  const asg2 = MediaUtils.assignAssetNames([{ id: 'x', ok: true, bytes: png }], {});
  check('no-position fallback zero-padded', asg2.idToPath.x === 'assets/image-001.png', asg2.idToPath.x);

  const rw = MediaUtils.rewriteAssetLinks('x ![attachment](asset:a) y', asg.idToPath);
  check('generic alt becomes filename', rw === 'x ![msg012-img1.png](assets/msg012-img1.png) y', rw);

  const rw2 = MediaUtils.rewriteAssetLinks('x ![my diagram](asset:a) y', asg.idToPath);
  check('meaningful alt preserved', rw2 === 'x ![my diagram](assets/msg012-img1.png) y', rw2);

  const jpg = new Uint8Array([0xff,0xd8,0xff]);
  const asg3 = MediaUtils.assignAssetNames([{ id: 'n', ok: true, name: 'photo.jpg', bytes: jpg }], { idToMsg: { n: 5 } });
  check('real upload name beats position', asg3.idToPath.n === 'assets/photo.jpg', asg3.idToPath.n);
}

// ---- 6. HTML export helpers (v1.5 self-contained .html deliverable) -----
console.log('\n[html export]');
{
  const esc = MediaUtils.escapeHtml;
  check('escapeHtml covers & < > " \'',
    esc('<a href="x" onclick=\'y\'>&</a>') === '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    esc('<a href="x" onclick=\'y\'>&</a>'));
  check('escapeHtml null -> empty string', esc(null) === '');
  check('escapeHtml number coerced', esc(42) === '42');

  const conv = MediaUtils.convertPlaceholdersToHtml;

  // XSS: script injection in message text must stay inert.
  const evil = 'hi <script>alert(1)</script> ![shot](asset:a) tail <img src=x onerror=alert(2)>';
  const out = conv(evil, { a: 'data:image/png;base64,AAAA' }, { a: 'msg001-img1.png' });
  check('script tag inert (escaped)', out.indexOf('<script') === -1 && out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out);
  check('user-written img tag inert', out.indexOf('<img src=x') === -1 && out.includes('&lt;img src=x'));
  check('placeholder -> img with data uri', out.includes('<img src="data:image/png;base64,AAAA"'), out);
  check('position-encoded name as alt+title',
    out.includes('alt="msg001-img1.png"') && out.includes('title="msg001-img1.png"'), out);
  check('surrounding text preserved in order',
    out.startsWith('hi ') && out.indexOf('&lt;script') < out.indexOf('<img src="data:') &&
    out.indexOf('<img src="data:') < out.indexOf(' tail '), out);

  // Failed download: image placeholder with no src -> italic note, same
  // wording convention as rewriteAssetLinks.
  const fail = conv('x ![shot](asset:z) y', {}, {});
  check('failed image -> visible italic note',
    fail === 'x <em>[shot -- not exported (download failed or unsupported)]</em> y', fail);

  // Non-image attachment in embed mode (no src): labeled "not embeddable".
  const att = conv('see [server.log](asset:t)', {}, { t: 'server.log' });
  check('non-image w/o src -> not-embeddable note',
    att === 'see <em>[server.log -- attachment, not embeddable in HTML export]</em>', att);

  // Non-image WITH src (zip-fallback mode): rendered as a relative link.
  const lnk = conv('see [server.log](asset:t)', { t: 'assets/server.log' }, { t: 'server.log' });
  check('non-image with path -> anchor',
    lnk === 'see <a href="assets/server.log">server.log</a>', lnk);

  // Relative-path src for images (zip-fallback mode) also works.
  const rel = conv('![shot](asset:a)', { a: 'assets/msg002-img1.png' }, { a: 'msg002-img1.png' });
  check('image with relative path src',
    rel === '<img src="assets/msg002-img1.png" alt="msg002-img1.png" title="msg002-img1.png">', rel);

  // No-media pass-through: text without placeholders is only escaped.
  check('no placeholders -> escaped pass-through', conv('a < b & c', {}, {}) === 'a &lt; b &amp; c');
  check('plain text identity', conv('hello world', {}, {}) === 'hello world');
  check('non-string -> empty string', conv(undefined, {}, {}) === '');

  // Attribute injection: a quote in the alt cannot break out of alt="...".
  const q = conv('!["quoted"](asset:a)', { a: 'data:image/png;base64,AA' }, {});
  check('quotes in alt escaped inside attribute',
    q === '<img src="data:image/png;base64,AA" alt="&quot;quoted&quot;" title="&quot;quoted&quot;">', q);

  // Alt fallback order: final name beats alt beats id.
  check('label falls back to alt when no name',
    conv('![diagram](asset:a)', { a: 'data:image/png;base64,AA' }, {}).includes('alt="diagram"'));
  check('label falls back to id when no name and no alt',
    conv('![](asset:a)', { a: 'data:image/png;base64,AA' }, {}).includes('alt="a"'));

  check('mimeFromExt png', MediaUtils.mimeFromExt('png') === 'image/png');
  check('mimeFromExt jpg -> image/jpeg', MediaUtils.mimeFromExt('jpg') === 'image/jpeg');
  check('mimeFromExt webp', MediaUtils.mimeFromExt('webp') === 'image/webp');
  check('mimeFromExt unknown -> octet-stream', MediaUtils.mimeFromExt('xyz') === 'application/octet-stream');
}

// ---- 7. ChatGPT ASSISTANT-GENERATED image detection (2026-07-08 fix) -----
// The bug: only USER-uploaded images came out; DALL-E generated images (on a
// separate role:'tool' message) were dropped because the walker filtered to
// user/assistant. These tests exercise the REAL walkChatGPTTree over a fixture
// with images on BOTH sides (Zaina's live test case).
console.log('\n[chatgpt assistant-generated images]');
{
  const fx = loadFixture('chatgpt-generated-image.json');

  // Regression guard: with no mediaOut, walker is text-only and drops all
  // objects (byte-identical to v1.4.3 behavior).
  const textOnly = walkChatGPTTree(fx.mapping, undefined);
  check('text-only walk drops all image objects',
    textOnly.every(m => m.text.indexOf('](asset:') === -1), JSON.stringify(textOnly));
  check('text-only walk still emits user + assistant text',
    textOnly.some(m => m.role === 'user' && m.text.includes('reference photo')) &&
    textOnly.some(m => m.role === 'assistant' && m.text.includes('Here is the image')),
    JSON.stringify(textOnly));
  check('text-only walk emits NO tool chatter',
    textOnly.every(m => m.text.indexOf('MUST_NOT_APPEAR') === -1), JSON.stringify(textOnly));

  // Media walk: both the user upload AND the generated image are collected.
  const media = [];
  const msgs = walkChatGPTTree(fx.mapping, media);

  check('two images collected (user upload + generated)', media.length === 2, media.length);

  const userRef = media.find(r => r.fileId === 'file-UserUpload01');
  const genRef = media.find(r => r.fileId === 'file_GeneratedByDalle99');
  check('user-uploaded image ref present', !!userRef, JSON.stringify(media));
  check('assistant-GENERATED image ref present', !!genRef, JSON.stringify(media));
  check('generated ref flagged generated:true', !!genRef && genRef.generated === true, genRef && genRef.generated);
  check('user upload NOT flagged generated', !!userRef && !userRef.generated, userRef && userRef.generated);
  check('generated ref recovered filename from metadata', !!genRef && genRef.name === 'generated.png', genRef && genRef.name);
  check('generated ref kind is chatgpt-file', !!genRef && genRef.kind === 'chatgpt-file');
  check('generated ref flagged isImage', !!genRef && genRef.isImage === true);

  // The generated image's placeholder is emitted on an ASSISTANT-role turn,
  // and the tool's text chatter is NOT in the transcript.
  const genPlaceholder = '](asset:' + genRef.id + ')';
  const turnWithGen = msgs.find(m => m.text.indexOf(genPlaceholder) !== -1);
  check('generated image emitted on an assistant turn', !!turnWithGen && turnWithGen.role === 'assistant',
    turnWithGen && turnWithGen.role);
  // The TOOL message's parts (prompt echo alongside the image) must never
  // enter the transcript — only its image placeholder does. (The separate
  // role:'assistant' dalle tool-call message is pre-existing walker behavior
  // and is out of scope for this image fix.)
  check('tool-message text chatter never enters transcript',
    msgs.every(m => m.text.indexOf('MUST_NOT_APPEAR') === -1),
    JSON.stringify(msgs.map(m => m.text)));

  // Position-encoded naming: the popup derives idToMsg by scanning message
  // texts for ](asset:ID) in order — replicate that here and confirm the
  // generated image gets an msgNNN-imgN name at its ASSISTANT position.
  const idToMsg = {};
  msgs.forEach((m, i) => {
    const re = /\]\(asset:([A-Za-z0-9_-]+)\)/g;
    let mm;
    while ((mm = re.exec(m.text)) !== null) {
      if (idToMsg[mm[1]] == null) idToMsg[mm[1]] = i + 1;
    }
  });
  check('generated image has a message position', idToMsg[genRef.id] != null, JSON.stringify(idToMsg));

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  // Simulate the download result WITHOUT a platform name (nameless) so the
  // position-encoded fallback is exercised.
  const assigned = MediaUtils.assignAssetNames([
    { id: genRef.id, ok: true, bytes: png }
  ], { idToMsg: idToMsg });
  const genMsgNo = idToMsg[genRef.id];
  const expectName = 'assets/msg' + String(genMsgNo).padStart(3, '0') + '-img1.png';
  check('generated image gets position-encoded name (msgNNN-imgN)',
    assigned.idToPath[genRef.id] === expectName, assigned.idToPath[genRef.id]);
}

// ---- 8. Grok assistant-generated image detection (INFERRED, defensive) ---
console.log('\n[grok generated-image detection]');
{
  const fx = loadFixture('grok-responses.json');
  const skips = [];
  const onSkip = (why) => skips.push(why);
  const perResponse = fx.responses.map(r => MediaUtils.collectGrokResponseMedia(r, onSkip));

  check('r0 (user text): no media', perResponse[0].length === 0, perResponse[0].length);
  check('r1: generatedImageUrls -> 1 ref', perResponse[1].length === 1, perResponse[1].length);
  check('r1: ref is grok-url', perResponse[1][0] && perResponse[1][0].kind === 'grok-url');
  check('r1: ref flagged generated + image', perResponse[1][0] &&
    perResponse[1][0].generated === true && perResponse[1][0].isImage === true);
  check('r1: url carried', perResponse[1][0] &&
    perResponse[1][0].url === 'https://assets.grok.com/generated/fox-abc123.png', perResponse[1][0] && perResponse[1][0].url);

  check('r2: attachments url + imageUrl -> 2 refs', perResponse[2].length === 2, perResponse[2].length);
  check('r2: filename recovered where present', perResponse[2].some(r => r.name === 'fox-v2.png'));

  check('r3 (plain text): no media', perResponse[3].length === 0, perResponse[3].length);

  check('r4: single image object -> 1 ref', perResponse[4].length === 1, perResponse[4].length);
  check('r4: nested object url carried', perResponse[4][0] &&
    perResponse[4][0].url === 'https://assets.grok.com/generated/fox-single.png');

  check('r5: media-ish w/o url skipped (not thrown)', perResponse[5].length === 0, perResponse[5].length);
  check('r5: skip was reported', skips.length >= 1, skips.length);

  check('non-object input -> [] (never throws)',
    Array.isArray(MediaUtils.collectGrokResponseMedia(null)) &&
    MediaUtils.collectGrokResponseMedia(null).length === 0);
  check('string message-only response -> [] ',
    MediaUtils.collectGrokResponseMedia({ message: 'hi', sender: 'assistant' }).length === 0);
}

// ---- structural: media transfer stays chunked --------------------------
// The chrome.* message layer can't run under Node, but the 2026-08-06 field
// failure (100-image export -> one ~270 MB FETCH_MEDIA response -> Chrome's
// ~64 MB message cap kills it -> EVERY image becomes a failure note) must
// never quietly come back. Tripwire on the source itself.
console.log('\n[structural: chunked media transfer]');
{
  const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  check('popup sends FETCH_MEDIA_ONE (per-asset)', popupSrc.includes("type: 'FETCH_MEDIA_ONE'"));
  check('popup no longer sends bulk FETCH_MEDIA', !popupSrc.includes("type: 'FETCH_MEDIA',"));
  check('popup shows per-asset progress', /Downloading attachment \$\{i \+ 1\}/.test(popupSrc));
  check('background handles FETCH_MEDIA_ONE', bgSrc.includes("message.type === 'FETCH_MEDIA_ONE'"));
  check('background per-one returns single asset key', bgSrc.includes('asset: assets[0]'));
}

// ---- extension follows the BYTES, not the uploaded name ----------------
// Measured live on claude.ai 2026-08-22: /files/{uuid}/preview re-encodes
// every image to WebP and keeps the original filename, so "Evermore.png"
// arrives as image/webp (1344x896). A .png holding WebP bytes opens in some
// viewers and silently fails in others -- the signature wins, the base name
// (what a human recognises months later) is kept.
console.log('\n[naming: bytes beat the filename]');
{
  const e = MediaUtils.ensureExtension;
  check('webp bytes under a .png name -> .webp', e('Evermore.png', 'webp') === 'Evermore.webp', e('Evermore.png', 'webp'));
  check('webp bytes under a .JPG name -> .webp', e('20260405_144628107.JPG', 'webp') === '20260405_144628107.webp', e('20260405_144628107.JPG', 'webp'));
  check('base name is preserved exactly', e('my holiday.photo.png', 'webp') === 'my holiday.photo.webp', e('my holiday.photo.png', 'webp'));
  check('matching extension is left alone', e('shot.png', 'png') === 'shot.png', e('shot.png', 'png'));
  check('.jpeg vs jpg counts as matching', e('scan.jpeg', 'jpg') === 'scan.jpeg', e('scan.jpeg', 'jpg'));
  check('no extension -> sniffed one added', e('screenshot', 'png') === 'screenshot.png', e('screenshot', 'png'));
  check('.bin -> sniffed one', e('blob.bin', 'jpg') === 'blob.jpg', e('blob.bin', 'jpg'));
  check('non-image extension untouched', e('report.pdf', 'png') === 'report.pdf', e('report.pdf', 'png'));
  check('no sniff -> name unchanged', e('mystery.dat', null) === 'mystery.dat', e('mystery.dat', null));
}

// ---- transient failures are retried, real answers are not --------------
// Measured live on claude.ai 2026-08-22: the SAME preview URL answered 503
// once and 200 on three immediate retries. Without a retry, one hiccup turns
// one image into a permanent "-- not exported" note; on a 95-image
// conversation that hiccup is nearly certain.
console.log('\n[media fetch: retry on transient failures]');
{
  const realFetch = global.fetch;
  function stub(seq) {
    let i = 0;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      const step = seq[Math.min(i++, seq.length - 1)];
      if (step instanceof Error) throw step;
      return { ok: step < 400, status: step, headers: { get: () => 'image/webp' } };
    };
    return calls;
  }
  RETRY_SUITE = (async () => {
    let calls = stub([503, 200]);
    let r = await fetchRetrying('u1', {});
    check('503 then 200 -> resolves ok', r.ok === true && r.status === 200, String(r.status));
    check('503 then 200 -> exactly two attempts', calls.length === 2, String(calls.length));

    calls = stub([404]);
    r = await fetchRetrying('u2', {});
    check('404 is an answer, not a stumble (no retry)', calls.length === 1 && r.status === 404, calls.length + '/' + r.status);

    calls = stub([403]);
    r = await fetchRetrying('u3', {});
    check('403 is not retried', calls.length === 1, String(calls.length));

    calls = stub([429, 429, 200]);
    r = await fetchRetrying('u4', {});
    check('429 is retried', r.status === 200 && calls.length === 3, calls.length + '/' + r.status);

    calls = stub([500]);
    r = await fetchRetrying('u5', {});
    check('gives up after 3 attempts, returns the last response', calls.length === 3 && r.status === 500, String(calls.length));

    calls = stub([new Error('network down'), 200]);
    r = await fetchRetrying('u6', {});
    check('network error is retried', r.status === 200 && calls.length === 2, String(calls.length));

    calls = stub([new Error('network down')]);
    let threw = false;
    try { await fetchRetrying('u7', {}); } catch (e) { threw = true; }
    check('persistent network error still throws', threw && calls.length === 3, String(calls.length));

    global.fetch = realFetch;
  })();
}

// ---- structural: every asset fetch goes through the retry --------------
console.log('\n[structural: retry wired into every asset path]');
{
  const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  check('fetchRetrying exists', /async function fetchRetrying\(/.test(bgSrc));
  check('claude asset fetch retries', /fetchClaudeAsset[\s\S]{0,400}fetchRetrying\(url/.test(bgSrc));
  check('grok asset fetch retries', /fetchGrokAsset[\s\S]{0,400}fetchRetrying\(url/.test(bgSrc));
  check('chatgpt SW fallback retries', bgSrc.includes('fetchRetrying(payload.downloadUrl)'));
}

// ---- uploads the platform does not serve: honest, not accused ----------
// Measured live 2026-08-22: an uploaded document arrives from claude.ai as
// file_kind:'blob' with no url fields and a container path, and EVERY file
// endpoint 404s for it. Guessing a preview URL turned that into a fake
// 'download failed', which reads like our bug in someone's permanent archive.
console.log('\n[claude: unreachable uploads are reported, not blamed]');
{
  const org = 'org-1234';
  const blobMsg = { files: [{ file_kind: 'blob', file_uuid: 'u-1', file_name: 'notes.md', size_bytes: 42 }] };
  const imgMsg  = { files: [{ file_kind: 'image', file_uuid: 'u-2', file_name: 'shot.png' }] };
  const skips = [];
  const blobRefs = MediaUtils.collectClaudeMessageMedia(blobMsg, org, r => skips.push(r));
  const imgRefs  = MediaUtils.collectClaudeMessageMedia(imgMsg, org, r => skips.push(r));

  check('blob upload -> one ref', blobRefs.length === 1, String(blobRefs.length));
  check('blob upload -> kind unavailable', blobRefs[0] && blobRefs[0].kind === 'unavailable', blobRefs[0] && blobRefs[0].kind);
  check('blob upload -> no invented url', blobRefs[0] && !blobRefs[0].url);
  check('blob upload -> carries a reason', !!(blobRefs[0] && blobRefs[0].reason));
  check('blob upload -> keeps its name', blobRefs[0] && blobRefs[0].name === 'notes.md');
  check('image STILL gets the constructed preview url',
    imgRefs.length === 1 && imgRefs[0].kind === 'claude-url' &&
    imgRefs[0].url === '/api/organizations/org-1234/files/u-2/preview', imgRefs[0] && imgRefs[0].url);

  const txt = 'before ' + MediaUtils.makePlaceholder('m1', 'notes.md', false) + ' after';
  const withNote = MediaUtils.rewriteAssetLinks(txt, {}, { m1: 'uploaded file - not served by the platform' });
  check('note explains WHY when we know', withNote.indexOf('not served by the platform') !== -1, withNote);
  check('note drops the generic accusation', withNote.indexOf('download failed') === -1, withNote);
  const noNote = MediaUtils.rewriteAssetLinks(txt, {}, {});
  check('unknown cause keeps the old wording', noNote.indexOf('download failed or unsupported') !== -1, noNote);
}

// ---- structural: one download path, one fewer permission ---------------
console.log('\n[structural: downloads]');
{
  const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const calls = (popupSrc.match(/chrome\.downloads\.download\(/g) || []).length;
  check('no chrome.downloads call sites left', calls === 0, String(calls));
  check('downloads permission dropped', mf.permissions.indexOf('downloads') === -1, mf.permissions.join(','));
  check('every export goes through the anchor', /function downloadBlobFile\(blob, filename\) \{\s+downloadBlobViaAnchor/.test(popupSrc));
  // Not pinned to a number: a test that fails on every bump teaches you to ignore tests.
  check('manifest version is a released shape (x.y.z, >= 1.5)', /^1\.(?:[5-9]|\d{2,})\.\d+$/.test(mf.version), mf.version);
  check('no draft marker left in the manifest', !mf.version_name, String(mf.version_name));
}
// ---- reopening the popup must not cost her work ------------------------
// Chrome destroys a browser-action popup on blur (dismissing the download
// bubble is enough) and no API prevents it. So reopening has to be cheap:
// the typed filename and the last status are remembered per conversation.
console.log('\n[structural: popup memory across reopen]');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  check('memory is keyed per conversation', /function memoryKey\(detected\)[\s\S]{0,140}detected\.conversationId/.test(src));
  check('typed filename is stored', /function rememberFilename/.test(src));
  check('last status is stored', /function rememberStatus/.test(src));
  check('the field listens for her typing', /getElementById\('exportFilename'\)\.addEventListener\('input'/.test(src));
  check('her name wins over the generated one', /rec\.filename \|\| auto/.test(src));
  check('a finished export leaves the note', /type === 'success' && CURRENT/.test(src));
  check('uses storage.local, not sync (per-machine, no quota games)', src.indexOf('chrome.storage.local') !== -1);
}
// ---- the filename survives the machine's registry ----------------------
// Chrome substitutes a download's extension from the MIME->extension registry.
// On the box this was found on: application/json -> .customization (HKCU) and
// text/html -> .htm (HKLM). octet-stream has no mapping, so the typed name
// reaches disk unchanged.
console.log('\n[structural: download mime]');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  check('downloads go out as octet-stream', /DOWNLOAD_MIME = 'application\/octet-stream'/.test(src));
  check('the anchor re-wraps the blob with it', /createObjectURL\(new Blob\(\[blob\], \{ type: DOWNLOAD_MIME \}\)\)/.test(src));
}
// ---- grok image cards: measured, not inferred --------------------------
// Shape taken from a live conversation on 2026-08-22 (30 cards): the tag
// sits in the message text, the data in response.cardAttachmentsJson.
console.log('\n[grok: <grok:render> image cards]');
{
  const card = {
    id: 'ba4fc4', type: 'render_searched_image', cardType: 'image_card', size: 'LARGE',
    image: { image_id: 'nGhqr', title: 'Off-shoulder knit', source: 'katedaviesdesigns.com',
             link: 'https://katedaviesdesigns.com/post',
             original: 'https://katedaviesdesigns.com/img.jpg',
             thumbnail: 'https://encrypted-tbn0.gstatic.com/x' } };
  const resp = { cardAttachmentsJson: [JSON.stringify(card)] };
  const tag = '<grok:render card_id=\"e5\" card_type=\"image_card\" type=\"render_searched_image\">' +
    '<argument name=\"image_id\">nGhqr</argument><argument name=\"size\">\"LARGE\"</argument></grok:render>';
  const out = MediaUtils.rewriteGrokRenderTags('head\n' + tag, resp);
  check('raw markup never survives', out.indexOf('<grok:render') === -1, out);
  check('title kept', out.indexOf('Off-shoulder knit') !== -1, out);
  check('source site named', out.indexOf('katedaviesdesigns.com') !== -1, out);
  check('links to the image', out.indexOf('(https://katedaviesdesigns.com/img.jpg)') !== -1, out);
  check('links to the page it came from', out.indexOf('source page') !== -1, out);

  const objCards = { cardAttachmentsJson: [card] };   // already parsed, not a string
  check('accepts pre-parsed cards too',
    MediaUtils.rewriteGrokRenderTags(tag, objCards).indexOf('Off-shoulder knit') !== -1);

  const missing = MediaUtils.rewriteGrokRenderTags(tag, { cardAttachmentsJson: [] });
  check('unknown card degrades to a note, not markup',
    missing.indexOf('<grok:render') === -1 && missing.indexOf('nGhqr') !== -1, missing);
  check('text without tags is untouched',
    MediaUtils.rewriteGrokRenderTags('plain', resp) === 'plain');
  check('garbage response never throws',
    MediaUtils.rewriteGrokRenderTags(tag, null).indexOf('<grok:render') === -1);
}
// ---- grok generated images: downloaded, with their prompt --------------
// Measured 2026-08-22 on a live "generate me some images" conversation: the
// tag is EMPTY (card_id only), the card carries the prompt and a RELATIVE
// imageUrl under https://assets.grok.com/. Unlike searched images these are
// the user's own, on Grok's own host, so they become real files.
console.log('\n[grok: generated_image_card]');
{
  const gen = {
    id: 'Eg9h2', type: 'render_generated_image', cardType: 'generated_image_card',
    prompt: 'A lone red fox standing on a mossy rock',
    image_chunk: { imageUrl: 'users/u1/generated/g1/image.jpg', imageTitle: 'Generated Image',
                   mimeType: 'image/jpeg', imageIndex: 0 }
  };
  const resp = { cardAttachmentsJson: [JSON.stringify(gen)] };
  const refs = MediaUtils.collectGrokCardMedia(resp);

  check('generated card yields one media ref', refs.length === 1, refs.length);
  check('relative imageUrl resolved against the asset host',
    refs[0] && refs[0].url === 'https://assets.grok.com/users/u1/generated/g1/image.jpg', refs[0] && refs[0].url);
  check('the prompt becomes the alt text',
    refs[0] && refs[0].alt.indexOf('red fox') !== -1, refs[0] && refs[0].alt);
  check('mime decides the extension', refs[0] && /\.jpg$/.test(refs[0].name), refs[0] && refs[0].name);
  check('the card id is carried for placement', refs[0] && refs[0].cardId === 'Eg9h2');

  const tag = '<grok:render card_id="Eg9h2" card_type="generated_image_card" type="render_generated_image"></grok:render>';
  const placed = MediaUtils.rewriteGrokRenderTags('x ' + tag, resp, { Eg9h2: '![fox](asset:m0)' });
  check('an empty tag is matched by card_id alone', placed.indexOf('![fox](asset:m0)') !== -1, placed);
  check('no raw markup survives', placed.indexOf('<grok:render') === -1, placed);

  const undownloaded = MediaUtils.rewriteGrokRenderTags('x ' + tag, resp);
  check('a card we did not download keeps prompt AND address',
    undownloaded.indexOf('red fox') !== -1 && undownloaded.indexOf('assets.grok.com') !== -1, undownloaded);
  check('and never claims the data was missing',
    undownloaded.indexOf('no card data') === -1, undownloaded);

  const searchedOnly = { cardAttachmentsJson: [JSON.stringify({
    id: 's1', cardType: 'image_card', image: { image_id: 'i1', title: 'T', link: 'https://e.com/p', original: 'https://e.com/i.jpg' } })] };
  check('searched cards are NOT collected as downloads',
    MediaUtils.collectGrokCardMedia(searchedOnly).length === 0);
  check('garbage never throws', MediaUtils.collectGrokCardMedia(null).length === 0 &&
    MediaUtils.collectGrokCardMedia({ cardAttachmentsJson: ['{bad', 7, null] }).length === 0);
}

// ---- structural: the asset host is actually permitted -------------------
console.log('\n[structural: grok asset host]');
{
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  check('assets.grok.com is in host_permissions',
    mf.host_permissions.indexOf('https://assets.grok.com/*') !== -1, mf.host_permissions.join(' '));
  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  check('fetchGrok collects card media before rewriting',
    src.indexOf('collectGrokCardMedia') < src.indexOf('rewriteGrokRenderTags(text, r, cardPlaceholders)'));
}

// ---- grok: files SHE uploaded ------------------------------------------
// The export came back without them and she said so. Measured on the live
// chat: three parallel arrays, and `key` (.../content) serves the original -
// 324,893 bytes for the file whose metadata said sizeBytes 324893, while
// previewImageKey (.../preview-image) gave 7,196.
console.log('\n[grok: user uploads]');
{
  const resp = {
    fileAttachments: ['u1', 'u2'],
    fileAttachmentsMetadata: [
      { fileName: 'Kin.jpg', fileMimeType: 'image/jpeg', fileUri: 'u1' },
      { fileName: 'notes.txt', fileMimeType: 'text/plain', fileUri: 'u2' }
    ],
    fileAttachmentAssetMetadata: [
      { assetId: 'a1', key: 'users/uid/a1/content', previewImageKey: 'users/uid/a1/preview-image', sizeBytes: 324893 },
      { assetId: 'a2', previewImageKey: 'users/uid/a2/preview-image' }
    ]
  };
  const refs = MediaUtils.collectGrokUploadMedia(resp);
  check('every upload becomes a ref', refs.length === 2, refs.length);
  check('the ORIGINAL is preferred over the preview',
    refs[0].url === 'https://assets.grok.com/users/uid/a1/content', refs[0].url);
  check('preview is used only when there is no original',
    refs[1].url === 'https://assets.grok.com/users/uid/a2/preview-image', refs[1].url);
  check('her filename is kept', refs[0].name === 'Kin.jpg', refs[0].name);
  check('images flagged as images', refs[0].isImage === true);
  check('a text upload is not an image', refs[1].isImage === false);
  check('marked as uploaded, not generated', refs[0].uploaded === true && !refs[0].generated);

  const skips = [];
  const noKey = MediaUtils.collectGrokUploadMedia({
    fileAttachmentsMetadata: [{ fileName: 'ghost.png' }],
    fileAttachmentAssetMetadata: [{ assetId: 'a3' }]
  }, r => skips.push(r));
  check('an upload with no storage key is reported, not invented',
    noKey.length === 0 && skips.length === 1, skips);

  check('garbage never throws',
    MediaUtils.collectGrokUploadMedia(null).length === 0 &&
    MediaUtils.collectGrokUploadMedia({ fileAttachmentsMetadata: 'x' }).length === 0);
}

// ---- structural: uploads reach the export ------------------------------
console.log('\n[structural: grok uploads wired]');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  check('fetchGrok collects uploads', src.indexOf('collectGrokUploadMedia(r, onSkip)') !== -1);
  check('uploads come before the inferred shapes',
    src.indexOf('collectGrokUploadMedia') < src.indexOf('collectGrokResponseMedia(r, onSkip)'));
}

// ---- word ruler: thread time measured in words --------------------------
// Starlight, 27.08.2026: "I don't measure time in hours, days or weeks, I
// measure time in words." These guard the marks he navigates a 384k-word
// export by, so a refactor cannot quietly move them.
console.log('\n[word ruler]');
{
  const WordRuler = require(path.join(__dirname, '..', 'word-ruler.js'));
  const msg = (n, role) => ({ role: role || 'user', text: 'w '.repeat(n).trim() });

  check('counts words, not characters', WordRuler.countWords('one two  three\n four') === 4);
  check('empty and null are zero',
    WordRuler.countWords('') === 0 && WordRuler.countWords(null) === 0 &&
    WordRuler.countWords('   ') === 0);
  check('cumulative runs forward',
    JSON.stringify(WordRuler.cumulative([msg(3), msg(2), msg(5)])) === '[3,5,10]');
  check('no messages, no marks',
    WordRuler.milestones([]).length === 0 && WordRuler.milestones(null).length === 0);
  check('no mark before the first 10k', WordRuler.milestones([msg(9999)]).length === 0);

  const exact = WordRuler.milestones([msg(10000)]);
  check('a mark lands exactly ON the boundary',
    exact.length === 1 && exact[0].words === 10000 && exact[0].afterIndex === 0,
    JSON.stringify(exact));

  // The ugly case that makes this honest: one huge message crosses several
  // marks at once. Every crossing is reported, pinned to that message, rather
  // than inventing a position inside it.
  const many = WordRuler.milestones([msg(1000), msg(35000)]);
  check('one long message reports every boundary it crosses',
    many.length === 3 && many.every(m => m.afterIndex === 1) &&
    many.map(m => m.words).join(',') === '10000,20000,30000', JSON.stringify(many));

  check('marks are in ascending order',
    WordRuler.milestones([msg(45000)]).map(m => m.words).join(',') === '10000,20000,30000,40000');
  check('step is configurable', WordRuler.milestones([msg(2500)], 1000).length === 2);
  check('a nonsense step falls back to the default',
    WordRuler.milestones([msg(10000)], 0).length === 1 &&
    WordRuler.milestones([msg(10000)], -5).length === 1);
  check('marksByIndex groups by message',
    JSON.stringify(WordRuler.marksByIndex([msg(1000), msg(35000)])) === '{"1":[10000,20000,30000]}');
  check('label reads as a milestone, thousands separated',
    WordRuler.label(120000) === '\u2014 120,000 words \u2014', WordRuler.label(120000));
}

// ---- structural: the ruler actually reaches the exports -----------------
console.log('\n[structural: word ruler wired]');
{
  const pop = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  check('popup.html loads word-ruler.js', html.indexOf('word-ruler.js') !== -1);
  check('markdown export emits marks', pop.indexOf('WordRuler.label(w)') !== -1);
  check('json export carries cumulative position', pop.indexOf('words_so_far') !== -1);
  check('json export lists the milestones', pop.indexOf('word_milestones') !== -1);
  check('html export emits marks', pop.indexOf('class=\"wordmark\"') !== -1);
  check('html mark has a style', pop.indexOf('.wordmark {') !== -1);
}
// ---- Google AI Studio: page text -> messages -----------------------------
// aistudioReadPage() runs inside the tab, against a real DOM, so it cannot run
// here (dry-run it in a live AI Studio tab); what it hands back is plain
// strings, so the half that interprets them is tested here against
// fixtures/aistudio-dom.json -- innerText CRAFTED from the DOM facts measured
// live on 2026-11-01, not a captured dump.
console.log('\n[ai studio: page text -> messages]');
{
  const fx = loadFixture('aistudio-dom.json');
  const before = JSON.stringify(fx);
  const turn = (name) => {
    const t = fx.turns.find(x => x.case === name);
    if (!t) throw new Error('fixture has no turn ' + name);
    return t;
  };
  const one = (name, opts) => aistudioTurnsToMessages([turn(name)], opts);
  const text = (name, opts) => (one(name, opts)[0] || {}).text;

  const all = aistudioTurnsToMessages(fx.turns);
  check('25 turns -> 21 messages (a lone collapsed thought, two unrendered shells and a non-turn are dropped)',
    all.length === 21, all.length);
  check('roles: User -> user, Model -> assistant',
    one('user-plain')[0].role === 'user' && one('model-continuation')[0].role === 'assistant');
  const iCode = all.findIndex(m => m.text.indexOf('//system//') === 0);
  check('consecutive turns of one role stay separate messages',
    iCode !== -1 && all[iCode].role === 'assistant' && all[iCode + 1].text === 'Anything else?' &&
    all[iCode + 1].role === 'assistant');
  check('chunks of one turn are folded into ONE message', one('model-thoughts-and-code').length === 1);

  // attachments
  check('file card -> [attachment: name] line, then the typed text',
    text('user-file-and-text') ===
      '[attachment: Generated Document November 01, 2026 - 2:19PM.pdf]\n\nSummarize this in three bullets.',
    JSON.stringify(text('user-file-and-text')));
  check('a turn that is only a file card still exports, brackets in the name made safe',
    text('user-only-attachment') === '[attachment: scan(final).png]', JSON.stringify(text('user-only-attachment')));

  // thoughts
  check('collapsed Thoughts panel: skipped, boilerplate never exported',
    text('model-collapsed-thoughts') === '- The report covers Q3 revenue.\n- Costs rose 4%.\n- Margin held at 31%.',
    JSON.stringify(text('model-collapsed-thoughts')));
  check('a turn that is nothing but a collapsed panel is dropped', one('model-only-collapsed-thought').length === 0);
  const full = text('model-thoughts-and-code');
  check('expanded thoughts: //system// ... Done, before the answer (Claude convention)',
    full.indexOf('//system//\n**Planning the script**\n') === 0 &&
    full.indexOf('The folder may not exist.\nDone\n\nHere is the script:') !== -1, JSON.stringify(full.slice(0, 160)));
  check('panel labels are not part of the thought body',
    full.indexOf('Collapse to hide model thoughts') === -1 && full.indexOf('Thoughts') === -1 &&
    full.indexOf('chevron_right') === -1);
  const noThoughts = text('model-thoughts-and-code', { includeThoughts: false });
  check('includeThoughts:false leaves the answer and no //system// block',
    noThoughts.indexOf('//system//') === -1 && noThoughts.indexOf('Here is the script:') === 0);

  // code
  check('code nested in a text chunk is fenced with its language, header chrome gone',
    full.indexOf('```python\nfrom pathlib import Path\n\nfor p in sorted(Path(\'docs\').iterdir()):\n    print(p.name)\n```') !== -1 &&
    full.indexOf('content_copy') === -1 && !/^Python$/m.test(full), JSON.stringify(full));
  check('a code chunk of its own is fenced, and its standalone docs line survives',
    full.indexOf('And ls prints:\n\n```\ndocs\nsrc\ntests\n```') !== -1);
  check('code holding backticks gets a longer fence',
    text('model-backticks-in-code') === '````python\nprint(\'```\')\n````', JSON.stringify(text('model-backticks-in-code')));
  check('a one-word code block is fenced where it stands alone, not inside the sentence',
    text('model-one-word-code-block') === 'Use ls to list files.\n```bash\nls\n```\nThat is all.',
    JSON.stringify(text('model-one-word-code-block')));
  check('a code block that cannot be placed leaves the text exactly as it was',
    text('model-unplaceable-nested-code') === 'Intro\nSome code\nOutro');

  // chrome vs content
  check('fallback turn: header line and trailing icon words removed',
    text('user-fallback-header') === 'A follow-up from a layout the reader did not recognize.',
    JSON.stringify(text('user-fallback-header')));
  check('fallback turn: icon words above the header, and the Thoughts label, removed',
    text('model-fallback-icons-above-header') === 'Plain answer.', JSON.stringify(text('model-fallback-icons-above-header')));
  check('header line leaked into the first chunk is removed',
    text('user-header-inside-first-chunk') === 'hello');
  check('icon words standing alone INSIDE a text chunk are content, not chrome',
    text('user-icon-words-are-content') === 'Which button is which?\nedit\ndocs\nmore_vert');
  check('the first line keeps its indentation; a whitespace-only chunk adds nothing',
    text('user-indented-first-line') === '    indented = True\nnot_indented = False');
  check('CRLF from the page is normalized', text('user-crlf') === 'line one\nline two');
  check('a turn with an unknown data-turn-role is not a message', one('unknown-role').length === 0);
  check('no panel label or time header survives anywhere in the export',
    all.every(m => !/chevron_right|(Expand to view|Collapse to hide) model thoughts/.test(m.text) &&
      !/^(User|Model)\s+\d{1,2}:\d{2}/m.test(m.text)));

  // a virtualized list: shells the sweep never saw filled add nothing, the rest keep their order
  check('unrendered shells (no chunks, empty fallback) add nothing',
    one('model-unread-shell').length === 0 && one('user-unread-shell').length === 0);
  const iCards = all.findIndex(m => m.text.indexOf('[attachment: Q3 report.pdf]') === 0);
  check('readable turns on either side of unread shells stay in order',
    iCards !== -1 && all[iCards + 1].text.indexOf('//system//\n**Weighing options**') === 0);
  check('a turn of four file cards keeps all four, in order',
    text('user-four-file-cards') ===
      '[attachment: Q3 report.pdf]\n\n[attachment: Q3 figures.xlsx]\n\n[attachment: notes.txt]\n\n' +
      '[attachment: Generated Document November 01, 2026 - 2:19PM.pdf]', JSON.stringify(text('user-four-file-cards')));

  // icon glyphs (content_copy, expand_less, expand_more) where they are page chrome
  check('glyph lines anywhere in a thought body are chrome',
    text('model-thought-glyph-lines') ===
      '//system//\n**Weighing options**\nOption A is cheaper.\nOption B is faster.\nDone\n\nGo with B.',
    JSON.stringify(text('model-thought-glyph-lines')));
  check('code-block header lines outside the block are cleared above the fence',
    text('model-code-header-outside-block') === 'Here is the script:\n\n```python\nprint(\'hi\')\n```\n\nThat is all.',
    JSON.stringify(text('model-code-header-outside-block')));
  check('three code blocks, each with a content_copy / expand_less header: all fenced, no header left',
    text('model-three-code-headers') ===
      'Step 1:\n```\nnpm install\n```\nStep 2:\n```\nnpm run build\n```\nStep 3:\n```\nnpm test\n```\nDone.',
    JSON.stringify(text('model-three-code-headers')));
  check('a collapsed block that shows only its header is removed',
    text('model-collapsed-code-header-only') === 'Before.\nAfter.', JSON.stringify(text('model-collapsed-code-header-only')));
  check('the same words standing alone in ordinary prose are content, not chrome',
    text('model-prose-glyph-lines') === 'Material icon names look like this:\ncontent_copy\nexpand_less\nand so on.');
  check('no glyph line survives where it was page chrome',
    ['model-thoughts-and-code', 'model-thought-glyph-lines', 'model-code-header-outside-block',
     'model-three-code-headers', 'model-collapsed-code-header-only']
      .every(n => !/^(content_copy|expand_less|expand_more|chevron_right)$/m.test(text(n))));

  // robustness
  check('the input is not mutated', JSON.stringify(fx) === before);
  let threw = null, junk = null;
  try {
    junk = aistudioTurnsToMessages([null, {}, { role: 'User' }, { role: 'Model', chunks: [null, {}, { kind: 'text' }, { kind: 'text', text: 7 }] }]);
    aistudioTurnsToMessages(null); aistudioTurnsToMessages(undefined); aistudioTurnsToMessages('x');
  } catch (e) { threw = e; }
  check('malformed turns are skipped, never thrown', threw === null && junk.length === 0, threw && threw.message);
}

console.log('\n[ai studio: title]');
{
  check('the site suffix is cut',
    aistudioCleanTitle('Q3 report review | Google AI Studio') === 'Q3 report review');
  check('only the final suffix is cut',
    aistudioCleanTitle('A | B | Google AI Studio') === 'A | B');
  check('a title without the suffix is left alone', aistudioCleanTitle('Plain name') === 'Plain name');
  check('a bare product title, or nothing, means untitled',
    aistudioCleanTitle('Google AI Studio') === 'Untitled AI Studio' &&
    aistudioCleanTitle('') === 'Untitled AI Studio' && aistudioCleanTitle(null) === 'Untitled AI Studio');
}

// aistudioReadPage is serialized with toString() and run in the page, so it
// must not lean on anything declared elsewhere in background.js. An identifier
// that is out of scope in the page only fails THERE, at export time -- so both
// halves of that are checked here: no outside names in the source, and a real
// run in a context that holds nothing but `document`. It is async (the list is
// virtualized and has to be scrolled), hence the promise chain.
RETRY_SUITE = RETRY_SUITE.then(async () => {
  console.log('\n[ai studio: page reader is self-contained, and sweeps]');
  const vm = require('vm');
  const src = aistudioReadPage.toString();
  const outside = ['INCLUDE_SYSTEM_TRACES', 'MediaUtils', 'chrome', 'AISTUDIO_', 'aistudioTurnsToMessages',
    'aistudioChunkText', 'aistudioLines', 'aistudioTidy', 'aistudioFence'];
  const leaks = outside.filter(n => src.indexOf(n) !== -1);
  check('names no other symbol of background.js', leaks.length === 0, leaks.join(','));
  check('is async: executeScript awaits the promise it returns', /^async function aistudioReadPage/.test(src));
  // the calls themselves, not a mention in a comment
  check('sweeps the virtualized list: the named scroller, settled by a MutationObserver',
    src.indexOf("querySelector('ms-autoscroll-container')") !== -1 && src.indexOf('new MutationObserver(') !== -1);
  check('puts the scroll position back whatever happens', /finally\s*\{\s*container\.scrollTop = startTop;/.test(src));
  let page = null, ranErr = null;
  try {
    page = await vm.runInNewContext('(' + src + ')()',
      { document: { title: 'Empty | Google AI Studio', querySelectorAll: () => [] } });
  } catch (e) { ranErr = e; }
  check('runs with only `document` in scope; empty page -> no turns, no sweep',
    !ranErr && page.turnCount === 0 && page.turns.length === 0 && page.title === 'Empty | Google AI Studio' &&
    page.sweep.ran === false, ranErr ? ranErr.message : JSON.stringify(page));
});

// ---- structural: AI Studio is wired end to end ------------------------------
console.log('\n[structural: ai studio wired]');
{
  const vm = require('vm');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const pop = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8').replace(/\r\n/g, '\n');

  check('manifest asks for aistudio.google.com',
    manifest.host_permissions.indexOf('https://aistudio.google.com/*') !== -1);
  check('manifest description names AI Studio and fits the store limit of 132 characters',
    /AI Studio/.test(manifest.description) && manifest.description.length <= 132, manifest.description.length);
  check('token capture knows aistudio (the "no token" guard would reject it)',
    bg.indexOf("plat === 'aistudio'") !== -1);
  check('fetchConversation routes aistudio to its adapter',
    /platform === 'aistudio'\)\s*\{\s*return fetchAIStudio\(conversationId, token, tabId\);/.test(bg));
  check('the adapter injects the page reader and respects the thoughts switch',
    bg.indexOf('func: aistudioReadPage') !== -1 && bg.indexOf('includeThoughts: INCLUDE_SYSTEM_TRACES') !== -1);
  check('popup names Google AI Studio in all three platform lists',
    (pop.match(/Google AI Studio/g) || []).length >= 3, (pop.match(/Google AI Studio/g) || []).length);

  // popup.js cannot be required (chrome.* at load); detectPlatform is pure, so
  // lift it out of the source and run it.
  const m = /function detectPlatform\(url\) \{\n[\s\S]*?\n\}\n/.exec(pop);
  check('detectPlatform can be lifted from popup.js', !!m);
  if (m) {
    const detectPlatform = vm.runInNewContext(m[0] + '\ndetectPlatform');
    const ai = detectPlatform('https://aistudio.google.com/prompts/14aF6keJPs1NIrRjh4MftkVSefpJHIC3b?model=gemini-3-pro-preview');
    check('AI Studio prompt url -> platform, filename name, Drive file id',
      !!ai && ai.platform === 'aistudio' && ai.name === 'AIStudio' &&
      ai.conversationId === '14aF6keJPs1NIrRjh4MftkVSefpJHIC3b', JSON.stringify(ai));
    const app = detectPlatform('https://aistudio.google.com/app/prompts/abc_DEF-123');
    check('/app/prompts/<id> is accepted too', !!app && app.platform === 'aistudio' && app.conversationId === 'abc_DEF-123');
    check('AI Studio pages that are not a prompt are not a conversation',
      detectPlatform('https://aistudio.google.com/') === null &&
      detectPlatform('https://aistudio.google.com/apikey') === null &&
      detectPlatform('https://aistudio.google.com/prompts') === null);
    const others = {
      'https://chatgpt.com/c/0123abcd-ef01-2345-6789-abcdef012345': 'chatgpt',
      'https://claude.ai/chat/0123abcd-ef01-2345-6789-abcdef012345': 'claude',
      'https://gemini.google.com/app/0123abcdef012345': 'gemini',
      'https://grok.com/c/0123abcd-ef01-2345-6789-abcdef012345': 'grok'
    };
    const wrong = Object.keys(others).filter(u => { const d = detectPlatform(u); return !d || d.platform !== others[u]; });
    check('the four existing platforms are still detected', wrong.length === 0, wrong.join(' '));
    check('an unrelated site is not a platform', detectPlatform('https://example.com/prompts/abc') === null);
  }
}

// ---- theme (1.7.1): the HTML export and the popup ------------------------------
// A store review asked for a dark background "like on Grok". One choice - auto |
// light | dark - drives the .html export and the popup itself. popup.js cannot
// be require()d (chrome.* and the DOM at its top level), so it runs here in a
// vm sandbox with just enough of both to get through that top level: every
// function below is the REAL one, not a copy of it.
function loadPopup(stored) {
  const vm = require('vm');
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, value: '', textContent: '', className: '', innerHTML: '', style: {}, listeners: {},
    firstElementChild: { style: {} },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    appendChild() {},
    fire(type) { (this.listeners[type] || []).forEach(fn => fn({ target: this })); }
  });
  const attrs = {};
  const writes = { local: [], sync: [], removed: [] };
  const win = {
    document: {
      getElementById: el,
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
        getAttribute: (k) => (k in attrs ? attrs[k] : null)
      },
      createTextNode: (t) => ({ text: t })
    },
    chrome: {
      storage: {
        sync: { get: (d, cb) => cb(d), set: (v) => { writes.sync.push(JSON.stringify(v)); } },
        local: {
          get: (d, cb) => cb(Object.assign({}, d, stored || {})),
          set: (v, cb) => { writes.local.push(JSON.stringify(v)); if (cb) cb(); },
          remove: (keys) => { writes.removed.push(JSON.stringify(keys)); }
        }
      },
      tabs: { query: async () => [] },
      runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({}) }
    },
    MediaUtils, WordRuler: require(path.join(__dirname, '..', 'word-ruler.js')), console
  };
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), win);
  return { win, els, attrs, writes, vm };
}

// WCAG 2.x relative luminance and contrast ratio, for #rrggbb
function lum(hex) {
  const c = hex.slice(1).match(/../g).map(h => parseInt(h, 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

console.log('\n[theme: html export]');
{
  const app = loadPopup();
  const msgs = [
    { role: 'user', text: 'Hello <b>there</b>' },
    { role: 'assistant', text: 'Hi.\n```js\nconst a = 1;\n```' }
  ];
  const gen = (theme) => app.win.generateHTML('Title', msgs, 'USER', 'ASSISTANT', undefined, theme);
  const light = gen('light'), auto = gen('auto'), dark = gen('dark');
  const rules = Array.from(app.vm.runInContext('EXPORT_DARK_CSS', app.win));
  const rule = (sel) => rules.find(r => r.indexOf(sel + ' {') === 0) || '';
  const prop = (sel, name) => { const m = new RegExp('(?:^|[\\s{;])' + name + ':\\s*(#[0-9a-f]{6})').exec(rule(sel)); return m && m[1]; };
  const pageBg = prop('body', 'background');

  // dark: forced
  check('dark: a near-black page with light text',
    !!pageBg && lum(pageBg) < 0.02 && contrast(prop('body', 'color'), pageBg) >= 7, pageBg);
  check('dark: every dark rule is in the file', rules.length >= 8 && rules.every(r => dark.indexOf(r) !== -1));
  check('dark: tells the browser the page is dark (scrollbars, form controls)', dark.indexOf('color-scheme: dark') !== -1);
  check('dark: forced - not conditional on the reader\'s system', dark.indexOf('prefers-color-scheme') === -1);
  check('dark: on screens only, so a printout or PDF keeps dark text on white paper',
    dark.indexOf('@media screen {') !== -1 && dark.indexOf('@media screen {') < dark.indexOf(rule('body')));
  const texts = [['body', 'color'], ['.meta', 'color'], ['.speaker.user', 'color'], ['.speaker.assistant', 'color'],
    ['.wordmark', 'color'], ['.msg em', 'color'], ['a', 'color']];
  const worst = Math.min.apply(null, texts.map(([s, p]) => contrast(prop(s, p), pageBg)));
  check('dark: every text colour clears 4.5:1 on the page', worst >= 4.5, worst.toFixed(2));

  // auto: the default
  check('auto: the dark palette sits under @media (prefers-color-scheme: dark)',
    auto.indexOf('@media (prefers-color-scheme: dark) {') !== -1 &&
    auto.indexOf('@media (prefers-color-scheme: dark) {') < auto.indexOf(rule('body')));
  check('auto: carries the whole dark palette', rules.every(r => auto.indexOf(r) !== -1));
  check('auto: the light page is still the base, the dark block comes after it and wins',
    auto.indexOf('background: #fdfdfa') !== -1 &&
    auto.indexOf('.msg em { color: #888; }') < auto.indexOf('@media (prefers-color-scheme: dark)'));

  // light: untouched
  check('light: no theme CSS at all (the page as it was before 1.7.1)',
    light.indexOf('prefers-color-scheme') === -1 && light.indexOf('color-scheme') === -1 &&
    light.indexOf('@media') === -1 && light.indexOf(pageBg) === -1);
  check('theme is purely additive: auto and dark minus their block are the light page',
    auto.replace(app.win.exportThemeCss('auto'), '') === light &&
    dark.replace(app.win.exportThemeCss('dark'), '') === light);
  check('only the <style> changes, never the conversation',
    light.slice(light.indexOf('<body>')) === dark.slice(dark.indexOf('<body>')) &&
    light.slice(light.indexOf('<body>')) === auto.slice(auto.indexOf('<body>')));

  // what gets chosen
  check('no theme given: auto', gen(undefined) === auto);
  const junk = ['sepia', '', null, 42, {}, ['dark'], 'DARK', '</style><script>alert(1)</script>'];
  check('anything that is not a theme is auto', junk.every(v => gen(v) === auto));
  check('a theme value can never reach the file as markup', gen(junk[7]).indexOf('<script>') === -1);
  app.win.applyTheme('dark');
  check('left out, the popup\'s own choice decides (dark)',
    app.win.generateHTML('Title', msgs, 'USER', 'ASSISTANT') === dark);
  app.win.applyTheme('light');
  check('left out, the popup\'s own choice decides (light)',
    app.win.generateHTML('Title', msgs, 'USER', 'ASSISTANT') === light);

  // the other formats
  const md = {}, js = {};
  for (const t of ['light', 'dark']) {
    app.win.applyTheme(t);
    md[t] = app.win.generateMD('Title', msgs, 'USER', 'ASSISTANT');
    const o = JSON.parse(app.win.generateJSON('Title', msgs, 'USER', 'ASSISTANT'));
    delete o.exported;                                       // a clock, not a theme
    js[t] = JSON.stringify(o);
  }
  check('markdown is the same whatever the theme', md.light === md.dark && md.dark.indexOf('color') === -1);
  check('json is the same whatever the theme', js.light === js.dark && js.dark.indexOf('theme') === -1);
}

console.log('\n[theme: popup]');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8').replace(/\r\n/g, '\n');
  const sel = /<select id="theme">([\s\S]*?)<\/select>/.exec(html);
  const options = sel ? (sel[1].match(/value="[^"]*"/g) || []).join(' ') : '';
  check('popup.html has a #theme select with exactly auto, light, dark',
    options === 'value="auto" value="light" value="dark"', options);
  check('the select has a label', /<label for="theme">/.test(html));

  // palette: light is the base, dark for a dark system (auto only) and when forced
  const decls = (block) => (block.match(/(--[a-z-]+|color-scheme):\s*[^;]+;/g) || []).map(d => d.replace(/\s+/g, ' '));
  const base = /\n {4}:root \{([\s\S]*?)\n {4}\}/.exec(html);
  const forced = /:root\[data-theme="dark"\] \{([\s\S]*?)\n {4}\}/.exec(html);
  const system = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{([\s\S]*?)\n {6}\}\s*\}/.exec(html);
  check('light is the base; a dark system darkens auto only; forced dark has its own rule',
    !!base && !!forced && !!system && decls(base[1]).indexOf('color-scheme: light;') !== -1 &&
    decls(forced[1]).indexOf('color-scheme: dark;') !== -1 && decls(system[1]).indexOf('color-scheme: dark;') !== -1);
  check('the two dark palettes are the same declarations',
    !!forced && !!system && decls(forced[1]).length > 15 && decls(forced[1]).join('|') === decls(system[1]).join('|'));
  const used = Array.from(new Set((html.match(/var\(--[a-z-]+\)/g) || []).map(v => v.slice(4, -1))));
  const defined = (b) => decls(b[1]).map(d => d.split(':')[0]);
  check('every colour the popup uses is defined for light and for dark',
    used.length > 15 && !!base && !!forced &&
    used.every(v => defined(base).indexOf(v) !== -1 && defined(forced).indexOf(v) !== -1),
    used.filter(v => defined(base).indexOf(v) === -1 || defined(forced).indexOf(v) === -1).join(','));

  // behaviour
  const start = (stored) => loadPopup(stored);
  let app = start({ theme: 'dark' });
  check('saved dark: applied on open, select shows it', app.attrs['data-theme'] === 'dark' && app.els.theme.value === 'dark');
  app = start({ theme: 'light' });
  check('saved light: applied on open, select shows it', app.attrs['data-theme'] === 'light' && app.els.theme.value === 'light');
  app = start();
  check('nothing saved: auto, which is no attribute at all (the CSS decides)',
    !('data-theme' in app.attrs) && app.els.theme.value === 'auto');
  app = start({ theme: 'sepia' });
  check('a corrupt saved value is auto', !('data-theme' in app.attrs) && app.els.theme.value === 'auto');
  app = start({ theme: 'dark' });
  check('opening writes nothing', app.writes.local.length === 0 && app.writes.sync.length === 0);

  app = start();
  app.els.theme.value = 'light'; app.els.theme.fire('change');
  check('choosing light applies it and saves it in storage.local',
    app.attrs['data-theme'] === 'light' && app.writes.local.join() === '{"theme":"light"}', app.writes.local.join());
  app.els.theme.value = 'dark'; app.els.theme.fire('change');
  check('choosing dark applies it and saves it', app.attrs['data-theme'] === 'dark' && app.writes.local.pop() === '{"theme":"dark"}');
  app.els.theme.value = 'auto'; app.els.theme.fire('change');
  check('choosing auto takes the attribute off and saves auto',
    !('data-theme' in app.attrs) && app.writes.local.pop() === '{"theme":"auto"}');
  check('the theme never goes to sync storage (that is for the speaker labels)', app.writes.sync.length === 0);
  app.win.applyTheme('dark');
  check('what the select shows is what exports use',
    app.win.generateHTML('T', [{ role: 'user', text: 'x' }], 'U', 'A').indexOf('@media screen {') !== -1);

  // storage.local also holds the per-conversation memory, which is pruned by key prefix.
  // The pruner reads `.at` off every record it considers; a bare string like 'dark' has no
  // such date on Chrome 88-91 (MV3's floor, no String.prototype.at) and would read as 1970.
  // Only the 'ui:' prefix keeps the theme out of its reach, so take the crutch away.
  app = start({ theme: 'dark', 'ui:chatgpt:old': { at: 1 }, 'ui:claude:new': { at: Date.now() } });
  app.vm.runInContext('delete String.prototype.at', app.win);
  app.win.pruneMemory();
  check('pruning the popup memory leaves the theme alone',
    app.writes.removed.join() === '["ui:chatgpt:old"]', app.writes.removed.join());
}

// ---- summary -----------------------------------------------------------
RETRY_SUITE.then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
});

