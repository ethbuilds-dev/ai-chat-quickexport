// content.js — Injected into ChatGPT pages
// Handles: auth interception, export button, tree walking, markdown generation

(function () {
  'use strict';

  // ── Auth Token Interception ──────────────────────────────────────────
  // Content scripts run in isolated world and can't patch the page's fetch.
  // Inject a script into the page's MAIN world via <script> element,
  // communicate back via window.postMessage.

  const injectedCode = `
    (function() {
      const _origFetch = window.fetch;
      let _tokenSent = false;
      window.fetch = async function(...args) {
        const [resource, config] = args;
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url && url.includes('/backend-api/') && config?.headers && !_tokenSent) {
          const headers = config.headers;
          let auth = null;
          if (headers instanceof Headers) { auth = headers.get('Authorization'); }
          else if (typeof headers === 'object') { auth = headers['Authorization'] || headers['authorization']; }
          if (auth && auth.startsWith('Bearer ')) {
            _tokenSent = true;
            window.postMessage({type: 'CHATGPT_EXPORTER_TOKEN', token: auth.replace('Bearer ', '')}, '*');
          }
        }
        return _origFetch.apply(this, args);
      };
    })();
  `;

  const script = document.createElement('script');
  script.textContent = injectedCode;
  document.documentElement.appendChild(script);
  script.remove();

  // Listen for token from the injected page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'CHATGPT_EXPORTER_TOKEN') {
      chrome.runtime.sendMessage({ type: 'AUTH_TOKEN', token: event.data.token });
      console.log('[Exporter] Auth token captured via page injection');
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────
  const DEFAULT_USER_LABEL = 'USER';
  const DEFAULT_ASSISTANT_LABEL = 'ASSISTANT';

  async function getLabels() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { userLabel: DEFAULT_USER_LABEL, assistantLabel: DEFAULT_ASSISTANT_LABEL },
        (settings) => resolve(settings)
      );
    });
  }

  // ── Conversation ID from URL ─────────────────────────────────────────
  function getConversationId() {
    const match = window.location.pathname.match(/\/(?:c|g)\/([a-f0-9-]+)/);
    if (match) return match[1];
    // Also try the /c/ pattern directly
    const match2 = window.location.pathname.match(/\/c\/([a-f0-9-]+)/);
    if (match2) return match2[1];
    return null;
  }

  // ── Tree Walker ──────────────────────────────────────────────────────
  // The API returns mapping: { nodeId: { message, parent, children } }
  // We find the root (no parent or parent not in mapping), then walk children in order.

  function walkConversationTree(mapping) {
    const messages = [];

    // Find root node: the one whose parent is null or not present in mapping
    let rootId = null;
    for (const [id, node] of Object.entries(mapping)) {
      if (!node.parent || !mapping[node.parent]) {
        rootId = id;
        break;
      }
    }

    if (!rootId) {
      console.error('[Exporter] Could not find root node');
      return messages;
    }

    // BFS/DFS walk following first child path (linear conversation)
    // For branched conversations, we follow the first child at each level
    function walk(nodeId) {
      const node = mapping[nodeId];
      if (!node) return;

      if (node.message) {
        const role = node.message.author?.role;
        const content = node.message.content;

        // Skip system messages, tool calls, tool results
        if (role === 'system' || role === 'tool') {
          // Still walk children
        } else if (role === 'user' || role === 'assistant') {
          const textParts = extractTextParts(content);
          if (textParts.length > 0) {
            messages.push({
              role: role,
              text: textParts.join('\n\n')
            });
          }
        }
      }

      // Walk children in order
      if (node.children && node.children.length > 0) {
        for (const childId of node.children) {
          walk(childId);
        }
      }
    }

    walk(rootId);
    return messages;
  }

  function extractTextParts(content) {
    if (!content || !content.parts) return [];

    return content.parts
      .filter(part => typeof part === 'string')
      .map(part => part.trim())
      .filter(part => part.length > 0);
  }

  // ── Output Generation ────────────────────────────────────────────────

  function generateMarkdown(title, messages, userLabel, assistantLabel) {
    const lines = [];
    let currentSpeaker = null;

    for (const msg of messages) {
      const label = msg.role === 'user' ? userLabel : assistantLabel;
      if (label !== currentSpeaker) {
        currentSpeaker = label;
        lines.push(`\n\n[${label}]`);
      }
      lines.push(msg.text);
    }

    return lines.join('\n').trim();
  }

  function generateJSON(title, messages, userLabel, assistantLabel) {
    const formatted = messages.map(msg => ({
      speaker: msg.role === 'user' ? userLabel : assistantLabel,
      role: msg.role,
      text: msg.text
    }));
    return JSON.stringify({
      title: title,
      exported: new Date().toISOString(),
      message_count: messages.length,
      messages: formatted
    }, null, 2);
  }

  // ── Filename Sanitization ────────────────────────────────────────────

  function sanitizeFilename(title) {
    return title
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 100)
      .toLowerCase();
  }

  // ── Export Button UI ─────────────────────────────────────────────────

  function createExportButton() {
    // Don't create if already exists
    if (document.getElementById('chatgpt-export-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'chatgpt-export-btn';
    btn.innerHTML = `
      <div id="chatgpt-export-menu" class="export-menu hidden">
        <button class="export-option" data-format="md" title="Export as Markdown">.md</button>
        <button class="export-option" data-format="json" title="Export as JSON">.json</button>
      </div>
      <button id="chatgpt-export-trigger" title="Export Conversation">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
      <div id="chatgpt-export-status" class="export-status hidden"></div>
    `;

    document.body.appendChild(btn);

    // Toggle menu on button click
    document.getElementById('chatgpt-export-trigger').addEventListener('click', () => {
      const menu = document.getElementById('chatgpt-export-menu');
      menu.classList.toggle('hidden');
    });

    // Format buttons
    document.querySelectorAll('.export-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.getElementById('chatgpt-export-menu').classList.add('hidden');
        handleExport(opt.dataset.format);
      });
    });
  }

  function setStatus(text, isError = false) {
    const statusEl = document.getElementById('chatgpt-export-status');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('hidden', 'error');
    if (isError) statusEl.classList.add('error');
    if (!text) statusEl.classList.add('hidden');
  }

  function hideStatus() {
    setTimeout(() => {
      const statusEl = document.getElementById('chatgpt-export-status');
      if (statusEl) statusEl.classList.add('hidden');
    }, 4000);
  }

  // ── Export Handler ───────────────────────────────────────────────────

  async function handleExport(format = 'md') {
    const conversationId = getConversationId();
    if (!conversationId) {
      setStatus('No conversation found in URL', true);
      hideStatus();
      return;
    }

    setStatus('Extracting...');

    try {
      // Fetch conversation data via background script
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_CONVERSATION',
        conversationId
      });

      if (response.error) {
        setStatus(`Error: ${response.error}`, true);
        hideStatus();
        return;
      }

      const data = response.data;
      const title = data.title || 'Untitled Conversation';
      const mapping = data.mapping;

      if (!mapping) {
        setStatus('No messages found in conversation', true);
        hideStatus();
        return;
      }

      // Walk the tree
      const messages = walkConversationTree(mapping);
      setStatus(`Extracting... ${messages.length} messages found`);

      if (messages.length === 0) {
        setStatus('No exportable messages found', true);
        hideStatus();
        return;
      }

      // Get labels from settings
      const { userLabel, assistantLabel } = await getLabels();

      // Generate output based on format
      let content, filename, mimeType;
      if (format === 'json') {
        content = generateJSON(title, messages, userLabel, assistantLabel);
        filename = `${sanitizeFilename(title)}.json`;
        mimeType = 'application/json';
      } else {
        content = generateMarkdown(title, messages, userLabel, assistantLabel);
        filename = `${sanitizeFilename(title)}.md`;
        mimeType = 'text/markdown';
      }

      // Download via background script (with save dialog)
      await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FILE',
        content: content,
        filename: filename,
        mimeType: mimeType
      });

      setStatus(`Exported ${messages.length} messages`);
      hideStatus();
    } catch (err) {
      console.error('[Exporter] Export failed:', err);
      setStatus(`Export failed: ${err.message}`, true);
      hideStatus();
    }
  }

  // ── Initialization ───────────────────────────────────────────────────

  // Wait for page to be ready, then inject button
  function init() {
    // Only activate on conversation pages
    if (window.location.hostname === 'chatgpt.com' || window.location.hostname === 'chat.openai.com') {
      createExportButton();

      // Re-check on navigation (ChatGPT is a SPA)
      const observer = new MutationObserver(() => {
        createExportButton();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
