// background.js — Service worker for multi-platform AI conversation export

// Capture Claude's reasoning/"thinking" blocks as //system//...Done blocks
// (the live data path is fetchClaude here, NOT content.js). 2026-06-13.
const INCLUDE_SYSTEM_TRACES = true;

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
});

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
  const messages = walkChatGPTTree(payload.mapping);
  return { title: payload.title || 'Untitled', messages, platform: 'chatgpt' };
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

    // Normalize messages
    const messages = [];
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
          }
        }
        text = segs.join('\n\n');
      } else if (msg.text) {
        text = msg.text;
      }
      // Filter out unsupported block placeholders
      text = text.replace(/This block is not supported on your current device yet\.\n?/g, '').trim();
      if (text) {
        messages.push({ role, text });
      }
    }

    return { title: conv.name || conv.title || 'Untitled', messages, platform: 'claude' };
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

  // Step 4: Normalize messages
  const messages = responses
    .filter(r => r.message && r.message.trim())
    .map(r => ({
      role: r.sender === 'human' ? 'user' : 'assistant',
      text: r.message.trim()
    }));

  return { title, messages, platform: 'grok' };
}

// ── Tree Walkers ──────────────────────────────────────────────────────

function walkChatGPTTree(mapping) {
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
        const parts = (node.message.content?.parts || [])
          .filter(p => typeof p === 'string')
          .map(p => p.trim())
          .filter(p => p.length > 0);
        if (parts.length > 0) {
          messages.push({ role, text: parts.join('\n\n') });
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
