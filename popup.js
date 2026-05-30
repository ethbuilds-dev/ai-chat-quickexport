// popup.js — Multi-platform AI Conversation Exporter

// Load saved labels
chrome.storage.sync.get(
  { userLabel: '', assistantLabel: '' },
  (settings) => {
    document.getElementById('userLabel').value = settings.userLabel;
    document.getElementById('assistantLabel').value = settings.assistantLabel;
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

    // Descriptive filename: Platform_UserLabel_AssistantLabel_Date_ConversationID.format
    const filename = `${detected.name}_${sanitize(labels.userLabel)}_${sanitize(labels.assistantLabel)}_${new Date().toISOString().slice(0, 10)}_${detected.conversationId.slice(0, 8)}.${format}`;

    // Download strategy:
    //  • chrome.downloads.download() gives a real Save As dialog (choose name +
    //    location) AND honours `filename` — but only for data: URLs. For blob:
    //    URLs Chrome ignores `filename` and uses the blob UUID, so we can't use
    //    a blob: URL here.
    //  • A data: URL holds the whole file in the URL string, which is fine for
    //    normal conversations but blew up memory on huge exports (the 200k-word
    //    crash v1.4.0 fixed). So above a size threshold we fall back to an anchor
    //    download: the `download` attribute sets the filename reliably and the
    //    blob streams without copying — the cost is no Save As dialog.
    const blob = new Blob([content], { type: mimeType });
    const DATA_URL_LIMIT = 2 * 1024 * 1024; // ~2 MB of content

    if (blob.size <= DATA_URL_LIMIT) {
      // Small/typical export: Save As dialog with the correct filename.
      const dataUrl = await blobToDataURL(blob);
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
    } else {
      // Large export: anchor download keeps memory flat. Saves to the default
      // Downloads folder with the correct filename (no Save As prompt).
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

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

// Read a Blob as a data: URL via FileReader — native and single-copy, unlike the
// old btoa(unescape(encodeURIComponent(...))) chain that allocated the string
// several times over.
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read export data'));
    reader.readAsDataURL(blob);
  });
}

// Event listeners
document.getElementById('exportMd').addEventListener('click', () => doExport('md'));
document.getElementById('exportJson').addEventListener('click', () => doExport('json'));
