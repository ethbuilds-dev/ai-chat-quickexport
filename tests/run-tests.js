#!/usr/bin/env node
// tests/run-tests.js — offline quality gate for the v1.5 media-export logic.
// Run:  node tests/run-tests.js
// No dependencies. Tests only the pure root modules (background.js/popup.js
// need chrome.* and are covered by docs/v1.5-MANUAL-TEST-PLAN.md instead).

'use strict';

const path = require('path');
const fs = require('fs');

const MediaUtils = require(path.join(__dirname, '..', 'media-utils.js'));
const ZipWriter = require(path.join(__dirname, '..', 'zipwriter.js'));
// background.js exports the pure tree-walker under Node (importScripts is
// guarded; MediaUtils is require()'d there) so the REAL walker — not a copy —
// is exercised against fixtures.
const { walkChatGPTTree, fetchRetrying } = require(path.join(__dirname, '..', 'background.js'));

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
// ---- summary -----------------------------------------------------------
RETRY_SUITE.then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
});

