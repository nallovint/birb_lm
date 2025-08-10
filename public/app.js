const chat = document.getElementById('chat');
const queryEl = document.getElementById('query');
const sendBtn = document.getElementById('send');
const ingestBtn = document.getElementById('ingest-btn');
const statusEl = document.getElementById('status');
const ingestBar = document.getElementById('ingest-bar');
const providerEl = document.getElementById('provider');
const summaryEl = document.getElementById('summary');
const suggestionsEl = document.getElementById('suggestions');
const docListEl = document.getElementById('doc-list');
const lockBtn = document.getElementById('lock-selection');
const docSelectPanel = document.getElementById('doc-select');
const mainLayoutEl = document.getElementById('main-layout');
let isSending = false;
let selectionLocked = false;
let selectedDocPaths = [];
// Load default selection from server
(async function preloadSelection() {
  try {
    const res = await fetch('/api/session/documents');
    const data = await res.json();
    if (data.success && Array.isArray(data.data?.selectedDocuments)) {
      selectedDocPaths = data.data.selectedDocuments;
    }
  } catch {}
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
  const q = queryEl.value.trim();
  if (!q) return;

  // On first send, lock the selection panel and hide it
  if (!selectionLocked) {
    selectionLocked = true;
    if (docSelectPanel) docSelectPanel.style.display = 'none';
    if (mainLayoutEl) mainLayoutEl.classList.add('no-docs');
    // Refresh summary and suggestions immediately based on locked selection
    refreshSelectedSummary();
    fetchSuggestions();
  }

  // Push and display user message
  conversationHistory.push({ role: 'user', content: q });
  addMessage('user', q);
  queryEl.value = '';

  // Lock UI
  isSending = true;
  sendBtn.disabled = true;

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
      body: JSON.stringify({ query: q, history: conversationHistory, selectedDocs: selectedDocPaths }),
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
    sendBtn.disabled = false;
  }
}

ingestBtn.addEventListener('click', ingest);
sendBtn.addEventListener('click', send);
queryEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
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
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      selectedDocPaths = [];
      docListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
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
    if (!selectionLocked) {
      selectionLocked = true;
      if (docSelectPanel) docSelectPanel.style.display = 'none';
      if (mainLayoutEl) mainLayoutEl.classList.add('no-docs');
      refreshSelectedSummary();
      fetchSuggestions();
      // Persist defaults
      fetch('/api/session/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedDocuments: selectedDocPaths }) });
    }
  });
}
