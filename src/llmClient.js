import 'dotenv/config';
import { setGlobalDispatcher, Agent } from 'undici';

// Configure generous HTTP timeouts to accommodate first-time model pulls/loads
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 300000); // 5 min
const BODY_TIMEOUT_MS =
  process.env.BODY_TIMEOUT_MS === '0'
    ? 0
    : Number(process.env.BODY_TIMEOUT_MS || 0); // 0 = no body timeout
setGlobalDispatcher(new Agent({ headersTimeout: HEADERS_TIMEOUT_MS, bodyTimeout: BODY_TIMEOUT_MS }));

// Auto-detection and configuration for LLM provider
// Priority:
// 1) Explicit LLM_BASE_URL (OpenAI-compatible: Ollama/LM Studio/vLLM)
// 2) Detect common local endpoints (docker service `ollama`, host.docker.internal)
// 3) Groq via GROQ_API_KEY

const PROVIDER_DEFAULTS = {
  openaiCompatibleModel: process.env.LLM_MODEL || 'llama3.1:8b',
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
};

let resolvedProvider; // { type: 'openai-compatible' | 'groq', baseUrl?: string }

async function tryFetchJson(url, { timeoutMs = 800 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProviderOnce() {
  if (resolvedProvider) return resolvedProvider;

  // 0) Explicit mode override
  const forcedMode = (process.env.LLM_MODE || '').toLowerCase();
  if (forcedMode === 'groq') {
    resolvedProvider = { type: 'groq' };
    return resolvedProvider;
  }
  if (forcedMode === 'ollama' || forcedMode === 'openai' || forcedMode === 'openai-compatible') {
    const base = process.env.LLM_BASE_URL || 'http://ollama:11434';
    resolvedProvider = { type: 'openai-compatible', baseUrl: base };
    return resolvedProvider;
  }

  // 1) Explicit base URL
  if (process.env.LLM_BASE_URL) {
    resolvedProvider = { type: 'openai-compatible', baseUrl: process.env.LLM_BASE_URL };
    return resolvedProvider;
  }

  // 2) Try common local endpoints
  const candidates = [
    'http://ollama:11434', // docker compose service
    'http://host.docker.internal:11434', // macOS/Windows host
  ];
  for (const base of candidates) {
    const ok = await tryFetchJson(`${base}/v1/models`).catch(() => null);
    if (ok) {
      resolvedProvider = { type: 'openai-compatible', baseUrl: base };
      return resolvedProvider;
    }
  }

  // 3) Fall back to Groq if API key present
  if (process.env.GROQ_API_KEY) {
    resolvedProvider = { type: 'groq' };
    return resolvedProvider;
  }

  // Nothing detected; provide a clear error at first use
  resolvedProvider = null;
  return null;
}

async function ensureProvider() {
  const provider = await resolveProviderOnce();
  if (provider) return provider;
  throw new Error(
    'No LLM provider configured. Set LLM_BASE_URL for a local OpenAI-compatible server (e.g., Ollama), or set GROQ_API_KEY for Groq.'
  );
}

async function chatComplete(
  messages,
  { model, temperature = 0.2, max_tokens = 800 } = {}
) {
  const provider = await ensureProvider();

  if (provider.type === 'openai-compatible') {
    const baseUrl = provider.baseUrl;
    const finalModel = model || PROVIDER_DEFAULTS.openaiCompatibleModel;
    const apiKey =
      process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || 'ollama';
    const url = new URL('/v1/chat/completions', baseUrl).toString();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: finalModel,
        messages,
        temperature,
        max_tokens,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM request failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  // Groq provider
  const finalModel = model || PROVIDER_DEFAULTS.groqModel;
  const { default: Groq } = await import('groq-sdk');
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set and no local OpenAI-compatible server was detected.');
  }
  const client = new Groq({ apiKey });
  const res = await client.chat.completions.create({
    model: finalModel,
    messages,
    temperature,
    max_tokens,
  });
  return res.choices?.[0]?.message?.content ?? '';
}

const DEFAULT_MODEL =
  process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

export { chatComplete, DEFAULT_MODEL };

// Expose detected provider info for UI/status endpoints
export async function getProviderInfo() {
  const provider = await resolveProviderOnce();
  if (!provider) {
    return {
      provider: null,
      baseUrl: null,
      model:
        process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    };
  }
  if (provider.type === 'openai-compatible') {
    return {
      provider: 'openai-compatible',
      baseUrl: provider.baseUrl,
      model: process.env.LLM_MODEL || PROVIDER_DEFAULTS.openaiCompatibleModel,
    };
  }
  return {
    provider: 'groq',
    baseUrl: null,
    model: process.env.GROQ_MODEL || PROVIDER_DEFAULTS.groqModel,
  };
}

// Streaming chat completion. Yields incremental text via onDelta callback.
// onDelta(signature) receives: { type: 'delta', text } | { type: 'done' } | { type: 'error', error }
export async function chatCompleteStream(
  messages,
  { model, temperature = 0.2, max_tokens = 800 } = {},
  onDelta
) {
  const provider = await ensureProvider();

  if (provider.type === 'openai-compatible') {
    const baseUrl = provider.baseUrl;
    const finalModel = model || PROVIDER_DEFAULTS.openaiCompatibleModel;
    const apiKey =
      process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || 'ollama';
    const url = new URL('/v1/chat/completions', baseUrl).toString();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: finalModel,
        messages,
        temperature,
        max_tokens,
        stream: true,
      }),
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
          if (dataStr === '[DONE]') {
            onDelta?.({ type: 'done' });
            return;
          }
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content ?? '';
            if (delta) onDelta?.({ type: 'delta', text: delta });
          } catch {
            // ignore parse errors
          }
        }
      }
    }
    onDelta?.({ type: 'done' });
    return;
  }

  // Groq streaming (best-effort; falls back to non-stream if unsupported)
  try {
    const finalModel = model || PROVIDER_DEFAULTS.groqModel;
    const { default: Groq } = await import('groq-sdk');
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('Missing GROQ_API_KEY');
    const client = new Groq({ apiKey });
    const stream = await client.chat.completions.create({
      model: finalModel,
      messages,
      temperature,
      max_tokens,
      stream: true,
    });
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta?.({ type: 'delta', text: delta });
    }
    onDelta?.({ type: 'done' });
  } catch (e) {
    // Fallback to non-stream
    try {
      const text = await chatComplete(messages, { model, temperature, max_tokens });
      if (text) onDelta?.({ type: 'delta', text });
      onDelta?.({ type: 'done' });
    } catch (err) {
      onDelta?.({ type: 'error', error: String(err) });
    }
  }
}

