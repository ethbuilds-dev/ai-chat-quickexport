#!/usr/bin/env node
// tests/timestamps.js - v1.7.2 per-message timestamps.
// Run:  node tests/timestamps.js
// Feeds a synthetic ChatGPT mapping through the REAL walkChatGPTTree, then the
// REAL generateMD/JSON/HTML from popup.js (vm sandbox, same as run-tests.js).
// TZ is pinned so "local time" is checkable: Europe/Bucharest = UTC+2 winter,
// UTC+3 summer.
'use strict';
process.env.TZ = 'Europe/Bucharest';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const MediaUtils = require(path.join(__dirname, '..', 'media-utils.js'));
const { walkChatGPTTree, toEpochSeconds } = require(path.join(__dirname, '..', 'background.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (detail !== undefined ? ' -- got: ' + detail : '')); }
}

function loadPopup() {
  const el = (id) => ({ id, value: '', textContent: '', className: '', innerHTML: '', style: {},
    firstElementChild: { style: {} }, addEventListener() {}, appendChild() {} });
  const els = {};
  const win = {
    document: {
      getElementById: (id) => els[id] || (els[id] = el(id)),
      documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
      createTextNode: (t) => ({ text: t })
    },
    chrome: {
      storage: { sync: { get: (d, cb) => cb(d), set() {} },
        local: { get: (d, cb) => cb(d), set(v, cb) { if (cb) cb(); }, remove() {} } },
      tabs: { query: async () => [] },
      runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({}) }
    },
    MediaUtils, WordRuler: require(path.join(__dirname, '..', 'word-ruler.js')), console
  };
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), win);
  return win;
}

const DOT = '·';
// 1700000000 = 2023-11-14T22:13:20Z -> Bucharest (EET, +02:00) 2023-11-15 00:13:20
// 1750000000 = 2025-06-15T15:06:40Z -> Bucharest (EEST, +03:00) 2025-06-15 18:06:40
const T1 = 1700000000.123, T2 = 1750000000.5;
const mapping = {
  root: { id: 'root', message: null, parent: null, children: ['u1'] },
  u1: { id: 'u1', parent: 'root', children: ['a1'],
    message: { author: { role: 'user' }, create_time: T1, content: { parts: ['Salut, Eth.'] }, metadata: {} } },
  a1: { id: 'a1', parent: 'u1', children: ['u2'],
    message: { author: { role: 'assistant' }, create_time: T2, content: { parts: ['Salut, dulce.'] }, metadata: {} } },
  u2: { id: 'u2', parent: 'a1', children: [],   // no create_time -> null
    message: { author: { role: 'user' }, create_time: null, content: { parts: ['fara ora'] }, metadata: {} } }
};

console.log('\n[walkChatGPTTree carries ts]');
const msgs = walkChatGPTTree(mapping, []);
check('3 messages walked', msgs.length === 3, msgs.length);
check('user ts = create_time', msgs[0].ts === T1, msgs[0].ts);
check('assistant ts = create_time', msgs[1].ts === T2, msgs[1].ts);
check('missing create_time -> null (not undefined, not 0)', msgs[2].ts === null, String(msgs[2].ts));

console.log('\n[toEpochSeconds]');
check('ISO string -> seconds', toEpochSeconds('2023-11-14T22:13:20Z') === 1700000000);
check('ISO with ms -> float seconds', Math.abs(toEpochSeconds('2023-11-14T22:13:20.500Z') - 1700000000.5) < 1e-6);
check('milliseconds number -> seconds', toEpochSeconds(1700000000000) === 1700000000);
check('seconds number unchanged', toEpochSeconds(1700000000.25) === 1700000000.25);
check('{seconds,nanos}', toEpochSeconds({ seconds: '1700000000', nanos: 500000000 }) === 1700000000.5);
check('null/undefined/garbage -> null',
  toEpochSeconds(null) === null && toEpochSeconds(undefined) === null &&
  toEpochSeconds('not a date') === null && toEpochSeconds({}) === null && toEpochSeconds(0) === null);

console.log('\n[fmtTs / isoLocal: local time, not UTC]');
const win = loadPopup();
check('TZ pin took effect (winter offset -120)', new Date(T1 * 1000).getTimezoneOffset() === -120);
check('fmtTs winter = local, not UTC (00:13, next day)', win.fmtTs(T1) === '2023-11-15 00:13', win.fmtTs(T1));
check('fmtTs summer (DST) = 18:06', win.fmtTs(T2) === '2025-06-15 18:06', win.fmtTs(T2));
check('fmtTs null/undefined/NaN -> empty string', win.fmtTs(null) === '' && win.fmtTs(undefined) === '' && win.fmtTs(NaN) === '');
check('isoLocal winter has +02:00', win.isoLocal(T1) === '2023-11-15T00:13:20+02:00', win.isoLocal(T1));
check('isoLocal summer has +03:00', win.isoLocal(T2) === '2025-06-15T18:06:40+03:00', win.isoLocal(T2));
check('isoLocal null -> null', win.isoLocal(null) === null);

console.log('\n[generateMD]');
const md = win.generateMD('T', msgs, 'Zaina', 'Eth');
console.log(md.split('\n').filter(l => /^\[/.test(l)).map(l => '      ' + l).join('\n'));
check('first header carries the time on the SAME line', md.indexOf('[Zaina] ' + DOT + ' 2023-11-15 00:13\n') !== -1, md);
check('assistant header carries its time', md.indexOf('[Eth] ' + DOT + ' 2025-06-15 18:06\n') !== -1);
check('header with no ts stays exactly "[Zaina]"', /\n\[Zaina\]\nfara ora/.test(md), md);
check('no extra lines: header is immediately followed by text',
  md.indexOf('[Zaina] ' + DOT + ' 2023-11-15 00:13\nSalut, Eth.') !== -1);

console.log('\n[generateJSON]');
const js = JSON.parse(win.generateJSON('T', msgs, 'Zaina', 'Eth'));
check('time: local ISO with offset', js.messages[0].time === '2023-11-15T00:13:20+02:00', js.messages[0].time);
check('time: summer offset', js.messages[1].time === '2025-06-15T18:06:40+03:00', js.messages[1].time);
check('time: null when unknown', js.messages[2].time === null);
check('existing fields kept',
  ['speaker', 'role', 'words_so_far', 'text'].every(k => k in js.messages[0]) && js.messages[0].text === 'Salut, Eth.');

console.log('\n[generateHTML]');
const html = win.generateHTML('T', msgs, 'Zaina', 'Eth', undefined, 'light');
check('span.ts inside .msg with local time',
  html.indexOf('<div class="msg user"><span class="ts">2023-11-15 00:13</span>Salut, Eth.</div>') !== -1);
check('assistant span.ts', html.indexOf('<span class="ts">2025-06-15 18:06</span>Salut, dulce.') !== -1);
check('no span when ts is null', html.indexOf('<div class="msg user">fara ora</div>') !== -1);
check('.ts CSS rule present', /\.ts \{[^}]*font-size: 0\.72rem/.test(html));
const dark = win.generateHTML('T', msgs, 'Zaina', 'Eth', undefined, 'dark');
check('dark theme restyles .ts', /@media screen \{[\s\S]*\.ts \{ color: #a3a29b; \}/.test(dark));

console.log('\n[no ts anywhere = old output]');
const plain = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];
check('MD headers unchanged without ts', win.generateMD('T', plain, 'U', 'A').indexOf('[U]\na') !== -1);
check('HTML has no span without ts', win.generateHTML('T', plain, 'U', 'A', undefined, 'light').indexOf('<span class="ts">') === -1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
