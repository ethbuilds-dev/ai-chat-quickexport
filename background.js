// background.js — Service worker for multi-platform AI conversation export

// v1.5 media export: pure helpers (ref detection, placeholders, naming).
// In the service worker, importScripts loads MediaUtils onto `self`. Under
// Node (tests), importScripts is undefined — require the module instead so the
// pure tree-walker (walkChatGPTTree) can be unit-tested offline. Neither path
// touches chrome.* at load time.
if (typeof importScripts === 'function') {
  importScripts('media-utils.js');
} else if (typeof require !== 'undefined') {
  // eslint-disable-next-line no-global-assign
  var MediaUtils = require('./media-utils.js');
}

// Capture Claude's reasoning/"thinking" blocks as //system//...Done blocks
// (the live data path is fetchClaude here, NOT content.js). 2026-06-13.
const INCLUDE_SYSTEM_TRACES = true;

// Guard the listener registration so requiring this file under Node (tests,
// which exercise the pure walkChatGPTTree below) does not touch chrome.*.
// In the service worker `chrome` is always defined, so this is a no-op there.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_AND_FETCH') {
    let { conversationId, tabId, platform } = message;

    captureTokenFromPage(tabId, platform)
      .then(token => {
        // ChatGPT re-acquires its own token inside the page context (see
        // fetchChatGPT), so a null here isn't fatal for it. The cookie-auth
        // platforms (Claude/Gemini/Grok/AI Studio) return the '__COOKIE_AUTH__' marker.
        if (!token && platform !== 'chatgpt') {
          throw new Error('Could not capture auth token. Refresh the page and try again.');
        }
        return fetchConversation(conversationId, token, platform, tabId);
      })
      .then(data => sendResponse({ data }))
      .catch(err => sendResponse({ error: err.message }));

    return true;
  }

  // v1.5: download the media assets referenced by a previous CAPTURE_AND_FETCH.
  // Sent by the popup only when that response carried a non-empty `media`
  // array, so conversations without media never reach this path.
  // DEPRECATED for image batches: the single response carries every asset's
  // base64, and Chrome caps one extension message at ~64 MB — a 100-image
  // conversation (~200 MB raw, ~270 MB base64) kills the whole response and
  // every image exports as a failure note (field failure, 2026-08-06 export).
  // The popup now sends FETCH_MEDIA_ONE per ref; this stays for compatibility.
  if (message.type === 'FETCH_MEDIA') {
    fetchMediaAssets(message.media || [], message.platform, message.tabId)
      .then(assets => sendResponse({ assets }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // v1.5.1: one asset per message, so no response ever approaches the ~64 MB
  // message cap (a single image tops out around 2-8 MB base64). Same fetch
  // logic, same per-asset failure semantics.
  if (message.type === 'FETCH_MEDIA_ONE') {
    fetchMediaAssets([message.ref], message.platform, message.tabId)
      .then(assets => sendResponse({ asset: assets[0] || null }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
}

// ── Token Capture ─────────────────────────────────────────────────────

async function captureTokenFromPage(tabId, platform) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (plat) => {
        return (async () => {
          try {
            if (plat === 'chatgpt') {
              // ChatGPT: NextAuth session endpoint
              const r = await fetch('/api/auth/session', { credentials: 'include' });
              const d = await r.json();
              return d.accessToken || null;
            }

            if (plat === 'claude') {
              // Claude: session cookie-based, try getting org info which requires auth
              // Claude uses cookie-based auth, no Bearer token needed for API calls from same origin
              // Return a marker that means "use cookies"
              const r = await fetch('/api/organizations', { credentials: 'include' });
              if (r.ok) return '__COOKIE_AUTH__';
              return null;
            }

            if (plat === 'gemini') {
              // Gemini: uses Google auth cookies
              return '__COOKIE_AUTH__';
            }

            if (plat === 'grok') {
              // Grok: uses X/Twitter auth
              return '__COOKIE_AUTH__';
            }

            if (plat === 'aistudio') {
              // AI Studio: read from the page DOM, no API and no token to capture
              return '__COOKIE_AUTH__';
            }

            return null;
          } catch(e) {
            return null;
          }
        })();
      },
      args: [platform]
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return null;
  } catch (err) {
    console.error('[Exporter] Token capture failed:', err);
    return null;
  }
}

// ── Conversation Fetch ────────────────────────────────────────────────

async function fetchConversation(conversationId, token, platform, tabId) {
  if (platform === 'chatgpt') {
    return fetchChatGPT(conversationId, token, tabId);
  }
  if (platform === 'claude') {
    return fetchClaude(conversationId, token);
  }
  if (platform === 'gemini') {
    return fetchGemini(conversationId, token, tabId);
  }
  if (platform === 'aistudio') {
    return fetchAIStudio(conversationId, token, tabId);
  }
  if (platform === 'grok') {
    return fetchGrok(conversationId, token);
  }
  throw new Error('Unknown platform: ' + platform);
}

async function fetchChatGPT(conversationId, token, tabId) {
  // IMPORTANT (2026-06-29 fix): the backend-api fetch MUST run inside the page's
  // MAIN world, NOT here in the service worker.
  //
  // OpenAI tightened Cloudflare bot-management on chatgpt.com/backend-api/*. A
  // fetch issued from the extension service worker is seen by Cloudflare as a
  // cross-context request (extension origin, Sec-Fetch-Site != same-origin, a
  // service-worker TLS/context fingerprint) and gets 403'd — even with a valid
  // Bearer token and cookies. Claude/Grok don't run this protection, so their
  // service-worker fetches still work; ChatGPT is the only one that broke.
  //
  // Running the exact same fetch from the page context makes it indistinguishable
  // from ChatGPT's own frontend request: real browser TLS fingerprint, real
  // cf_clearance cookie, Sec-Fetch-Site: same-origin, correct Origin/Referer.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (convId, bearer) => {
      return (async () => {
        try {
          // Re-acquire a fresh token in-page if we weren't handed one.
          let tok = bearer;
          if (!tok) {
            try {
              const s = await fetch('/api/auth/session', { credentials: 'include' });
              const sd = await s.json();
              tok = sd.accessToken || null;
            } catch (e) { /* fall through; cookies may still suffice */ }
          }
          const headers = { 'Content-Type': 'application/json' };
          if (tok) headers['Authorization'] = 'Bearer ' + tok;
          const r = await fetch(
            'https://chatgpt.com/backend-api/conversation/' + convId,
            { credentials: 'include', headers }
          );
          if (!r.ok) {
            return { error: 'ChatGPT API: ' + r.status +
              (r.status === 403
                ? ' (Cloudflare blocked the request — reload the ChatGPT tab and make sure you are logged in, then try again)'
                : '') };
          }
          const d = await r.json();
          return { title: d.title || 'Untitled', mapping: d.mapping || null };
        } catch (e) {
          return { error: 'ChatGPT fetch failed: ' + (e && e.message ? e.message : String(e)) };
        }
      })();
    },
    args: [conversationId, token && token !== '__COOKIE_AUTH__' ? token : null]
  });

  const payload = results && results[0] && results[0].result;
  if (!payload) throw new Error('Could not reach the ChatGPT page context. Reload the tab and try again.');
  if (payload.error) throw new Error(payload.error);
  if (!payload.mapping) throw new Error('ChatGPT returned no conversation data.');

  // Walk tree (in the service worker — this is plain data work, no network).
  // v1.5: image asset pointers are collected into `media` and replaced by
  // in-text placeholders; string-only conversations are unaffected.
  const media = [];
  const messages = walkChatGPTTree(payload.mapping, media);
  const result = { title: payload.title || 'Untitled', messages, platform: 'chatgpt' };
  if (media.length > 0) result.media = media;
  return result;
}

async function fetchClaude(conversationId, token) {
  // Claude API: need org_id first, then fetch conversation
  // Claude uses /api/organizations/{org_id}/chat_conversations/{conv_id}
  try {
    // Get org ID
    const orgResp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include'
    });
    if (!orgResp.ok) throw new Error(`Claude orgs: ${orgResp.status}`);
    const orgs = await orgResp.json();
    const orgId = orgs[0]?.uuid;
    if (!orgId) throw new Error('No Claude organization found');

    // Fetch conversation
    const convResp = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?rendering_mode=messages`,
      { credentials: 'include' }
    );
    if (!convResp.ok) throw new Error(`Claude conversation: ${convResp.status}`);
    const conv = await convResp.json();

    // Normalize messages. v1.5: media refs (images/attachments) are collected
    // alongside, and a markdown placeholder ![alt](asset:<id>) is inserted
    // where each one appears. Conversations without media produce EXACTLY the
    // v1.4.3 output (no placeholders, no `media` key).
    const messages = [];
    const media = [];
    const onSkip = (why, entry) => {
      try {
        console.warn('[Exporter] media: skipped (' + why + '):',
          JSON.stringify(entry).slice(0, 300));
      } catch (e) {}
    };
    for (const msg of (conv.chat_messages || [])) {
      const role = msg.sender === 'human' ? 'user' : 'assistant';
      // Claude content can be array of blocks or a string
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Walk blocks in order. Text blocks → text. Thinking blocks → //system//
        // blocks (Zaina's format) — confirmed Claude API shape 2026-06-13:
        // { type:'thinking', thinking:'<reasoning>', summaries:[{summary:'...'}] }.
        // v1.5: image blocks → asset placeholder (in order).
        const segs = [];
        for (const b of msg.content) {
          if (b.type === 'text' && b.text) {
            segs.push(b.text);
          } else if (b.type === 'thinking' && INCLUDE_SYSTEM_TRACES) {
            const sums = Array.isArray(b.summaries)
              ? b.summaries.map(s => (typeof s === 'string' ? s : (s && s.summary) || '')).filter(Boolean).join('\n')
              : '';
            const body = (b.thinking || '').trim();
            const inner = [sums, body].filter(Boolean).join('\n');
            if (inner) segs.push('//system//\n' + inner + '\nDone');
          } else {
            const blockRef = MediaUtils.claudeContentBlockMedia(b);
            if (blockRef) {
              const id = 'm' + media.length;
              media.push(Object.assign({ id }, blockRef));
              segs.push(MediaUtils.makePlaceholder(id, blockRef.alt, blockRef.isImage));
            }
          }
        }
        text = segs.join('\n\n');
      } else if (msg.text) {
        text = msg.text;
      }
      // v1.5: message-level files/attachments (uploads) — placeholders are
      // appended after the message text, since the JSON gives no in-text anchor.
      const msgRefs = MediaUtils.collectClaudeMessageMedia(msg, orgId, onSkip);
      if (msgRefs.length > 0) {
        const phs = [];
        for (const ref of msgRefs) {
          const id = 'm' + media.length;
          media.push(Object.assign({ id }, ref));
          phs.push(MediaUtils.makePlaceholder(id, ref.alt, ref.isImage));
        }
        text = [text, phs.join('\n')].filter(Boolean).join('\n\n');
      }
      // Filter out unsupported block placeholders
      text = text.replace(/This block is not supported on your current device yet\.\n?/g, '').trim();
      if (text) {
        messages.push({ role, text });
      }
    }

    const result = { title: conv.name || conv.title || 'Untitled', messages, platform: 'claude' };
    if (media.length > 0) result.media = media;
    return result;
  } catch(err) {
    throw new Error('Claude: ' + err.message);
  }
}

async function fetchGemini(conversationId, token, tabId) {
  // Gemini uses Google's batchexecute RPC — no clean REST API
  // DOM scraping is the reliable approach
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const queries = document.querySelectorAll('.query-text');
        const responses = document.querySelectorAll('.model-response-text');
        const messages = [];
        const maxLen = Math.max(queries.length, responses.length);

        for (let i = 0; i < maxLen; i++) {
          if (i < queries.length) {
            const text = queries[i].innerText.trim();
            if (text) messages.push({role: 'user', text});
          }
          if (i < responses.length) {
            const text = responses[i].innerText.trim();
            if (text) messages.push({role: 'assistant', text});
          }
        }

        const title = document.title.replace(' - Google Gemini', '').trim() || 'Untitled Gemini';
        return { title, messages };
      }
    });

    if (results && results[0] && results[0].result) {
      const { title, messages } = results[0].result;
      if (messages.length === 0) throw new Error('No messages found. For long conversations, scroll to the top first.');
      return { title, messages, platform: 'gemini' };
    }
    throw new Error('Could not extract Gemini conversation');
  } catch(err) {
    throw new Error('Gemini: ' + err.message);
  }
}

// ── Google AI Studio (DOM) ────────────────────────────────────────────
// AI Studio has no export API, so — like Gemini — the conversation is read
// from the rendered page. The work is split so the half that can go wrong
// with text is testable offline (tests/fixtures/aistudio-dom.json):
//   aistudioReadPage()         runs INSIDE the tab, touches the DOM, returns
//                              raw innerText per chunk and interprets nothing
//   aistudioTurnsToMessages()  runs here and is pure: strips the page's
//                              chrome, fences code, folds chunks into messages
// DOM facts, verified live on aistudio.google.com/prompts/<id> (2026-11-01, a
// 120-turn prompt):
//   - every turn is <ms-chat-turn id="...">; an element inside it carries
//     data-turn-role="User" | "Model"
//   - THE LIST IS VIRTUALIZED. All 120 shells exist, with stable ids, but only
//     the 15-19 nearest the viewport hold any content; every other turn has an
//     EMPTY div.turn-content. Read once, the page yields ~15% of the
//     conversation (the first version of this adapter exported 3 text chunks
//     out of 120 turns). The scroller is ms-autoscroll-container (scrollHeight
//     26985 against clientHeight 446), so the page is read by scrolling it.
//   - the content is div.turn-content. ms-chat-turn-options (it renders the
//     icon words "edit" / "more_vert") and the "User 2:09 PM" header line are
//     NOT part of the content chunks
//   - chunks: ms-text-chunk (rendered markdown), ms-code-block,
//     ms-thought-chunk (a "Thoughts" panel), and ms-prompt-chunk for an
//     attached file: icon word, icon word, filename, "1,291 tokens" (a turn
//     can be nothing but several such cards)
//   - code blocks and thought panels are expansion panels: their headers put
//     the icon words content_copy / expand_less / expand_more into innerText
// NOT seen, so handled both ways: whether a fenced code block sits inside an
// ms-text-chunk or beside it, and what an expanded thought panel says on its
// header. If the layout is not recognized at all the turn's whole content
// area is returned as `fallback` instead of dropping the text.

// INJECTED into the tab by chrome.scripting.executeScript, which serializes it
// with toString() and awaits the promise it returns -- so it must stay
// self-contained: nothing declared outside its own body may be referenced from
// in here. Returns plain data only.
//
// A virtualized list is read in passes. Everything on screen is read first; if
// any turn is still empty, the scroller is stepped from top to bottom (0.8 of a
// screen at a time, waiting for the DOM to go quiet after each step), each turn
// is read wherever it shows content, and the scroll position is put back. A chat
// that is fully rendered is never scrolled.
async function aistudioReadPage() {
  const KNOWN = 'ms-thought-chunk, ms-text-chunk, ms-code-block';
  const innerText = (el) => (el && typeof el.innerText === 'string') ? el.innerText : '';
  // Outermost only: a chunk nested inside another is already part of its text.
  const outermost = (list) => list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  // A bare ms-prompt-chunk (no text, thought or code inside) is an attachment
  // card; one that wraps a text chunk is only a wrapper around it.
  const isUnit = (el) => el.matches(KNOWN) ||
    (el.localName === 'ms-prompt-chunk' && !el.querySelector(KNOWN));
  // The code itself (not the block's header: language label, copy button),
  // and its language when the markup names one. A collapsed block hides its
  // code from innerText, but the markup still holds it.
  const readCode = (block) => {
    const node = block.querySelector('pre code') || block.querySelector('code') ||
      block.querySelector('pre');
    const cls = (node && typeof node.className === 'string') ? node.className : '';
    const m = /(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(cls);
    let code = innerText(node || block);
    if (!code.trim() && node && typeof node.textContent === 'string') code = node.textContent;
    return { block: innerText(block), code, lang: m ? m[1] : '' };
  };

  const shells = () => Array.from(document.querySelectorAll('ms-chat-turn'));
  const keyOf = (turn, i) => turn.id || ('@' + i);
  const bodyOf = (turn) => turn.querySelector('div.turn-content') || turn;
  const unitsOf = (turn) => outermost(
    Array.from(bodyOf(turn).querySelectorAll(KNOWN + ', ms-prompt-chunk')).filter(isUnit)
  );
  const readTurn = (turn, units) => {
    const roleEl = turn.matches('[data-turn-role]') ? turn : turn.querySelector('[data-turn-role]');
    const role = roleEl ? String(roleEl.getAttribute('data-turn-role') || '').trim() : '';
    const chunks = units.map((el) => {
      const tag = el.localName;
      if (tag === 'ms-code-block') {
        const c = readCode(el);
        return { kind: 'code', text: c.code, lang: c.lang };
      }
      if (tag === 'ms-text-chunk') {
        const chunk = { kind: 'text', text: innerText(el) };
        const blocks = outermost(Array.from(el.querySelectorAll('ms-code-block')));
        if (blocks.length) chunk.code = blocks.map(readCode);
        return chunk;
      }
      if (tag === 'ms-thought-chunk') return { kind: 'thought', text: innerText(el) };
      return { kind: 'prompt', text: innerText(el) };
    });
    const rec = { role, chunks };
    // No recognizable chunk (a layout not met before, or a turn the page has not
    // rendered): hand back the whole content area rather than lose the text.
    if (chunks.length === 0) rec.fallback = innerText(bodyOf(turn));
    return rec;
  };

  // The richest record seen so far for each turn id. A Map keeps first-seen
  // order, but the order that counts is the DOM's, read again at the end.
  const seen = new Map();
  const harvest = () => {
    shells().forEach((turn, i) => {
      const key = keyOf(turn, i);
      const units = unitsOf(turn);
      const prev = seen.get(key);
      if (prev && units.length <= prev.chunks.length) return;   // nothing new here
      const rec = readTurn(turn, units);
      if (rec.chunks.length === 0 && !String(rec.fallback || '').trim()) return;   // not rendered
      seen.set(key, rec);
    });
  };
  const unread = () => shells().filter((turn, i) => !seen.has(keyOf(turn, i))).length;

  // ms-autoscroll-container, or failing that the nearest scrollable ancestor.
  const scroller = () => {
    const named = document.querySelector('ms-autoscroll-container');
    if (named) return named;
    const first = document.querySelector('ms-chat-turn');
    for (let p = first && first.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
    }
    return null;
  };
  // Resolves when the container has been still for 250 ms, or after 600 ms
  // whatever it is doing. Attributes are not watched: scrolling restyles
  // everything and says nothing about whether content has arrived.
  const settle = (el) => new Promise((resolve) => {
    let quiet = null;
    const obs = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 250); });
    const cap = setTimeout(() => finish(), 600);
    function finish() { clearTimeout(quiet); clearTimeout(cap); obs.disconnect(); resolve(); }
    quiet = setTimeout(finish, 250);
    obs.observe(el, { childList: true, subtree: true, characterData: true });
  });

  const sweep = { ran: false, steps: 0, ms: 0, unread: 0, timedOut: false };
  const t0 = Date.now();
  harvest();
  const container = unread() > 0 ? scroller() : null;
  if (container && container.scrollHeight > container.clientHeight + 1) {
    sweep.ran = true;
    const startTop = container.scrollTop;
    const step = Math.max(40, Math.floor(container.clientHeight * 0.8));
    try {
      let y = 0;
      for (let n = 0; n < 1500; n++) {
        container.scrollTop = y;
        await settle(container);
        harvest();
        sweep.steps++;
        const max = container.scrollHeight - container.clientHeight;   // grows as turns render
        if (y >= max) break;
        // A service worker request is cut off at 5 minutes; stop well short of it.
        if (Date.now() - t0 > 240000) { sweep.timedOut = true; break; }
        y = Math.min(y + step, max);
      }
    } finally {
      container.scrollTop = startTop;
    }
  }

  const all = shells();
  const turns = all.map((turn, i) => seen.get(keyOf(turn, i)) || readTurn(turn, unitsOf(turn)));
  sweep.unread = turns.filter((t) => t.chunks.length === 0 && !String(t.fallback || '').trim()).length;
  sweep.ms = Date.now() - t0;
  return { title: document.title || '', turnCount: all.length, turns, sweep };
}

// Material-icon ligatures arrive as plain words in innerText. GLYPHS are names
// nobody writes as a line of prose (they carry an underscore); ICON_WORDS adds
// the two ordinary words the page also renders as icons. They are only stripped
// where the text is page chrome (see aistudioChunkText): the ends of an
// attachment card, a thought panel, the header above a code block, a turn nobody
// recognized. A standalone "docs" or "edit" line is legitimate inside a code
// block or a list, and removing it there would corrupt the export.
const AISTUDIO_GLYPHS = new Set([
  'more_vert', 'chevron_right', 'expand_more', 'expand_less',
  'content_copy', 'thumb_up', 'thumb_down'
]);
const AISTUDIO_ICON_WORDS = new Set(['edit', 'docs'].concat(Array.from(AISTUDIO_GLYPHS)));
const AISTUDIO_HEADER_RE = /^(User|Model)\s+\d{1,2}:\d{2}\s?(AM|PM)?$/i;            // "User 2:09 PM"
const AISTUDIO_TOKENS_RE = /^\d[\d.,]*\s*[KkMm]?\s*tokens?$/i;                      // "1,291 tokens"
const AISTUDIO_THOUGHT_LABEL_RE = /^(Thoughts|(Expand to view|Collapse to hide) model thoughts)$/i;

function aistudioLines(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n');
}

// A line made of nothing but words from `set`: "edit", or "edit more_vert" when
// the option buttons render side by side instead of one per line.
function aistudioAllIn(set, line) {
  const words = line.trim().split(/\s+/);
  return words[0] !== '' && words.every((w) => set.has(w));
}

function aistudioIsIcon(line) {
  return aistudioAllIn(AISTUDIO_ICON_WORDS, line);
}

function aistudioIsGlyph(line) {
  return aistudioAllIn(AISTUDIO_GLYPHS, line);
}

// Blank lines off both ends, indentation of the first real line kept (a pasted
// code snippet may start indented).
function aistudioTidy(s) {
  return String(s).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

// "User 2:09 PM" opens a turn's text, possibly under the icon words of the
// turn's option buttons. Only a header actually found is removed (with the icon
// words above it); text without one is returned untouched.
function aistudioDropHeader(lines) {
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || aistudioIsIcon(lines[i]))) i++;
  return (i < lines.length && AISTUDIO_HEADER_RE.test(lines[i].trim())) ? lines.slice(i + 1) : lines;
}

// Chrome at the two ends of a chunk: leading icon words and panel labels,
// trailing icon words. The middle is content and is never touched.
function aistudioTrimChrome(lines, labelRe) {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a].trim() === '' || aistudioIsIcon(lines[a]) ||
         (labelRe && labelRe.test(lines[a].trim())))) a++;
  while (b > a && (lines[b - 1].trim() === '' || aistudioIsIcon(lines[b - 1]))) b--;
  return lines.slice(a, b);
}

// A ``` fence around code; longer when the code itself holds a run of backticks.
function aistudioFence(code, lang) {
  const body = aistudioTidy(aistudioLines(code).join('\n'));
  if (!body.trim()) return '';
  let longest = 0;
  for (const run of (body.match(/`+/g) || [])) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + (lang || '') + '\n' + body + '\n' + fence;
}

// Where `needle` fills whole lines of `hay`, from `from` on (-1 if nowhere), so
// a one-word code block is not mistaken for the same word inside a sentence.
function aistudioFindOwnLines(hay, needle, from) {
  if (!needle) return -1;
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    const end = i + needle.length;
    if ((i === 0 || hay[i - 1] === '\n') && (end === hay.length || hay[end] === '\n')) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

// The header chrome of a code block that sits just above its code, in any order:
// icon-glyph lines ("content_copy", "expand_less") and the language label. A run
// without a glyph in it is only text, and stays. `head` ends at a line start.
function aistudioDropHeaderAbove(head, lang) {
  const lines = head.split('\n');
  const label = String(lang || '').toLowerCase();
  let i = lines.length - 2;
  let glyph = false;
  while (i >= 0 && lines.length - 2 - i < 6) {
    const t = lines[i].trim();
    if (aistudioIsGlyph(t)) glyph = true;
    else if (!label || t.toLowerCase() !== label) break;
    i--;
  }
  return glyph ? lines.slice(0, i + 1).concat('').join('\n') : head;
}

// The text of a code block that shows no code: its header and nothing else
// (glyph lines, and at most one short label line).
function aistudioHeaderOnly(block) {
  const lines = aistudioLines(block).map((l) => l.trim()).filter(Boolean);
  const plain = lines.filter((l) => !aistudioIsGlyph(l));
  return lines.length > plain.length && plain.length <= 1 && plain.every((l) => l.length <= 30);
}

// A text chunk's innerText carries its code blocks as bare text. Put them back
// in fences: replace the block's whole text where it can be found (which also
// drops the header chrome inside it), else just the code, then clear any header
// chrome left on the lines above. A block showing only its header is removed; a
// block that cannot be placed is left alone. Nothing else is touched.
function aistudioFenceNested(text, blocks) {
  let out = aistudioLines(text).join('\n');
  let from = 0;
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!b) continue;
    const fenced = aistudioFence(b.code, b.lang);
    let needle = aistudioLines(b.block).join('\n').trim();
    let at = aistudioFindOwnLines(out, needle, from);
    if (!fenced) {
      if (at !== -1 && aistudioHeaderOnly(needle)) {
        const end = at + needle.length;
        out = out.slice(0, at) + out.slice(out[end] === '\n' ? end + 1 : end);
        from = at;
      }
      continue;
    }
    if (at === -1) {
      needle = aistudioTidy(aistudioLines(b.code).join('\n'));
      at = aistudioFindOwnLines(out, needle, from);
    }
    if (at === -1) continue;
    const head = aistudioDropHeaderAbove(out.slice(0, at), b.lang);
    out = head + fenced + out.slice(at + needle.length);
    from = head.length + fenced.length;
  }
  return out;
}

// One chunk -> the text it adds to its message ('' = adds nothing).
function aistudioChunkText(chunk, includeThoughts, first) {
  if (!chunk || typeof chunk.text !== 'string') return '';
  if (chunk.kind === 'code') return aistudioFence(chunk.text, chunk.lang);

  let lines = aistudioLines(chunk.text);
  if (first) lines = aistudioDropHeader(lines);

  if (chunk.kind === 'thought') {
    if (!includeThoughts) return '';
    // A collapsed panel is nothing but its own label ("Thoughts / Expand to
    // view model thoughts / chevron_right"): once that is gone, nothing is
    // left and the chunk is skipped -- the boilerplate is never exported. An
    // open panel adds icon glyphs (expand_less, and content_copy from any code
    // it shows) that can sit anywhere in the body, so those go wherever they stand.
    const body = aistudioTidy(aistudioTrimChrome(lines, AISTUDIO_THOUGHT_LABEL_RE)
      .filter((l) => !aistudioIsGlyph(l)).join('\n'));
    return /[\p{L}\p{N}]/u.test(body) ? '//system//\n' + body + '\nDone' : '';
  }

  if (chunk.kind === 'prompt') {
    // An attached file's card: icon word(s), the filename, then its token count.
    const parts = lines.map((l) => l.trim()).filter(Boolean);
    if (parts.some((l) => AISTUDIO_TOKENS_RE.test(l))) {
      const rest = parts.filter((l) => !AISTUDIO_TOKENS_RE.test(l) && !aistudioIsIcon(l));
      const name = (rest[rest.length - 1] || '')
        .replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
      return name ? '[attachment: ' + name + ']' : '[attachment]';
    }
    return aistudioTidy(aistudioTrimChrome(lines).join('\n'));
  }

  return aistudioTidy(aistudioFenceNested(lines.join('\n'), chunk.code));
}

// A turn with no recognizable chunk: its whole content area, chrome and all.
// Here (and only here) icon words are removed wherever they stand alone.
function aistudioFallbackText(text) {
  const kept = [];
  for (const line of aistudioDropHeader(aistudioLines(text))) {
    if (aistudioIsIcon(line)) continue;
    if (/^(Expand to view|Collapse to hide) model thoughts$/i.test(line.trim())) {
      if (kept.length && kept[kept.length - 1].trim() === 'Thoughts') kept.pop();
      continue;
    }
    kept.push(line);
  }
  return aistudioTidy(kept.join('\n'));
}

// aistudioReadPage()'s turns -> [{ role: 'user'|'assistant', text }]. One
// message per turn: its chunks are folded together in page order, thoughts
// as //system//...Done (the Claude adapter's convention), and a turn left with
// no text is dropped.
function aistudioTurnsToMessages(turns, opts) {
  const includeThoughts = !(opts && opts.includeThoughts === false);
  const messages = [];
  for (const turn of (Array.isArray(turns) ? turns : [])) {
    if (!turn) continue;
    const r = String(turn.role || '').trim().toLowerCase();
    const role = r === 'user' ? 'user' : (r === 'model' ? 'assistant' : null);
    if (!role) continue;
    const segs = [];
    if (Array.isArray(turn.chunks) && turn.chunks.length > 0) {
      turn.chunks.forEach((chunk, i) => segs.push(aistudioChunkText(chunk, includeThoughts, i === 0)));
    } else if (typeof turn.fallback === 'string') {
      segs.push(aistudioFallbackText(turn.fallback));
    }
    const text = segs.filter((s) => s && s.trim()).join('\n\n');
    if (text) messages.push({ role, text });
  }
  return messages;
}

// document.title is "<prompt name> | Google AI Studio" (the prompt name is cut
// short by Google; that is fine). A bare product title means no name yet.
function aistudioCleanTitle(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s*\|\s*Google AI Studio\s*$/i, '').trim();
  return (!t || /^Google AI Studio$/i.test(t)) ? 'Untitled AI Studio' : t;
}

async function fetchAIStudio(conversationId, token, tabId) {
  // No API to call: the page itself is the only source, same as Gemini -- but
  // its list is virtualized, so the page function scrolls it (seconds, not
  // milliseconds, for a long prompt) and returns once every turn has been seen.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: aistudioReadPage
    });

    const page = results && results[0] && results[0].result;
    if (!page) throw new Error('Could not extract AI Studio conversation');
    if (page.sweep && page.sweep.unread > 0) {
      console.warn('[Exporter] AI Studio: ' + page.sweep.unread + ' of ' + page.turnCount +
        ' turns had no readable content after the scroll sweep' + (page.sweep.timedOut ? ' (timed out)' : ''));
    }
    const messages = aistudioTurnsToMessages(page.turns, { includeThoughts: INCLUDE_SYSTEM_TRACES });
    if (messages.length === 0) {
      throw new Error(page.turnCount === 0
        ? 'No messages found: there are no chat turns on this page. Open a saved prompt and try again.'
        : 'No readable text in the ' + page.turnCount + ' chat turns on this page.');
    }
    return { title: aistudioCleanTitle(page.title), messages, platform: 'aistudio' };
  } catch(err) {
    throw new Error('AI Studio: ' + err.message);
  }
}

async function fetchGrok(conversationId, token) {
  // Step 1: Get response nodes (message IDs + sender)
  const nodesResp = await fetch(
    `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
    { credentials: 'include' }
  );
  if (!nodesResp.ok) throw new Error(`Grok nodes: ${nodesResp.status}`);
  const nodesData = await nodesResp.json();
  const nodes = nodesData.responseNodes || [];

  if (nodes.length === 0) throw new Error('No messages found in Grok conversation');

  // Step 2: Load full responses with text
  const ids = nodes.map(n => n.responseId);
  const loadResp = await fetch(
    `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseIds: ids })
    }
  );
  if (!loadResp.ok) throw new Error(`Grok load-responses: ${loadResp.status}`);
  const loadData = await loadResp.json();
  const responses = loadData.responses || [];

  // Step 3: Get conversation title
  const convResp = await fetch(
    `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true`,
    { credentials: 'include' }
  );
  let title = 'Untitled Grok';
  if (convResp.ok) {
    const convData = await convResp.json();
    title = convData.conversation?.title || title;
  }

  // Step 4: Normalize messages.
  // v1.5 (2026-07-08): defensively scan each response for ASSISTANT-GENERATED
  // images (Grok/Aurora). The field shapes are entirely INFERRED (no Grok
  // media sample was available) — MediaUtils.collectGrokResponseMedia
  // feature-detects a handful of plausible url-bearing shapes and returns []
  // for anything unrecognized, never throwing. When media is found, a
  // placeholder is appended to that message's text and a `media` ref is
  // collected; when none is found the output is byte-identical to before.
  const media = [];
  const onSkip = (why, entry) => {
    try {
      console.warn('[Exporter] media: skipped (' + why + '):',
        JSON.stringify(entry).slice(0, 300));
    } catch (e) {}
  };
  const messages = [];
  for (const r of responses) {
    const role = r.sender === 'human' ? 'user' : 'assistant';
    let text = (r.message && r.message.trim()) ? r.message.trim() : '';
    // Grok writes image cards into the message as <grok:render> tags whose
    // data lives in a sibling field. Until 2026-08-22 those tags landed in the
    // export as raw markup -- unreadable, and hiding the fact that a picture
    // had been shown at all. Turn them into a reference before anything else
    // touches the text. (Never fetched: they are web-search results on other
    // people's sites -- see MediaUtils.rewriteGrokRenderTags.)
    // Generated images ARE downloadable (Grok's own asset host) and become
    // real files in assets/; searched images are only referenced. Both start
    // life as <grok:render> tags in the text, so the placeholders for the
    // downloaded ones are built first and handed to the rewriter.
    let cardRefs = [];
    try {
      cardRefs = MediaUtils.collectGrokCardMedia(r) || [];
    } catch (e) {
      onSkip('grok card media threw', { error: e && e.message });
    }
    const cardPlaceholders = {};
    for (const ref of cardRefs) {
      const id = 'm' + media.length;
      media.push(Object.assign({ id }, ref));
      if (ref.cardId) cardPlaceholders[ref.cardId] = MediaUtils.makePlaceholder(id, ref.alt, true);
    }
    try {
      text = MediaUtils.rewriteGrokRenderTags(text, r, cardPlaceholders);
    } catch (e) {
      onSkip('grok render rewrite threw', { error: e && e.message });
    }
    let refs = [];
    try {
      // Her own uploads first (they have no tag in the text, so their
      // placeholders are appended), then the inferred generated-image shapes.
      refs = (MediaUtils.collectGrokUploadMedia(r, onSkip) || [])
        .concat(MediaUtils.collectGrokResponseMedia(r, onSkip) || []);
    } catch (e) {
      // Never let inferred media detection break a working text export.
      onSkip('grok media detection threw', { error: e && e.message });
      refs = [];
    }
    if (refs.length > 0) {
      const phs = [];
      for (const ref of refs) {
        const id = 'm' + media.length;
        media.push(Object.assign({ id }, ref));
        phs.push(MediaUtils.makePlaceholder(id, ref.alt, ref.isImage));
      }
      text = [text, phs.join('\n')].filter(Boolean).join('\n\n');
    }
    if (text) messages.push({ role, text });
  }

  const result = { title, messages, platform: 'grok' };
  if (media.length > 0) result.media = media;
  return result;
}

// ── Tree Walkers ──────────────────────────────────────────────────────

// v1.5: `mediaOut` (optional array) collects image/file refs found in
// non-string content parts; each becomes an in-text ![alt](asset:<id>)
// placeholder. With no media present, output is identical to v1.4.3
// (string parts trimmed and joined, objects dropped).
//
// v1.5 (2026-07-08, assistant-generated-image fix): the walker now also scans
// `role === 'tool'` messages for image asset pointers. This is where
// ChatGPT/DALL-E puts ASSISTANT-GENERATED images — NOT in the assistant text
// message's parts[], but in a separate tool message (author.name like
// 'dalle.text2im'). The previous walker filtered to user/assistant only, so
// generated images were silently dropped (bug reported by Zaina 2026-07-08:
// only user-uploaded images came out). Tool messages contribute their image
// placeholder(s) to the transcript but NOT their text/JSON chatter — that
// chatter (prompt echoes, tool JSON) is not conversational content. When a
// tool message carries image media, its placeholder is attributed to the
// role we emit as 'assistant' so it reads as an assistant turn.
//
// INFERRED (no live ChatGPT fixture): that generated images live on a
// `tool`-role message whose content.parts[] holds image_asset_pointer objects.
// Defensive: if a tool message has no recognizable image part, it is skipped
// exactly as before (nothing emitted), never thrown.
function walkChatGPTTree(mapping, mediaOut) {
  const messages = [];
  if (!mapping) return messages;

  // Find root
  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent || !mapping[node.parent]) {
      rootId = id;
      break;
    }
  }
  if (!rootId) return messages;

  // Iterative tree walk — avoids stack overflow on 200k+ message conversations
  const stack = [rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    const node = mapping[nodeId];
    if (!node) continue;

    if (node.message) {
      const role = node.message.author?.role;
      if (role === 'user' || role === 'assistant') {
        // Human filenames for asset pointers, when the platform provides them.
        const attNames = mediaOut
          ? MediaUtils.chatgptAttachmentNames(node.message.metadata)
          : {};
        const parts = [];
        for (const p of (node.message.content?.parts || [])) {
          if (typeof p === 'string') {
            const t = p.trim();
            if (t.length > 0) parts.push(t);
            continue;
          }
          if (!mediaOut || p == null || typeof p !== 'object') continue;
          const ref = MediaUtils.chatgptPartMedia(p);
          if (ref) {
            const id = 'm' + mediaOut.length;
            const name = attNames[ref.fileId] || null;
            mediaOut.push(Object.assign({ id }, ref, { name, alt: name || ref.alt }));
            parts.push(MediaUtils.makePlaceholder(id, name || ref.alt, ref.isImage));
          } else {
            // Unknown non-string part — log so one real export reveals the shape.
            try {
              console.warn('[Exporter] media: skipped unknown ChatGPT part (content_type=' +
                (p.content_type || '?') + '):', JSON.stringify(p).slice(0, 300));
            } catch (e) {}
          }
        }
        if (parts.length > 0) {
          messages.push({ role, text: parts.join('\n\n') });
        }
      } else if (role === 'tool' && mediaOut) {
        // ASSISTANT-GENERATED image path (INFERRED shape). Collect image
        // asset pointers only; emit ONLY the placeholder(s), never the tool's
        // textual chatter. If nothing image-like is found, emit nothing.
        const attNames = MediaUtils.chatgptAttachmentNames(node.message.metadata);
        const placeholders = [];
        for (const p of (node.message.content?.parts || [])) {
          if (p == null || typeof p !== 'object') continue; // strings = tool chatter, drop
          const ref = MediaUtils.chatgptPartMedia(p);
          if (ref) {
            const id = 'm' + mediaOut.length;
            const name = attNames[ref.fileId] || null;
            // Mark generated so a reviewer can tell uploads from generations.
            mediaOut.push(Object.assign({ id }, ref, { name, alt: name || ref.alt, generated: true }));
            placeholders.push(MediaUtils.makePlaceholder(id, name || ref.alt, ref.isImage));
          }
          // Non-image tool parts are intentionally ignored (not logged as
          // "unknown" — tool messages routinely carry non-media JSON).
        }
        if (placeholders.length > 0) {
          // Attribute the generated image(s) to an assistant turn.
          messages.push({ role: 'assistant', text: placeholders.join('\n\n') });
        }
      }
    }

    if (node.children) {
      // Push children in reverse order so first child is processed first
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
  return messages;
}

// ── v1.5 Media Asset Download ─────────────────────────────────────────
// Each asset resolves to { id, name, base64, mediaType?, ok:true } or
// { id, name, ok:false, error }. A single failed asset never fails the
// batch — its placeholder becomes a failure note in the export.

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return bufToBase64(bytes.buffer);
}

// Transient failures are not failures — they only look like one to a caller
// that gives up after the first try. Measured on claude.ai 2026-08-22: the
// SAME preview URL answered 503 once and 200 on all three immediate retries.
// Without this, one hiccup turns one image into a permanent
// "-- not exported" note in an export the user will keep for years, and a
// 95-image conversation makes that hiccup nearly certain.
// Retries only what is retryable: network errors, 5xx, 408, 429. A 401/403/404
// is an answer, not a stumble — it returns immediately.
async function fetchRetrying(url, init, attempts) {
  const max = attempts || 3;
  let last = null;
  for (let i = 0; i < max; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      const retryable = resp.status >= 500 || resp.status === 408 || resp.status === 429;
      if (!retryable || i === max - 1) return resp;
      last = 'HTTP ' + resp.status;
    } catch (err) {
      if (i === max - 1) throw err;
      last = err && err.message ? err.message : String(err);
    }
    const wait = 400 * Math.pow(3, i); // 400ms, 1200ms
    console.warn('[Exporter] media: retry ' + (i + 2) + '/' + max + ' after ' + last + ' — ' + url);
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error('unreachable');
}

async function fetchMediaAssets(media, platform, tabId) {
  const assets = [];
  // Sequential on purpose: exports are seconds-scale, and this avoids
  // hammering the platforms' file endpoints from an extension context.
  for (const ref of media) {
    try {
      if (ref.kind === 'inline-base64') {
        // Image bytes were already inline in the conversation JSON.
        assets.push({ id: ref.id, name: ref.name || null, base64: ref.base64, mediaType: ref.mediaType || null, ok: true });
      } else if (ref.kind === 'inline-text') {
        // Text extracted by the platform (e.g. Claude attachment content).
        assets.push({ id: ref.id, name: ref.name || null, base64: utf8ToBase64(ref.text || ''), mediaType: 'text/plain', ok: true });
      } else if (ref.kind === 'unavailable') {
        // The platform does not expose these bytes at all (measured, not
        // guessed). No request is made; the export says why instead.
        assets.push({ id: ref.id, name: ref.name || null, ok: false,
                      error: ref.reason || 'not available from the platform' });
      } else if (ref.kind === 'claude-url') {
        assets.push(await fetchClaudeAsset(ref));
      } else if (ref.kind === 'chatgpt-file') {
        assets.push(await fetchChatGPTAsset(ref, tabId));
      } else if (ref.kind === 'grok-url') {
        assets.push(await fetchGrokAsset(ref));
      } else {
        assets.push({ id: ref.id, name: ref.name || null, ok: false, error: 'unknown media kind: ' + ref.kind });
      }
    } catch (err) {
      console.warn('[Exporter] media: asset ' + ref.id + ' failed:', err);
      assets.push({ id: ref.id, name: ref.name || null, ok: false, error: err.message });
    }
  }
  return assets;
}

// Claude assets: cookie-authenticated fetch from the service worker — the
// same context that already fetches the conversation JSON (proven to carry
// auth; claude.ai runs no bot protection on its API).
async function fetchClaudeAsset(ref) {
  const url = ref.url.startsWith('/') ? 'https://claude.ai' + ref.url : ref.url;
  const resp = await fetchRetrying(url, { credentials: 'include' });
  if (!resp.ok) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'HTTP ' + resp.status };
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.indexOf('text/html') !== -1) {
    // A login/interstitial page, not the asset.
    return { id: ref.id, name: ref.name || null, ok: false, error: 'got HTML instead of file (auth?)' };
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength === 0) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'empty response' };
  }
  return { id: ref.id, name: ref.name || null, base64: bufToBase64(buf), mediaType: ct.split(';')[0] || null, ok: true };
}

// Grok assets (INFERRED, 2026-07-08): assistant-generated image URLs. The URL
// shape is guessed (see MediaUtils.collectGrokResponseMedia), so this is a
// plain, defensive cookie-authenticated service-worker fetch — grok.com runs
// no bot protection on its API (verified for the conversation fetch), and a
// CDN URL just ignores the cookies. Relative urls are resolved against
// grok.com. Per-asset failure is non-fatal (returns ok:false).
async function fetchGrokAsset(ref) {
  const url = (typeof ref.url === 'string' && ref.url.startsWith('/'))
    ? 'https://grok.com' + ref.url
    : ref.url;
  const resp = await fetchRetrying(url, { credentials: 'include' });
  if (!resp.ok) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'HTTP ' + resp.status };
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.indexOf('text/html') !== -1) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'got HTML instead of file (auth?)' };
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength === 0) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'empty response' };
  }
  return { id: ref.id, name: ref.name || null, base64: bufToBase64(buf), mediaType: ct.split(';')[0] || null, ok: true };
}

// ChatGPT assets: two steps, following the v1.4.3 MAIN-world pattern.
// 1) In the page's MAIN world (Cloudflare bot management 403s the service
//    worker on chatgpt.com/backend-api/*): resolve the file id to a signed
//    download_url, then try fetching the bytes in-page (base64'd there).
// 2) If the in-page fetch of the signed URL is CORS-blocked, fall back to
//    fetching it here in the service worker — the *.oaiusercontent.com host
//    permission makes that fetch CORS-exempt, and signed URLs need no cookies.
// The /download endpoint shape is INFERRED (see docs/v1.5-architecture-notes.md);
// both known URL forms are tried, failures are per-asset and non-fatal.
async function fetchChatGPTAsset(ref, tabId) {
  if (tabId == null) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'no tab for page-context fetch' };
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (fileId) => {
      return (async () => {
        try {
          let tok = null;
          try {
            const s = await fetch('/api/auth/session', { credentials: 'include' });
            const sd = await s.json();
            tok = sd.accessToken || null;
          } catch (e) { /* cookies may suffice */ }
          const headers = {};
          if (tok) headers['Authorization'] = 'Bearer ' + tok;

          // Resolve file id -> signed download_url (two known endpoint forms).
          const endpoints = [
            '/backend-api/files/' + fileId + '/download',
            '/backend-api/files/download/' + fileId
          ];
          let downloadUrl = null, lastStatus = null;
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep, { credentials: 'include', headers });
              lastStatus = r.status;
              if (!r.ok) continue;
              const d = await r.json();
              downloadUrl = d.download_url || d.downloadUrl || (d.file && d.file.download_url) || null;
              if (downloadUrl) break;
            } catch (e) { /* try next endpoint */ }
          }
          if (!downloadUrl) {
            return { error: 'could not resolve download_url (last status ' + lastStatus + ')' };
          }

          // Try to pull the bytes in-page; may be CORS-blocked (cross-origin
          // signed URL) — in that case hand the URL back for the SW fallback.
          try {
            const fr = await fetch(downloadUrl);
            if (!fr.ok) return { downloadUrl, error: 'asset HTTP ' + fr.status };
            const buf = await fr.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return {
              base64: btoa(bin),
              mediaType: (fr.headers.get('content-type') || '').split(';')[0] || null
            };
          } catch (e) {
            return { downloadUrl }; // CORS or network — let the SW try
          }
        } catch (e) {
          return { error: 'page-context media fetch failed: ' + (e && e.message ? e.message : String(e)) };
        }
      })();
    },
    args: [ref.fileId]
  });

  const payload = results && results[0] && results[0].result;
  if (!payload) {
    return { id: ref.id, name: ref.name || null, ok: false, error: 'no result from page context' };
  }
  if (payload.base64) {
    return { id: ref.id, name: ref.name || null, base64: payload.base64, mediaType: payload.mediaType || null, ok: true };
  }
  if (payload.downloadUrl) {
    // Service-worker fallback: host permission for *.oaiusercontent.com makes
    // this CORS-exempt; the signature in the URL carries the authorization.
    try {
      const resp = await fetchRetrying(payload.downloadUrl);
      if (!resp.ok) {
        return { id: ref.id, name: ref.name || null, ok: false, error: 'asset HTTP ' + resp.status };
      }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) {
        return { id: ref.id, name: ref.name || null, ok: false, error: 'empty asset response' };
      }
      const ct = resp.headers.get('content-type') || '';
      return { id: ref.id, name: ref.name || null, base64: bufToBase64(buf), mediaType: ct.split(';')[0] || null, ok: true };
    } catch (err) {
      return { id: ref.id, name: ref.name || null, ok: false, error: 'sw fallback failed: ' + err.message };
    }
  }
  return { id: ref.id, name: ref.name || null, ok: false, error: payload.error || 'unknown media failure' };
}

// Node-only export so the pure tree-walker (and the AI Studio text cleaner and
// page reader) can be exercised by tests/ against real fixtures. No effect in
// the service worker (module is undefined there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    walkChatGPTTree: walkChatGPTTree,
    fetchRetrying: fetchRetrying,
    aistudioReadPage: aistudioReadPage,
    aistudioTurnsToMessages: aistudioTurnsToMessages,
    aistudioCleanTitle: aistudioCleanTitle
  };
}
