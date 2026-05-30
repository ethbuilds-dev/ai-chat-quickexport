// popup.js — Multi-platform AI Conversation Exporter

// Load saved labels
chrome.storage.sync.get(
  { userLabel: '', assistantLabel: '' },
  (settings) => {
    document.getElementById('userLabel').value = settings.userLabel;
    document.getElementById('assistantLabel').value = settings.assistantLabel;
    updateFilenamePreview();
  }
);

function setStatus(text, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = type;
}

function saveLabels() {
  const userLabel = document.getElementById('userLabel').value.trim() || 'USER';
  const assistantLabel = document.getElementById('assistantLabel').value.trim() || 'ASSISTANT';
  chrome.storage.sync.set({ userLabel, assistantLabel });
  return { userLabel, assistantLabel };
}

// Detect platform and conversation ID from URL
function detectPlatform(url) {
  if (!url) return null;

  // ChatGPT
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) return { platform: 'chatgpt', conversationId: match[1], name: 'ChatGPT' };
  }

  // Claude
  if (url.includes('claude.ai')) {
    const match = url.match(/\/chat\/([a-f0-9-]+)/);
    if (match) return { platform: 'claude', conversationId: match[1], name: 'Claude' };
  }

  // Gemini
  if (url.includes('gemini.google.com')) {
    const match = url.match(/\/app\/([a-f0-9]+)/);
    if (match) return { platform: 'gemini', conversationId: match[1], name: 'Gemini' };
  }

  // Grok
  if (url.includes('grok.com')) {
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) return { platform: 'grok', conversationId: match[1], name: 'Grok' };
  }

  return null;
}

// Build the base filename (no extension): Platform_UserLabel_AssistantLabel_Date_ConversationID
function buildBaseFilename(detected, userLabel, assistantLabel) {
  return `${detected.name}_${sanitize(userLabel)}_${sanitize(assistantLabel)}_${new Date().toISOString().slice(0, 10)}_${detected.conversationId.slice(0, 8)}`;
}

// Refresh the filename preview from the active tab + current label inputs. Runs
// on popup open and whenever a label changes. Leaves the field empty when the
// active tab isn't a supported conversation.
async function updateFilenamePreview() {
  const field = document.getElementById('exportFilename');
  if (!field) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const detected = detectPlatform(tab?.url);
    if (!detected || !detected.conversationId) {
      field.value = '';
      return;
    }
    const userLabel = document.getElementById('userLabel').value.trim() || 'USER';
    const assistantLabel = document.getElementById('assistantLabel').value.trim() || 'ASSISTANT';
    field.value = buildBaseFilename(detected, userLabel, assistantLabel);
  } catch (err) {
    field.value = '';
  }
}

async function doExport(format) {
  const labels = saveLabels();
  setStatus('Detecting platform...', 'info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const detected = detectPlatform(tab?.url);

    if (!detected) {
      setStatus('Open a supported AI conversation (ChatGPT, Claude, Gemini, Grok)', 'error');
      return;
    }

    if (!detected.conversationId) {
      setStatus(detected.name + ' — not yet supported', 'error');
      return;
    }

    setStatus(`Extracting from ${detected.name}...`, 'info');

    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_FETCH',
      conversationId: detected.conversationId,
      tabId: tab.id,
      platform: detected.platform
    });

    if (response.error) {
      setStatus('Error: ' + response.error, 'error');
      return;
    }

    const data = response.data;
    const title = data.title || 'Untitled';
    const messages = data.messages || [];

    if (messages.length === 0) {
      setStatus('No exportable messages found', 'error');
      return;
    }

    setStatus(`${messages.length} messages, preparing ${format}...`, 'info');

    let content, mimeType;

    if (format === 'json') {
      content = generateJSON(title, messages, labels.userLabel, labels.assistantLabel);
      mimeType = 'application/json';
    } else {
      content = generateMD(title, messages, labels.userLabel, labels.assistantLabel);
      mimeType = 'text/markdown';
    }

    // Use whatever is in the filename field (the user may have edited it),
    // falling back to the auto-generated base, then append the format extension.
    const base = document.getElementById('exportFilename').value.trim() ||
      buildBaseFilename(detected, labels.userLabel, labels.assistantLabel);
    const filename = sanitize(base) + '.' + format;

    // Anchor download: the `download` attribute sets the filename reliably and
    // the blob streams without copying. Saves to the browser's default Downloads
    // folder (no Save As dialog).
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    // Word count
    const counts = countWords(messages);
    setStatus(`Exported ${messages.length} messages from ${detected.name}`, 'success');
    showWordCount(counts);

  } catch (err) {
    setStatus('Failed: ' + err.message, 'error');
  }
}

// Generators
function generateMD(title, messages, userLabel, assistantLabel) {
  const counts = countWords(messages);
  const lines = [];
  lines.push(`# ${title}`);
  lines.push(`\n> Word count — ${userLabel}: ${counts.userWords.toLocaleString()} · ${assistantLabel}: ${counts.assistantWords.toLocaleString()} · Total: ${counts.total.toLocaleString()}`);
  let current = null;

  for (const msg of messages) {
    const label = msg.role === 'user' ? userLabel : assistantLabel;
    if (label !== current) {
      current = label;
      lines.push(`\n\n[${label}]`);
    }
    lines.push(msg.text);
  }

  return lines.join('\n').trim();
}

function generateJSON(title, messages, userLabel, assistantLabel) {
  const counts = countWords(messages);
  return JSON.stringify({
    title,
    exported: new Date().toISOString(),
    message_count: messages.length,
    word_count: {
      user: counts.userWords,
      assistant: counts.assistantWords,
      total: counts.total
    },
    messages: messages.map(m => ({
      speaker: m.role === 'user' ? userLabel : assistantLabel,
      role: m.role,
      text: m.text
    }))
  }, null, 2);
}

function countWords(messages) {
  let userWords = 0;
  let assistantWords = 0;
  for (const msg of messages) {
    const wc = msg.text ? msg.text.trim().split(/\s+/).filter(w => w.length > 0).length : 0;
    if (msg.role === 'user') userWords += wc;
    else assistantWords += wc;
  }
  return { userWords, assistantWords, total: userWords + assistantWords };
}

function showWordCount(counts) {
  const el = document.getElementById('wordcount');
  if (el) {
    el.style.display = 'block';
    el.innerHTML =
      `<span class="wc-label">User:</span> <span class="wc-num">${counts.userWords.toLocaleString()}</span> · ` +
      `<span class="wc-label">Assistant:</span> <span class="wc-num">${counts.assistantWords.toLocaleString()}</span> · ` +
      `<span class="wc-label">Total:</span> <span class="wc-num">${counts.total.toLocaleString()}</span>`;
  }
}

function sanitize(title) {
  return title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').substring(0, 100);
}

// Event listeners
document.getElementById('exportMd').addEventListener('click', () => doExport('md'));
document.getElementById('exportJson').addEventListener('click', () => doExport('json'));

// Keep the filename preview in sync with the labels as they're typed.
document.getElementById('userLabel').addEventListener('input', updateFilenamePreview);
document.getElementById('assistantLabel').addEventListener('input', updateFilenamePreview);
