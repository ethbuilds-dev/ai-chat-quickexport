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
        // platforms (Claude/Gemini/Grok) return the '__COOKIE_AUTH__' marker.
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
      refs = MediaUtils.collectGrokResponseMedia(r, onSkip) || [];
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

// Node-only export so the pure tree-walker can be exercised by tests/ against
// real fixtures. No effect in the service worker (module is undefined there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { walkChatGPTTree: walkChatGPTTree, fetchRetrying: fetchRetrying };
}
