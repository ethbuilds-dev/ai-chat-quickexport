#!/usr/bin/env node
// tests/adversarial.js — the pass that tries to BREAK it, not to confirm it.
//
// Asked for by Zaina on 2026-08-22, minutes after the field proof came back
// green: "Faci o testare si contra, sa vedem daca il mai strica ceva?"
//
// Different posture from run-tests.js. That suite asks "does the happy path
// hold?". This one assumes the conversation is HOSTILE data — because it is:
// every message body, filename and MIME type in an export comes from somewhere
// outside this code, and an exporter's whole job is to write that somewhere
// onto a real disk and open it in a real browser.
//
// Run:  node tests/adversarial.js      (exit 0 = nothing broke)

'use strict';

const path = require('path');
const fs = require('fs');

const MediaUtils = require(path.join(__dirname, '..', 'media-utils.js'));
const ZipWriter = require(path.join(__dirname, '..', 'zipwriter.js'));

let checks = 0;
const failures = [];
function attack(name, survived, detail) {
  checks++;
  if (survived) { console.log('  held  ' + name); }
  else { console.error('BROKE  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); failures.push(name); }
}

const BACK = String.fromCharCode(92);   // a backslash, without fighting the shell
const NUL = String.fromCharCode(0);
const RTL = String.fromCharCode(0x202E);

// ---------------------------------------------------------------- A. paths --
// An asset name arrives from the platform. If it can escape assets/, an export
// writes wherever it likes the moment the zip is extracted.
console.log('\n[A. path traversal in asset names]');
{
  const attempts = ['../../evil.txt', '..' + BACK + '..' + BACK + 'evil.txt', '/etc/passwd',
                    'C:' + BACK + 'Windows' + BACK + 'evil.txt', 'a/../../b.png',
                    './../x.png', 'assets/../../out.png', '....//....//x.png'];
  for (const raw of attempts) {
    const s = MediaUtils.sanitizeAssetName(raw);
    attack('escapes nothing: ' + JSON.stringify(raw),
      !s.includes('/') && !s.includes(BACK) && !s.startsWith('.') && s.length > 0, s);
  }
}

// ------------------------------------------------------- B. hostile names --
console.log('\n[B. names that break filesystems or lie to the eye]');
{
  const cases = ['CON', 'PRN.png', 'NUL.txt', 'COM1.jpg', 'LPT9.png', 'name.', 'name ', '..', '...',
                 '', '   ', 'photo' + RTL + 'gnp.exe', 'a' + NUL + 'b.png', 'a\nb.png', 'x'.repeat(400)];
  for (const raw of cases) {
    const s = MediaUtils.sanitizeAssetName(raw);
    attack('writable and honest: ' + JSON.stringify(raw.slice(0, 24)),
      !!s && s !== '.' && s !== '..' && !s.includes(NUL) && !/[\n\r]/.test(s) &&
      !s.includes(RTL) && s.length <= 160, s);
  }
}

// ------------------------------------------------------------ C. HTML/XSS --
// The .html export is opened in a browser. Every byte of it came from a chat.
console.log('\n[C. injection into the HTML export]');
{
  const payloads = [
    'hi </textarea><script>alert(1)</script>',
    '<img src=x onerror=alert(2)>',
    '<style>*{display:none}</style>',
    '"><svg/onload=alert(3)>',
    "'; alert(4); //",
  ];
  for (const p of payloads) {
    const out = MediaUtils.convertPlaceholdersToHtml(p, {}, {});
    attack('escaped in body: ' + p.slice(0, 26),
      !/<(script|img|svg|style)/i.test(out), out.slice(0, 80));
  }
  const ph = 'x ' + MediaUtils.makePlaceholder('m1', '"><script>alert(5)</script>', true) + ' y';
  const out2 = MediaUtils.convertPlaceholdersToHtml(ph, { m1: 'data:image/png;base64,AAA' },
                                                    { m1: '"><b>owned</b>.png' });
  attack('alt and title cannot break out of the attribute',
    !/<(script|b)>/i.test(out2), out2.slice(0, 140));
  // NOTE (22.08): this attack was scored as a break on the first run, and the
  // first run was WRONG -- the assertion stripped &quot; before looking, which
  // manufactured the hole it then reported. The quotes ARE escaped, so the
  // payload stays inside the src value and no attribute is added. Corrected to
  // check what actually matters: a raw quote escaping the attribute.
  const out3 = MediaUtils.convertPlaceholdersToHtml('a ' + MediaUtils.makePlaceholder('m2', 'x', true) + ' b',
    { m2: 'x" onerror="alert(6)' }, {});
  const srcValue = (out3.match(/src="([^"]*)"/) || [])[1] || '';
  attack('a hostile src stays inside its own attribute',
    srcValue.indexOf('&quot;') !== -1 && !/ onerror=/.test(out3.replace(/src="[^"]*"/, '')),
    out3.slice(0, 140));
}

// ------------------------------------------------- D. degenerate everything --
console.log('\n[D. garbage in, no throw out]');
{
  const junk = [null, undefined, 0, 42, {}, [], '', true, NaN, Symbol ? undefined : undefined];
  for (const j of junk) {
    let threw = null;
    try {
      MediaUtils.rewriteAssetLinks(j, {});
      MediaUtils.convertPlaceholdersToHtml(j, {}, {});
      MediaUtils.sanitizeAssetName(j);
      MediaUtils.sniffImageExt(j);
      MediaUtils.extFromMediaType(j);
    } catch (e) { threw = e.message; }
    attack('survives ' + String(j), threw === null, threw);
  }
  let threw = null;
  try {
    MediaUtils.collectClaudeMessageMedia(null, 'o');
    MediaUtils.collectClaudeMessageMedia({ files: [null, 1, 'x', {}] }, 'o');
    MediaUtils.collectClaudeMessageMedia({ attachments: [null, {}, { extracted_content: 5 }] }, 'o');
    MediaUtils.collectGrokResponseMedia(null);
    MediaUtils.chatgptPartMedia(null);
  } catch (e) { threw = e.message; }
  attack('detectors survive malformed message shapes', threw === null, threw);
}

// ----------------------------------------------------------- E. collisions --
console.log('\n[E. two files, one name]');
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff]);
  const assigned = MediaUtils.assignAssetNames([
    { id: 'a', ok: true, name: 'x.png', bytes: png },
    { id: 'b', ok: true, name: 'x.png', bytes: png },
    { id: 'c', ok: true, name: 'X.PNG', bytes: png },
    { id: 'd', ok: true, name: '../../x.png', bytes: jpg },
    { id: 'e', ok: true, name: null, bytes: jpg },
    { id: 'f', ok: false, error: 'nope' },
  ], { idToMsg: { e: 7 } });
  const paths = Object.values(assigned.idToPath);
  attack('every path is unique (case-insensitively)',
    new Set(paths.map(p => p.toLowerCase())).size === paths.length, paths);
  attack('no path escapes assets/', paths.every(p => p.startsWith('assets/') && !p.includes('..')), paths);
  attack('a failed asset gets no path', !assigned.idToPath.f, assigned.idToPath.f);
}

// -------------------------------------------------------------- F. the zip --
console.log('\n[F. the zip itself]');
{
  let rejected = false;
  try { ZipWriter.createZip([{ name: 'a.txt', data: 'x' }, { name: 'A.TXT', data: 'y' }]); }
  catch (e) { rejected = true; }
  attack('duplicate entry names rejected, not silently merged', rejected);

  let ok = true;
  try { ZipWriter.createZip([{ name: 'assets/' + 'ă'.repeat(120) + '.png', data: 'x' }]); }
  catch (e) { ok = false; }
  attack('long UTF-8 entry name accepted', ok);

  let emptyRejected = false;
  try { ZipWriter.createZip([{ name: '', data: 'x' }]); }
  catch (e) { emptyRejected = true; }
  attack('empty entry name rejected', emptyRejected);

  const z = ZipWriter.createZip([{ name: 'a.txt', data: '' }]);
  attack('zero-byte entry still produces a valid archive', z && z.length > 22, z && z.length);
}

// ------------------------------------------------- G. lying about the bytes --
console.log('\n[G. the platform lies about what a file is]');
{
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  attack('webp sniffed regardless of the claimed name', MediaUtils.sniffImageExt(webp) === 'webp');
  attack('a .png name over webp bytes becomes .webp',
    MediaUtils.ensureExtension('holiday.png', 'webp') === 'holiday.webp',
    MediaUtils.ensureExtension('holiday.png', 'webp'));
  attack('a lying mediaType does not override real bytes',
    MediaUtils.ensureExtension('x.gif', 'png') === 'x.png', MediaUtils.ensureExtension('x.gif', 'png'));
  attack('garbage bytes sniff to nothing (no invented type)',
    MediaUtils.sniffImageExt(new Uint8Array([1, 2, 3, 4])) === null);
}

// ------------------------------------------------------- H. the new memory --
console.log('\n[H. the popup memory cannot grow forever]');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  attack('stored records are pruned or capped', /pruneMemory|MEMORY_MAX|MEMORY_TTL/.test(src),
    'no pruning found in popup.js');
}

console.log('\n' + (checks - failures.length) + '/' + checks + ' attacks held');
if (failures.length) {
  console.error('\nBROKEN BY: ' + failures.join(' | '));
}
process.exit(failures.length === 0 ? 0 : 1);
