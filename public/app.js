const chat = document.getElementById('chat');
const queryEl = document.getElementById('query');
const sendBtn = document.getElementById('send');
const ingestBtn = document.getElementById('ingest-btn');
const statusEl = document.getElementById('status');
const providerEl = document.getElementById('provider');

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
  const q = queryEl.value.trim();
  if (!q) return;

  // Push and display user message
  conversationHistory.push({ role: 'user', content: q });
  addMessage('user', q);
  queryEl.value = '';

  // Placeholder while we wait
  const spinnerText = 'Thinking...';
  addMessage('assistant', spinnerText);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, history: conversationHistory }),
    });
    const data = await res.json();
    // Remove spinner message
    chat.removeChild(chat.lastChild);
    if (data.ok && Array.isArray(data.chunks) && data.chunks.length) {
      const full = data.chunks.join('\n\n');
      addMessage('assistant', full);
      // Store assistant reply as a single message in history
      conversationHistory.push({ role: 'assistant', content: full });
    } else if (!data.ok) {
      addMessage('assistant', data.error || 'Error');
      conversationHistory.push({ role: 'assistant', content: data.error || 'Error' });
    } else {
      addMessage('assistant', '');
      conversationHistory.push({ role: 'assistant', content: '' });
    }
  } catch (e) {
    chat.removeChild(chat.lastChild);
    const errText = String(e);
    addMessage('assistant', errText);
    conversationHistory.push({ role: 'assistant', content: errText });
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
