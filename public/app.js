const chat = document.getElementById('chat');
const queryEl = document.getElementById('query');
const sendBtn = document.getElementById('send');
const ingestBtn = document.getElementById('ingest-btn');
const statusEl = document.getElementById('status');
const providerEl = document.getElementById('provider');

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
  addMessage('user', q);
  queryEl.value = '';

  addMessage('assistant', 'Thinking...');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    // Remove spinner message
    chat.removeChild(chat.lastChild);
    if (data.ok && Array.isArray(data.chunks) && data.chunks.length) {
      for (const chunk of data.chunks) addMessage('assistant', chunk);
    } else if (!data.ok) {
      addMessage('assistant', data.error || 'Error');
    } else {
      addMessage('assistant', '');
    }
  } catch (e) {
    chat.removeChild(chat.lastChild);
    addMessage('assistant', String(e));
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
