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

let passed = 0, failed = 0;
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
  check('ensureExtension keeps existing image ext', MediaUtils.ensureExtension('photo.jpg', 'png') === 'photo.jpg');
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

// ---- summary -----------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

