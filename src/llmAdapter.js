import { loadSettings, getSettingsVersion } from './settings.js';

let cachedProvider = null; // { type: 'openai-compatible'|'groq', baseUrl?:string, model:string, apiKey?:string }
let cachedVersion = -1;

async function resolveProvider() {
  const version = getSettingsVersion();
  if (cachedProvider && version === cachedVersion) return cachedProvider;
  const s = await loadSettings();
  if (s.aiProvider === 'groq') {
    cachedProvider = {
      type: 'groq',
      model: s.groq?.model || 'llama-3.1-8b-instant',
      apiKey: s.groq?.apiKey || process.env.GROQ_API_KEY || '',
    };
  } else {
    cachedProvider = {
      type: 'openai-compatible',
      baseUrl: s.ollama?.url || process.env.LLM_BASE_URL || 'http://ollama:11434',
      model: s.ollama?.model || process.env.LLM_MODEL || 'llama3.1:8b',
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || 'ollama',
    };
  }
  cachedVersion = version;
  return cachedProvider;
}

export async function llmChatComplete(messages, { temperature = 0.2, max_tokens = 800 } = {}) {
  const p = await resolveProvider();
  if (p.type === 'openai-compatible') {
    const url = new URL('/v1/chat/completions', p.baseUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({ model: p.model, messages, temperature, max_tokens }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM request failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
  // Groq
  const { default: Groq } = await import('groq-sdk');
  if (!p.apiKey) throw new Error('Missing GROQ_API_KEY in settings');
  const client = new Groq({ apiKey: p.apiKey });
  const res = await client.chat.completions.create({ model: p.model, messages, temperature, max_tokens });
  return res.choices?.[0]?.message?.content ?? '';
}

export async function llmChatCompleteStream(messages, { temperature = 0.2, max_tokens = 800 } = {}, onDelta) {
  const p = await resolveProvider();
  if (p.type === 'openai-compatible') {
    const url = new URL('/v1/chat/completions', p.baseUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({ model: p.model, messages, temperature, max_tokens, stream: true }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM request failed: ${res.status} ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffered = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') { onDelta?.({ type: 'done' }); return; }
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content ?? '';
            if (delta) onDelta?.({ type: 'delta', text: delta });
          } catch {}
        }
      }
    }
    onDelta?.({ type: 'done' });
    return;
  }
  // Groq streaming (fallback to non-stream on error)
  try {
    const { default: Groq } = await import('groq-sdk');
    if (!p.apiKey) throw new Error('Missing GROQ_API_KEY in settings');
    const client = new Groq({ apiKey: p.apiKey });
    const stream = await client.chat.completions.create({ model: p.model, messages, temperature, max_tokens, stream: true });
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta?.({ type: 'delta', text: delta });
    }
    onDelta?.({ type: 'done' });
  } catch (e) {
    try {
      const text = await llmChatComplete(messages, { temperature, max_tokens });
      if (text) onDelta?.({ type: 'delta', text });
      onDelta?.({ type: 'done' });
    } catch (err) {
      onDelta?.({ type: 'error', error: String(err) });
    }
  }
}

export async function getRuntimeProviderInfo() {
  const p = await resolveProvider();
  if (p.type === 'openai-compatible') return { provider: 'openai-compatible', baseUrl: p.baseUrl, model: p.model };
  return { provider: 'groq', baseUrl: null, model: p.model };
}


