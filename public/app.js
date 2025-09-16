const chat = document.getElementById('chat');
const queryEl = document.getElementById('query');
const sendBtn = document.getElementById('send');
const allowOutsideEl = document.getElementById('allow-outside');
const ingestBtn = document.getElementById('ingest-btn');
const statusEl = document.getElementById('status');
const ingestBar = document.getElementById('ingest-bar');
const providerEl = document.getElementById('provider');
const summaryEl = document.getElementById('summary');
const suggestionsEl = document.getElementById('suggestions');
const docListEl = document.getElementById('doc-list');
const lockBtn = document.getElementById('lock-selection');
const docSelectPanel = document.getElementById('doc-select-block');
const mainLayoutEl = document.getElementById('main-layout');
const historyListEl = document.getElementById('history-list');
const newChatBtn = document.getElementById('new-chat');
let isSending = false;
let selectionLocked = false;
let selectedDocPaths = [];
// Control Send button availability
function updateSendEnabled() {
  const canSend = selectionLocked && selectedDocPaths.length > 0 && !isSending;
  if (sendBtn) sendBtn.disabled = !canSend;
}
// Load default selection from server
(async function preloadSelection() {
  try {
    const res = await fetch('/api/session/documents');
    const data = await res.json();
    if (data.success && Array.isArray(data.data?.selectedDocuments)) {
      selectedDocPaths = data.data.selectedDocuments;
    }
  } catch {}
  updateSendEnabled();
})();
async function refreshSelectedSummary() {
  if (!summaryEl) return;
  try {
    summaryEl.textContent = 'Loading summary...';
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedDocs: selectedDocPaths }),
    });
    const data = await res.json();
    const text = data.ok ? (data.summary || 'No summary available.') : 'Unable to load summary.';
    if (window.marked && window.DOMPurify) {
      const html = marked.parse(text);
      summaryEl.innerHTML = DOMPurify.sanitize(html);
    } else {
      summaryEl.textContent = text;
    }
  } catch (e) {
    summaryEl.textContent = 'Unable to load summary.';
  }
}


// In-memory conversation history for multi-turn
// Each item: { role: 'user'|'assistant', content: string }
const conversationHistory = [];

// Multi-chat (local-only) storage
let currentChatId = null;
const LS_CHATS_KEY = 'birblm:chats';
const LS_BOOT_KEY = 'birblm:serverStart';

function generateId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadChats() {
  try {
    const raw = window.localStorage.getItem(LS_CHATS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // Backward-compat for older simple history arrays
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch { return []; }
}

function saveChats(list) {
  try { window.localStorage.setItem(LS_CHATS_KEY, JSON.stringify(list || [])); } catch {}
}

function upsertCurrentChat() {
  // Create a snapshot of the current session into chats array
  const list = loadChats();
  if (!currentChatId) currentChatId = generateId();
  const firstUser = conversationHistory.find((m) => m.role === 'user');
  const title = (firstUser?.content || '').slice(0, 60) || '(untitled)';
  const now = new Date().toISOString();
  const idx = list.findIndex((c) => c.id === currentChatId);
  const entry = {
    id: currentChatId,
    title,
    updatedAt: now,
    selectedDocs: [...selectedDocPaths],
    locked: selectionLocked,
    messages: [...conversationHistory],
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveChats(list);
}

function renderHistory() {
  if (!historyListEl) return;
  const list = loadChats();
  historyListEl.innerHTML = '';
  if (!list.length) { historyListEl.textContent = 'No history yet.'; return; }
  // Sort by updatedAt desc
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  for (const h of list) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const left = document.createElement('div'); left.className = 'title'; left.textContent = h.title || '(untitled)';
    const right = document.createElement('div'); right.className = 'muted';
    try { right.textContent = new Date(h.updatedAt).toLocaleString(); } catch { right.textContent = ''; }
    item.appendChild(left); item.appendChild(right);
    item.addEventListener('click', () => loadChatById(h.id));
    historyListEl.appendChild(item);
  }
}

function renderConversationFromMessages(messages) {
  chat.innerHTML = '';
  for (const m of messages || []) addMessage(m.role, m.content);
}

function applySelectionToUI() {
  if (!docListEl) return;
  docListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectedDocPaths.includes(cb.value);
  });
}

function loadChatById(chatId) {
  const list = loadChats();
  const found = list.find((c) => c.id === chatId);
  if (!found) return;
  // Replace current session state
  currentChatId = found.id;
  selectionLocked = !!found.locked;
  selectedDocPaths = Array.isArray(found.selectedDocs) ? [...found.selectedDocs] : [];
  // replace conversationHistory contents in-place
  conversationHistory.length = 0;
  for (const m of found.messages || []) conversationHistory.push({ role: m.role, content: m.content });

  // Render conversation
  renderConversationFromMessages(conversationHistory);

  // Apply selection UI
  if (selectionLocked) {
    if (docSelectPanel) docSelectPanel.style.display = 'none';
    if (mainLayoutEl) mainLayoutEl.classList.add('no-docs');
  } else {
    if (docSelectPanel) docSelectPanel.style.display = '';
    if (mainLayoutEl) mainLayoutEl.classList.remove('no-docs');
  }
  applySelectionToUI();
  refreshSelectedSummary();
  fetchSuggestions();
  updateSendEnabled();
}
if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    // Start fresh: clear conversation and selection lock, keep selections optional
    currentChatId = null;
    conversationHistory.length = 0;
    chat.innerHTML = '';
    // Show document selection again
    selectionLocked = false;
    if (docSelectPanel) docSelectPanel.style.display = '';
    if (mainLayoutEl) mainLayoutEl.classList.remove('no-docs');
    // Keep previous selections or clear them: here we keep them to speed up flow
    applySelectionToUI();
    refreshSelectedSummary();
    fetchSuggestions();
    updateSendEnabled();
  });
}

// Cache server start time to invalidate client history on server restart
// Sync server boot marker and clear stale client chat state on restart
(async function syncBootMarkerAndHistory() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const startedAt = data?.startedAt;
    if (startedAt) {
      const prev = window.localStorage.getItem(LS_BOOT_KEY);
      if (prev && prev !== startedAt) {
        // Server restarted → clear client-side chat caches
        try { window.localStorage.removeItem(LS_CHATS_KEY); } catch {}
        try { window.localStorage.removeItem('birblm:history'); } catch {}
      }
      window.localStorage.setItem(LS_BOOT_KEY, startedAt);
    }
  } catch {}
  // After potential clear, render current history
  renderHistory();
})();

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant' && window.marked && window.DOMPurify) {
    const html = marked.parse(content || '');
    div.innerHTML = DOMPurify.sanitize(html);
  } else {
    div.textContent = content;
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function ingest() {
  ingestBtn.disabled = true;
  statusEl.textContent = 'Starting...';
  if (ingestBar) ingestBar.style.width = '0%';
  try {
    const start = await fetch('/api/ingest/start', { method: 'POST' });
    const started = await start.json();
    if (!started.success) throw new Error(started.error || 'Failed to start');
    statusEl.textContent = 'Scanning...';
    const poll = async () => {
      const resp = await fetch('/api/ingest/status');
      const json = await resp.json();
      const st = json.data || {};
      const label = st.stage === 'embedding' ? 'Embedding' : st.stage === 'chunking' ? 'Chunking' : (st.stage || 'Working');
      if (st.stage === 'error') {
        statusEl.textContent = st.error || 'Error';
        ingestBtn.disabled = false;
        return;
      }
      if (st.stage === 'done') {
        statusEl.textContent = `Indexed ${st.processed} chunks.`;
        if (ingestBar) ingestBar.style.width = '100%';
        ingestBtn.disabled = false;
        return;
      }
      if (st.total > 0 && ingestBar) {
        const pct = Math.max(0, Math.min(100, Math.round((st.processed / st.total) * 100)));
        ingestBar.style.width = pct + '%';
      }
      statusEl.textContent = `${label}... ${st.processed || 0}/${st.total || 0}`;
      setTimeout(poll, 800);
    };
    setTimeout(poll, 600);
  } catch (e) {
    statusEl.textContent = String(e);
  } finally {
    // keep disabled state managed by poller end conditions
  }
}

async function send() {
  if (isSending) return;
  // Require explicit selection lock and at least one selected doc
  if (!selectionLocked || selectedDocPaths.length === 0) {
    updateSendEnabled();
    return;
  }
  const q = queryEl.value.trim();
  if (!q) return;

  // Push and display user message
  conversationHistory.push({ role: 'user', content: q });
  addMessage('user', q);
  queryEl.value = '';

  // Lock UI
  isSending = true;
  updateSendEnabled();

  // Streaming via SSE
  let holder = document.createElement('div');
  holder.className = 'msg assistant';
  holder.textContent = 'Thinking...';
  chat.appendChild(holder);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, history: conversationHistory, selectedDocs: selectedDocPaths, allowOutsideKnowledge: !!(allowOutsideEl && allowOutsideEl.checked) }),
    });
    if (!res.ok || !res.body) throw new Error('Streaming not available');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let acc = '';
    holder.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let event = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event:')) {
          event = trimmed.slice(6).trim();
          continue;
        }
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          try {
            const evt = JSON.parse(dataStr);
            if (event === 'delta' && evt.text) {
              acc += evt.text;
              if (window.marked && window.DOMPurify) {
                const html = marked.parse(acc);
                holder.innerHTML = DOMPurify.sanitize(html);
              } else {
                holder.textContent = acc;
              }
              chat.scrollTop = chat.scrollHeight;
            } else if (event === 'flush') {
              // finalize current message node and start a new one
              conversationHistory.push({ role: 'assistant', content: acc });
              acc = '';
              const newHolder = document.createElement('div');
              newHolder.className = 'msg assistant';
              newHolder.textContent = '';
              chat.appendChild(newHolder);
              // switch reference to new holder
              holder = newHolder;
            } else if (event === 'done') {
              // Store assistant reply in history if non-empty
              if (acc && acc.trim().length) {
                conversationHistory.push({ role: 'assistant', content: acc });
              }
              // Upsert to multi-chat storage
              try { upsertCurrentChat(); renderHistory(); } catch {}
              // Refresh suggestions after each assistant reply
              fetchSuggestions();
            } else if (event === 'error') {
              const message = evt.error || 'Error';
              holder.textContent = message;
              conversationHistory.push({ role: 'assistant', content: message });
            }
          } catch {
            // ignore JSON parse errors
          }
        }
      }
    }
  } catch (e) {
    holder.textContent = String(e);
    conversationHistory.push({ role: 'assistant', content: String(e) });
  } finally {
    isSending = false;
    updateSendEnabled();
  }
}

ingestBtn.addEventListener('click', ingest);
sendBtn.addEventListener('click', send);
queryEl.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

async function refreshProvider() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'status error');
    if (!data.provider) {
      providerEl.textContent = 'Provider: not configured';
    } else if (data.provider === 'openai-compatible') {
      const base = data.baseUrl || '';
      providerEl.textContent = `Provider: Local/OpenAI-compatible (${base}) • Model: ${data.model}`;
    } else if (data.provider === 'groq') {
      providerEl.textContent = `Provider: Groq • Model: ${data.model}`;
    }
  } catch (e) {
    providerEl.textContent = '';
  }
}

refreshProvider();

// Fetch document summary asynchronously on load
(async function fetchSummary() {
  if (!summaryEl) return;
  try {
    const res = await fetch('/api/summary');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'summary error');
    const text = data.summary || 'No summary available.';
    if (window.marked && window.DOMPurify) {
      const html = marked.parse(text);
      summaryEl.innerHTML = DOMPurify.sanitize(html);
    } else {
      summaryEl.textContent = text;
    }
  } catch (e) {
    summaryEl.textContent = 'Unable to load summary.';
  }
})();

// Fetch suggested starter questions asynchronously
async function fetchSuggestions() {
  if (!suggestionsEl) return;
  try {
    const res = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: conversationHistory, selectedDocs: selectedDocPaths }),
    });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.questions)) throw new Error('suggestions error');
    suggestionsEl.innerHTML = '';
    for (const q of data.questions.slice(0, 3)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = q;
      btn.style.whiteSpace = 'nowrap';
      btn.style.overflow = 'hidden';
      btn.style.textOverflow = 'ellipsis';
      btn.addEventListener('click', () => {
        queryEl.value = q;
        queryEl.focus();
      });
      suggestionsEl.appendChild(btn);
    }
  } catch (e) {
    // silent fail for suggestions
  }
}

// initial load
fetchSuggestions();

// Document selection logic
(async function initDocs() {
  if (!docListEl) return;
  try {
    const res = await fetch('/api/docs');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.docs)) throw new Error('docs error');
    docListEl.innerHTML = '';
    data.docs.forEach((doc) => {
      const row = document.createElement('label');
      row.className = 'doc-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = doc.path;
      cb.checked = selectedDocPaths.includes(doc.path);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!selectedDocPaths.includes(doc.path)) selectedDocPaths.push(doc.path);
        } else {
          selectedDocPaths = selectedDocPaths.filter((p) => p !== doc.path);
        }
        updateSendEnabled();
      });
      const name = document.createElement('span');
      name.textContent = doc.name;
      row.appendChild(cb);
      row.appendChild(name);
      docListEl.appendChild(row);
    });
    // Add Select All / Clear
    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    controls.style.marginTop = '8px';
    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.textContent = 'Select All';
    selectAll.addEventListener('click', () => {
      selectedDocPaths = data.docs.map(d => d.path);
      docListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
      updateSendEnabled();
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      selectedDocPaths = [];
      docListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      updateSendEnabled();
    });
    controls.appendChild(selectAll);
    controls.appendChild(clear);
    docListEl.appendChild(controls);
  } catch (e) {
    docListEl.textContent = 'Unable to load docs.';
  }
})();

if (lockBtn) {
  lockBtn.addEventListener('click', () => {
    // Toggle behavior: if locked, unlock; if unlocked, lock only with selection
    if (selectionLocked) {
      // Unlock: show selection UI and allow changes; keep selection as-is
      selectionLocked = false;
      if (docSelectPanel) docSelectPanel.style.display = '';
      if (mainLayoutEl) mainLayoutEl.classList.remove('no-docs');
      // Optionally clear selection here if desired (kept intact by default)
    } else {
      // Lock only when at least one document is selected
      if (selectedDocPaths.length > 0) {
        selectionLocked = true;
        if (docSelectPanel) docSelectPanel.style.display = 'none';
        if (mainLayoutEl) mainLayoutEl.classList.add('no-docs');
        refreshSelectedSummary();
        fetchSuggestions();
        fetch('/api/session/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selectedDocuments: selectedDocPaths })
        });
      } else {
        // No selection → remain unlocked and keep panel visible
        selectionLocked = false;
        if (docSelectPanel) docSelectPanel.style.display = '';
        if (mainLayoutEl) mainLayoutEl.classList.remove('no-docs');
      }
    }
    updateSendEnabled();
  });
}
