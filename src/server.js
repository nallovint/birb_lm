import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatComplete, DEFAULT_MODEL, getProviderInfo, chatCompleteStream } from './llmClient.js';
import { searchIndex, buildAndSaveIndex } from './retriever.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Static UI
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

app.post('/api/ingest', async (req, res) => {
  try {
    const dir = process.env.DOCS_DIR || 'docs';
    const idx = await buildAndSaveIndex(dir);
    res.json({ ok: true, chunks: idx.items.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Provider status for UI
app.get('/api/status', async (req, res) => {
  try {
    const info = await getProviderInfo();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function chunkMarkdown(text, maxLen = 1200) {
  if (!text) return [];

  // Helper: split into sections by markdown headings, preserving headings
  function splitByHeadings(md) {
    const lines = md.split(/\n/);
    const sections = [];
    let current = [];
    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line)) {
        if (current.length) sections.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length) sections.push(current.join('\n'));
    return sections.length ? sections : [md];
  }

  // Helper: split a long block by paragraphs, then sentences, avoiding mid-word cuts
  function splitBlock(block) {
    const result = [];
    const paragraphs = block.split(/\n{2,}/);
    let buffer = '';

    const flushBuffer = () => {
      if (buffer) {
        result.push(buffer);
        buffer = '';
      }
    };

    for (const para of paragraphs) {
      const candidate = buffer ? `${buffer}\n\n${para}` : para;
      if (candidate.length <= maxLen) {
        buffer = candidate;
        continue;
      }

      // Paragraph too large for buffer: flush and split paragraph by sentences
      flushBuffer();
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentenceBuf = '';
      for (const s of sentences) {
        const next = sentenceBuf ? `${sentenceBuf} ${s}` : s;
        if (next.length <= maxLen) {
          sentenceBuf = next;
        } else {
          if (sentenceBuf) result.push(sentenceBuf);
          if (s.length <= maxLen) {
            sentenceBuf = s;
          } else {
            // Fallback: split long sentence at whitespace boundaries
            let remaining = s;
            while (remaining.length > maxLen) {
              const slice = remaining.slice(0, maxLen + 1);
              const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
              const end = cut > 0 ? cut : maxLen;
              result.push(remaining.slice(0, end));
              remaining = remaining.slice(end).trimStart();
            }
            sentenceBuf = remaining;
          }
        }
      }
      if (sentenceBuf) result.push(sentenceBuf);
    }

    if (buffer) result.push(buffer);
    return result;
  }

  const sections = splitByHeadings(text);
  const chunks = [];
  for (const section of sections) {
    if (section.length <= maxLen) {
      chunks.push(section);
    } else {
      chunks.push(...splitBlock(section));
    }
  }
  return chunks;
}

// Conversation history limits
const HISTORY_MAX_MESSAGES = Number(process.env.HISTORY_MAX_MESSAGES || 8); // total messages (user+assistant)
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET || 6000); // approximate char budget

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const allowedRoles = new Set(['user', 'assistant']);
  const cleaned = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    const content = typeof m.content === 'string' ? m.content : '';
    if (!allowedRoles.has(role) || !content) continue;
    cleaned.push({ role, content });
  }
  // Keep only the last N messages
  let trimmed = cleaned.slice(-HISTORY_MAX_MESSAGES);
  // Enforce a rough character budget from the end backwards
  let total = 0;
  const result = [];
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const m = trimmed[i];
    const len = m.content.length + 20; // include a bit of overhead per message
    if (total + len > HISTORY_CHAR_BUDGET) break;
    result.push(m);
    total += len;
  }
  return result.reverse();
}

app.post('/api/chat', async (req, res) => {
  try {
    const { query, history: rawHistory } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    // Augment retrieval with last assistant answer excerpt (if any)
    const histForRetrieval = sanitizeHistory(rawHistory);
    const lastAssistant = histForRetrieval.filter((m) => m.role === 'assistant').slice(-1)[0];
    const excerptLen = Number(process.env.RETRIEVAL_HISTORY_EXCERPT_CHARS || 800);
    const assistantExcerpt = lastAssistant ? lastAssistant.content.slice(0, excerptLen) : '';
    const retrievalQuery = assistantExcerpt ? `${assistantExcerpt} \n\n${query}` : query;

    const results = await searchIndex(retrievalQuery, 6);

    const contextLines = results.map(({ item }) => {
      const name = path.basename(item.sourcePath);
      const pageLabel = item.pageNumber ? ` p.${item.pageNumber}` : '';
      const snippet = item.text.slice(0, 1000);
      return `[src=${name}${pageLabel}#${item.chunkId}] ${snippet}`;
    });

    const historyContext = assistantExcerpt
      ? `Previous answer excerpt (for context):\n${assistantExcerpt}`
      : '';
    const context = [historyContext, ...contextLines].filter(Boolean).join('\n\n');

    const system = `You are an expert research assistant. Answer using ONLY the provided context. If the answer is not in the snippets, say you don't have enough information.
    Citations: Use exactly the format (Source: filename.ext p.N). Do not include URLs or paths in citations. Do not invent sources.
    Respond in Markdown with clear headings, lists, and code blocks when helpful. Be concise.`;
    const user = contextLines.length
      ? `Context:\n${context}\n\nQuestion: ${query}\n\nInstructions: Use only the context. If missing info, say so. Cite sources using (Source: filename.ext p.N). Respond in Markdown.`
      : `Question: ${query}\n\nRespond in Markdown.`;

    const historyMessages = sanitizeHistory(rawHistory);
    console.log(`[chat] history messages used: ${historyMessages.length}`);
    if (historyMessages.length) {
      const preview = historyMessages.map((m) => `${m.role}: ${m.content.slice(0, 80)}`);
      console.log(`[chat] history preview:`, preview);
    }

    const answer = await chatComplete([
      { role: 'system', content: system },
      ...historyMessages,
      { role: 'user', content: user },
    ], { temperature: 0.2, max_tokens: Number(process.env.CHAT_MAX_TOKENS || 2048) });

    const chunks = chunkMarkdown(answer, Number(process.env.CHAT_CHUNK_SIZE || 1200));
    res.json({ ok: true, chunks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Streaming chat via SSE
app.post('/api/chat/stream', async (req, res) => {
  try {
    const { query, history: rawHistory } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    // Augment retrieval with last assistant answer excerpt (if any)
    const histForRetrieval = sanitizeHistory(rawHistory);
    const lastAssistant = histForRetrieval.filter((m) => m.role === 'assistant').slice(-1)[0];
    const excerptLen = Number(process.env.RETRIEVAL_HISTORY_EXCERPT_CHARS || 800);
    const assistantExcerpt = lastAssistant ? lastAssistant.content.slice(0, excerptLen) : '';
    const retrievalQuery = assistantExcerpt ? `${assistantExcerpt} \n\n${query}` : query;

    const results = await searchIndex(retrievalQuery, 6);
    const contextLines = results.map(({ item }) => {
      const name = path.basename(item.sourcePath);
      const pageLabel = item.pageNumber ? ` p.${item.pageNumber}` : '';
      const snippet = item.text.slice(0, 1000);
      return `[src=${name}${pageLabel}#${item.chunkId}] ${snippet}`;
    });
    const historyContext = assistantExcerpt
      ? `Previous answer excerpt (for context):\n${assistantExcerpt}`
      : '';
    const context = [historyContext, ...contextLines].filter(Boolean).join('\n\n');

    const system = `You are an expert research assistant. Answer using ONLY the provided context. If the answer is not in the snippets, say you don't have enough information.
    Citations: Use exactly the format (Source: filename.ext p.N). Do not include URLs or paths in citations. Do not invent sources.
    Respond in Markdown with clear headings, lists, and code blocks when helpful. Be concise.`;
    const user = contextLines.length
      ? `Context:\n${context}\n\nQuestion: ${query}\n\nInstructions: Use only the context. If missing info, say so. Cite sources using (Source: filename.ext p.N). Respond in Markdown.`
      : `Question: ${query}\n\nRespond in Markdown.`;

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Initial event with context info (optional)
    send('status', { ok: true, started: true });

    const historyMessages = sanitizeHistory(rawHistory);
    console.log(`[chat/stream] history messages used: ${historyMessages.length}`);
    if (historyMessages.length) {
      const preview = historyMessages.map((m) => `${m.role}: ${m.content.slice(0, 80)}`);
      console.log(`[chat/stream] history preview:`, preview);
    }

    await chatCompleteStream(
      [
        { role: 'system', content: system },
        ...historyMessages,
        { role: 'user', content: user },
      ],
      { temperature: 0.2, max_tokens: 800 },
      (evt) => {
        if (evt.type === 'delta') send('delta', { text: evt.text });
        if (evt.type === 'done') send('done', {});
        if (evt.type === 'error') send('error', { error: evt.error });
      }
    );

    res.end();
  } catch (e) {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
      res.end();
    } catch {
      res.status(500).end();
    }
  }
});
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
