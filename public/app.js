const chat = document.getElementById('chat');
const queryEl = document.getElementById('query');
const sendBtn = document.getElementById('send');
const ingestBtn = document.getElementById('ingest-btn');
const statusEl = document.getElementById('status');
const providerEl = document.getElementById('provider');
const summaryEl = document.getElementById('summary');
const suggestionsEl = document.getElementById('suggestions');
let isSending = false;

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
  statusEl.textContent = 'Indexing...';
  try {
    const res = await fetch('/api/ingest', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Ingest failed');
    statusEl.textContent = `Indexed ${data.chunks} chunks.`;
  } catch (e) {
    statusEl.textContent = String(e);
  } finally {
    ingestBtn.disabled = false;
  }
}

async function send() {
  if (isSending) return;
  const q = queryEl.value.trim();
  if (!q) return;

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
      body: JSON.stringify({ query: q, history: conversationHistory }),
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
      body: JSON.stringify({ history: conversationHistory }),
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
