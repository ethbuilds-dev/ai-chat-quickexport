#!/usr/bin/env node
// tests/text-only.js - v1.8.0 "Text only (no images, single .md)".
// Run:  node tests/text-only.js           (add --show to print both Markdown outputs)
// Runs the REAL doExport / generateMD from popup.js in a vm sandbox (same idea as
// run-tests.js and timestamps.js) on a fake ChatGPT conversation with one image
// and one attached file. The stubbed chrome.runtime records every message
// popup.js sends, so "no asset bytes are requested" is checked as a fact: with the
// box ticked the ONLY message is CAPTURE_AND_FETCH, never FETCH_MEDIA_ONE.
// TZ is pinned so the "local time" stamps in the Markdown are checkable.
'use strict';
process.env.TZ = 'Europe/Bucharest';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const MediaUtils = require(path.join(__dirname, '..', 'media-utils.js'));
const ZipWriter = require(path.join(__dirname, '..', 'zipwriter.js'));
const WordRuler = require(path.join(__dirname, '..', 'word-ruler.js'));
const SHOW = process.argv.indexOf('--show') !== -1;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (detail !== undefined ? ' -- got: ' + detail : '')); }
}

// ---- the fake conversation -----------------------------------------------
// Shaped like background.js output: asset placeholders inside the message text,
// one media ref per placeholder.
const T1 = 1700000000.123, T2 = 1750000000.5;   // 2023-11-15 00:13 / 2025-06-15 18:06 in Bucharest
const PH_IMG = MediaUtils.makePlaceholder('m0', 'bug screenshot.png', true);
const PH_FILE = MediaUtils.makePlaceholder('m1', 'server.log', false);
const TEXT1 = 'Why does this crash?\n' + PH_IMG + '\nIt happens on start.';
const TEXT2 = 'The stack trace shows a null deref.';
const TEXT3 = 'Here is the log: ' + PH_FILE + ' - thanks.';
function convo(withMedia) {
  return {
    title: 'Crash on start',
    messages: [
      { role: 'user', ts: T1, text: withMedia ? TEXT1 : 'Why does this crash? It happens on start.' },
      { role: 'assistant', ts: T2, text: TEXT2 },
      { role: 'user', ts: null, text: withMedia ? TEXT3 : 'Here is the log - thanks.' }
    ],
    media: withMedia ? [
      { id: 'm0', kind: 'test', name: 'bug screenshot.png', alt: 'bug screenshot.png', isImage: true },
      { id: 'm1', kind: 'test', name: 'server.log', alt: 'server.log', isImage: false }
    ] : []
  };
}
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LOG_B64 = Buffer.from('boom\n').toString('base64');

// ---- sandbox ---------------------------------------------------------------
class FakeBlob {
  constructor(parts, o) { this.parts = parts || []; this.type = (o && o.type) || ''; this.isFakeBlob = true; }
}
function bytesOf(part) {
  if (part && part.isFakeBlob) return Buffer.concat(part.parts.map(bytesOf));
  if (typeof part === 'string') return Buffer.from(part, 'utf8');
  if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
  return Buffer.alloc(0);
}

function loadPopup(opts) {
  opts = opts || {};
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, value: '', textContent: '', className: '', innerHTML: '', style: {}, listeners: {}, checked: false,
    firstElementChild: { style: {} },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    appendChild() {},
    fire(type) { (this.listeners[type] || []).forEach(fn => fn({ target: this })); }
  });
  const writes = [];          // every chrome.storage.local.set payload, as JSON
  const sent = [];            // every chrome.runtime.sendMessage payload
  const downloads = [];       // { name, bytes } per anchor click
  const zips = [];            // entries handed to ZipWriter.createZip
  const blobs = [];
  let activeTab = null;       // none while popup.js loads, so its start-up sees no tab
  const win = {
    document: {
      getElementById: el,
      documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
      createTextNode: (t) => ({ text: t }),
      createElement: () => {
        const a = { style: {}, remove() {} };
        a.click = () => {
          downloads.push({ name: a.download, bytes: bytesOf(blobs[Number(String(a.href).split('/').pop())]) });
        };
        return a;
      },
      body: { appendChild() {} }
    },
    chrome: {
      storage: {
        sync: { get: (d, cb) => cb(d), set() {} },
        local: {
          get: (d, cb) => cb(Object.assign({}, d, opts.stored || {})),
          set: (v, cb) => { writes.push(JSON.stringify(v)); if (cb) cb(); },
          remove() {}
        }
      },
      tabs: { query: async () => (activeTab ? [activeTab] : []) },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg.type === 'CAPTURE_AND_FETCH') return { data: convo(opts.withMedia !== false) };
          if (msg.type === 'FETCH_MEDIA_ONE') {
            return { asset: { id: msg.ref.id, name: msg.ref.name, ok: true,
              base64: msg.ref.isImage ? PNG_B64 : LOG_B64, mediaType: msg.ref.isImage ? 'image/png' : 'text/plain' } };
          }
          return {};
        }
      }
    },
    Blob: FakeBlob,
    URL: { createObjectURL: (b) => { blobs.push(b); return 'blob:fake/' + (blobs.length - 1); }, revokeObjectURL() {} },
    setTimeout: () => 0,      // popup.js revokes its blob URL after 30 s; nothing here should keep Node alive
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    MediaUtils, WordRuler, console,
    // Typed arrays made inside the sandbox are another realm's, which the real
    // zip writer's instanceof check refuses; copy them over. Also records the entries.
    ZipWriter: {
      createZip(entries) {
        zips.push(entries);
        return ZipWriter.createZip(entries.map(e => ({
          name: e.name, data: ArrayBuffer.isView(e.data) ? Uint8Array.from(e.data) : e.data
        })));
      }
    }
  };
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), win);
  return {
    win, els, writes, sent, downloads, zips,
    async run(format) {
      // popup.js's own start-up (the filename preview) is still settling; let it
      // finish before the typed filename goes in, or it blanks the field.
      await new Promise((resolve) => setImmediate(resolve));
      activeTab = { id: 7, url: 'https://chatgpt.com/c/0a1b2c3d-1111-2222-3333-444455556666' };
      els.exportFilename.value = 'backup';
      sent.length = 0; downloads.length = 0; zips.length = 0;
      await win.doExport(format);
      return els.status.textContent;
    }
  };
}
const fetches = (app) => app.sent.filter(m => /^FETCH_MEDIA/.test(m.type)).length;
const types = (app) => app.sent.map(m => m.type).join(',');

// ---- MediaUtils.omitAssetLinks (pure) ---------------------------------------
console.log('\n[omitAssetLinks]');
{
  const omit = MediaUtils.omitAssetLinks;
  check('image -> [image omitted]', omit(PH_IMG) === '[image omitted]', omit(PH_IMG));
  check('attachment keeps its filename', omit(PH_FILE) === '[attachment omitted: server.log]', omit(PH_FILE));
  const generic = MediaUtils.makePlaceholder('m2', '', false);   // alt falls back to the generic "attachment"
  check('generic attachment -> no filename to show', omit(generic) === '[attachment omitted]', omit(generic));
  const prompt = MediaUtils.makePlaceholder('m3', 'a cat in a hat riding a bicycle on the moon', true);
  check('a generated image\'s prompt-alt stays out of the note', omit(prompt) === '[image omitted]', omit(prompt));
  check('text around the placeholders is untouched',
    omit('a ' + PH_IMG + ' b ' + PH_FILE + ' c') === 'a [image omitted] b [attachment omitted: server.log] c');
  const dollars = MediaUtils.makePlaceholder('m4', 'cost $& $1 $$.txt', false);
  check('$-patterns in a filename are literal', omit(dollars) === '[attachment omitted: cost $& $1 $$.txt]', omit(dollars));
  const many = omit(Array(5).fill(PH_IMG).join(' '));
  check('every placeholder goes, none left over',
    many === Array(5).fill('[image omitted]').join(' ') && many.indexOf('asset:') === -1 && many.indexOf('![') === -1, many);
  const plain = 'no asset here [a link](http://x.test/p) and ![img](http://x.test/p.png)';
  check('ordinary links and images are not touched', omit(plain) === plain);
  check('non-strings pass through', omit(null) === null && omit(undefined) === undefined && omit(42) === 42);
}

// ---- the popup, end to end ----------------------------------------------------
async function main() {
  console.log('\n[option OFF (default): .md with media = zip, assets fetched]');
  const off = loadPopup();
  check('box starts unchecked', off.els.textOnly.checked === false);
  const offStatus = await off.run('md');
  check('export ran (' + offStatus + ')', !/^Failed|^Error/.test(offStatus), offStatus);
  check('both assets requested one by one', fetches(off) === 2 && types(off) === 'CAPTURE_AND_FETCH,FETCH_MEDIA_ONE,FETCH_MEDIA_ONE', types(off));
  check('one download, a .zip', off.downloads.length === 1 && off.downloads[0].name === 'backup.zip' &&
    off.downloads[0].bytes.slice(0, 2).toString() === 'PK', off.downloads.map(d => d.name).join());
  const offMd = off.zips[0] && off.zips[0][0].data;
  check('the zip\'s .md links into assets/', /!\[bug screenshot\.png\]\(assets\/[^)]+\)/.test(offMd) && /\(assets\/server\.log\)/.test(offMd), offMd);

  console.log('\n[option ON: .md = no asset request, one plain .md]');
  const on = loadPopup({ stored: { textOnly: true } });
  check('stored true -> box starts checked', on.els.textOnly.checked === true);
  const onStatus = await on.run('md');
  check('export ran (' + onStatus + ')', !/^Failed|^Error/.test(onStatus), onStatus);
  check('NO asset bytes requested: the only message is CAPTURE_AND_FETCH', types(on) === 'CAPTURE_AND_FETCH', types(on));
  check('no zip built', on.zips.length === 0);
  check('exactly one download, backup.md', on.downloads.length === 1 && on.downloads[0].name === 'backup.md',
    on.downloads.map(d => d.name).join());
  const onMd = on.downloads[0] ? on.downloads[0].bytes.toString('utf8') : '';
  check('image -> [image omitted], in place',
    onMd.indexOf('Why does this crash?\n[image omitted]\nIt happens on start.') !== -1, onMd);
  check('attachment -> [attachment omitted: server.log], in place',
    onMd.indexOf('Here is the log: [attachment omitted: server.log] - thanks.') !== -1, onMd);
  check('no link into a zip that does not exist', !/asset:|assets\/|!\[/.test(onMd), onMd);
  check('the rest of the text is exactly as before', onMd.indexOf(TEXT2) !== -1);
  const wcOff = /> Word count[^\n]*/.exec(offMd), wcOn = /> Word count[^\n]*/.exec(onMd);
  check('word-count line still there, counted on the text the file holds',
    !!wcOn && wcOn[0] === '> Word count — USER: 19 · ASSISTANT: 7 · Total: 26', wcOn && wcOn[0]);
  check('timestamps unchanged (user, assistant; none where null)',
    onMd.indexOf('[USER] · ' + on.win.fmtTs(T1)) !== -1 && onMd.indexOf('[ASSISTANT] · ' + on.win.fmtTs(T2)) !== -1 &&
    onMd.indexOf('[USER] · ' + on.win.fmtTs(T1)) < onMd.indexOf('[ASSISTANT]') &&
    /\n\[USER\]\nHere is the log/.test(onMd) && on.win.fmtTs(T1) === '2023-11-15 00:13', on.win.fmtTs(T1));
  check('status says what was left out', /text only, 2 attachments left out/.test(onStatus), onStatus);
  check('Markdown differs from OFF only in the asset references',
    offMd.replace(/!?\[[^\]\n]*\]\(assets\/[^)\n]*\)/g, '@').replace(/> Word count[^\n]*/, '') ===
    onMd.replace(/\[(image|attachment) omitted[^\]\n]*\]/g, '@').replace(/> Word count[^\n]*/, ''));

  console.log('\n[option ON leaves .json and .html alone]');
  for (const fmt of ['json', 'html']) {
    const app = loadPopup({ stored: { textOnly: true } });
    const status = await app.run(fmt);
    check(fmt + ': ran (' + status + ')', !/^Failed|^Error/.test(status), status);
    check(fmt + ': assets still fetched', fetches(app) === 2, types(app));
    check(fmt + ': download is ' + (fmt === 'json' ? 'the .zip' : 'the one .html'),
      app.downloads.length === 1 && app.downloads[0].name === (fmt === 'json' ? 'backup.zip' : 'backup.html'),
      app.downloads.map(d => d.name).join());
  }

  console.log('\n[option ON, conversation without media = same file as OFF]');
  {
    const a = loadPopup({ withMedia: false }), b = loadPopup({ withMedia: false, stored: { textOnly: true } });
    await a.run('md'); await b.run('md');
    check('no media: nothing fetched either way', fetches(a) === 0 && fetches(b) === 0);
    check('byte-identical .md', a.downloads.length === 1 && b.downloads.length === 1 &&
      a.downloads[0].bytes.equals(b.downloads[0].bytes));
  }

  console.log('\n[the choice is remembered]');
  {
    const fresh = loadPopup();
    check('default: unchecked, nothing written', fresh.els.textOnly.checked === false && fresh.writes.length === 0);
    fresh.els.textOnly.checked = true; fresh.els.textOnly.fire('change');
    check('ticking saves { textOnly: true }', fresh.writes[fresh.writes.length - 1] === '{"textOnly":true}', fresh.writes.join());
    fresh.els.textOnly.checked = false; fresh.els.textOnly.fire('change');
    check('unticking saves { textOnly: false }', fresh.writes[fresh.writes.length - 1] === '{"textOnly":false}', fresh.writes.join());
    check('a junk stored value is not "on"', loadPopup({ stored: { textOnly: 'yes' } }).els.textOnly.checked === false);
    check('ticked live (no reload) takes effect on the next export', await (async () => {
      const app = loadPopup(); app.els.textOnly.checked = true;
      await app.run('md');
      return types(app) === 'CAPTURE_AND_FETCH' && app.downloads[0].name === 'backup.md';
    })());
  }

  console.log('\n[popup.html]');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
    const tag = /<input[^>]*id="textOnly"[^>]*>/.exec(html);
    check('a checkbox with id textOnly', !!tag && /type="checkbox"/.test(tag[0]), tag && tag[0]);
    check('unchecked by default (no checked / disabled attribute)', !!tag && !/\b(checked|disabled)\b/.test(tag[0]));
    check('label reads "Text only (no images, single .md)"', html.indexOf('<span>Text only (no images, single .md)</span>') !== -1);
    check('sits under the format buttons, above the progress bar',
      html.indexOf('id="exportHtml"') < html.indexOf('id="textOnly"') && html.indexOf('id="textOnly"') < html.indexOf('id="progress"'));
  }

  if (SHOW) {
    console.log('\n===== option OFF: the .md inside backup.zip (assets fetched) =====\n' + offMd);
    console.log('\n===== option ON: backup.md (nothing fetched) =====\n' + onMd);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('test run crashed:', err); process.exit(1); });
