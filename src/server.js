import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Use runtime-switchable adapter (instead of env-cached llmClient)
import { llmChatComplete as chatComplete, llmChatCompleteStream as chatCompleteStream, getRuntimeProviderInfo as getProviderInfo } from './llmAdapter.js';
import { loadSettings, saveSettings } from './settings.js';
import fs from 'node:fs/promises';
import { searchIndex, buildAndSaveIndex, loadIndex, listDocFiles, estimateCorpusChunks, buildCorpusChunks, embedTexts, saveIndex } from './retriever.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
// Increase JSON limit to support base64 uploads up to ~20MB
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '30mb' }));
// Server boot marker for client-side cache invalidation
const serverStartedAt = new Date().toISOString();

// Static UI
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// Settings Management
app.get('/api/settings', async (req, res) => {
  try {
    const s = await loadSettings();
    res.json({ success: true, data: s });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const provider = String(body.aiProvider || '').toLowerCase();
    if (provider && !['groq', 'ollama'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Invalid aiProvider' });
    }
    if (body.ollama?.url && !/^https?:\/\//i.test(body.ollama.url)) {
      return res.status(400).json({ success: false, error: 'Invalid Ollama URL' });
    }
    const saved = await saveSettings(body);
    res.json({ success: true, message: 'Settings saved', data: saved });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.get('/api/settings/test', async (req, res) => {
  try {
    const s = await loadSettings();
    if (s.aiProvider === 'groq') {
      if (!s.groq.apiKey) return res.json({ success: false, message: 'Missing GROQ API key' });
      const out = await chatComplete([
        { role: 'system', content: 'You return the word ok.' },
        { role: 'user', content: 'Say ok' },
      ], { max_tokens: 3 });
      return res.json({ success: true, message: 'Groq reachable', data: { sample: out?.slice(0, 32) } });
    }
    const base = s.ollama?.url || 'http://ollama:11434';
    try {
      const resp = await fetch(new URL('/v1/models', base));
      const ok = resp.ok;
      const models = ok ? await resp.json().catch(() => ({})) : null;
      return res.json({ success: ok, message: ok ? 'Ollama reachable' : `Ollama HTTP ${resp.status}`, data: models });
    } catch (err) {
      return res.json({ success: false, message: 'Ollama not reachable', error: String(err) });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});
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

// Progressive ingest with simple polling progress state (in-memory)
let ingestProgress = { stage: 'idle', processed: 0, total: 0 };
app.post('/api/ingest/start', async (req, res) => {
  try {
    const dir = process.env.DOCS_DIR || 'docs';
    ingestProgress = { stage: 'scanning', processed: 0, total: 0 };
    res.json({ success: true });
    // Kick off async job
    ;(async () => {
      try {
        // Estimate total chunks for chunking stage to enable progress bar
        try {
          const est = await estimateCorpusChunks(dir);
          ingestProgress = { stage: 'chunking', processed: 0, total: est };
        } catch {
          ingestProgress = { stage: 'chunking', processed: 0, total: 0 };
        }
        const chunks = await buildCorpusChunks(dir, {
          onProgress: ({ processed }) => {
            ingestProgress = { stage: 'chunking', processed, total: ingestProgress.total };
          }
        });
        ingestProgress = { stage: 'embedding', processed: 0, total: chunks.length };
        const texts = chunks.map(c => c.text);
        const embeddings = await embedTexts(texts, {
          onProgress: ({ processed }) => {
            ingestProgress = { stage: 'embedding', processed, total: chunks.length };
          }
        });
        const dim = embeddings.length ? embeddings[0].length : 384;
        const items = chunks.map((c, i) => ({
          vector: embeddings[i] ?? new Array(dim).fill(0),
          text: c.text,
          sourcePath: c.sourcePath,
          pageNumber: c.pageNumber,
          chunkId: c.chunkId,
          tokenCount: c.tokenCount,
        }));
        await saveIndex({ dim, items });
        ingestProgress = { stage: 'done', processed: items.length, total: items.length };
      } catch (err) {
        ingestProgress = { stage: 'error', processed: 0, total: 0, error: String(err) };
      }
    })();
  } catch (e) {
    ingestProgress = { stage: 'error', processed: 0, total: 0, error: String(e) };
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.get('/api/ingest/status', async (req, res) => {
  res.json({ success: true, data: ingestProgress });
});

// List available documents for selection
app.get('/api/docs', async (req, res) => {
  try {
    const dir = process.env.DOCS_DIR || 'docs';
    const files = await listDocFiles(dir);
    const docs = files.map((abs) => ({ path: abs, name: path.basename(abs) }));
    res.json({ ok: true, docs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Documents enhanced API
app.get('/api/documents', async (req, res) => {
  try {
    const dir = process.env.DOCS_DIR || 'docs';
    const files = await listDocFiles(dir);
    const docs = await Promise.all(files.map(async (abs) => {
      let size = 0; let mtime = null; let type = (path.extname(abs).slice(1) || '').toLowerCase();
      try { const st = await fs.stat(abs); size = st.size; mtime = st.mtime?.toISOString?.() || null; } catch {}
      return { path: abs, name: path.basename(abs), size, uploadDate: mtime, processedDate: null, type };
    }));
    res.json({ success: true, data: { documents: docs } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/documents/upload', async (req, res) => {
  try {
    const { fileName, contentBase64 } = req.body || {};
    if (!fileName || !contentBase64) return res.status(400).json({ success: false, error: 'Missing fileName or contentBase64' });
    const safe = path.basename(fileName);
    const allowed = ['.pdf', '.docx', '.md', '.txt', '.html', '.htm', '.csv', '.tsv', '.log', '.json', '.jsonl', '.yaml', '.yml', '.ipynb', '.xlsx', '.epub', '.pptx'];
    const ext = path.extname(safe).toLowerCase();
    if (!allowed.includes(ext)) return res.status(400).json({ success: false, error: 'Unsupported file type' });
    const buf = Buffer.from(contentBase64, 'base64');
    const maxBytes = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024);
    if (buf.length > maxBytes) return res.status(400).json({ success: false, error: 'File too large' });
    const dir = process.env.DOCS_DIR || 'docs';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safe), buf);
    res.json({ success: true, message: 'Uploaded', data: { name: safe } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.delete('/api/documents/:filename', async (req, res) => {
  try {
    const safe = path.basename(req.params.filename || '');
    if (!safe) return res.status(400).json({ success: false, error: 'Missing filename' });
    const dir = process.env.DOCS_DIR || 'docs';
    await fs.unlink(path.join(dir, safe));
    res.json({ success: true, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// Session default selection (persisted in settings)
app.get('/api/session/documents', async (req, res) => {
  try {
    const s = await loadSettings();
    res.json({ success: true, data: { selectedDocuments: s.documents.defaultSelection || [] } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/session/documents', async (req, res) => {
  try {
    const { selectedDocuments } = req.body || {};
    if (!Array.isArray(selectedDocuments)) return res.status(400).json({ success: false, error: 'selectedDocuments must be array' });
    const s = await loadSettings();
    const saved = await saveSettings({ documents: { ...s.documents, defaultSelection: selectedDocuments } });
    res.json({ success: true, message: 'Saved', data: { selectedDocuments: saved.documents.defaultSelection } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// Generate an asynchronous brief summary of the current document corpus
app.get('/api/summary', async (req, res) => {
  try {
    // Build per-document context from the current index
    const index = await loadIndex();
    const maxDocs = Number(process.env.SUMMARY_MAX_DOCS || 6);
    const snippetsPerDoc = Number(process.env.SUMMARY_SNIPPETS_PER_DOC || 2);
    const snippetChars = Number(process.env.SUMMARY_SNIPPET_CHARS || 400);

    const byDoc = new Map();
    for (const item of index.items || []) {
      // GET version: no filtering; summarize overall corpus
      const key = item.sourcePath;
      if (!byDoc.has(key)) byDoc.set(key, []);
      const arr = byDoc.get(key);
      if (arr.length < snippetsPerDoc) {
        const text = (item.text || '').slice(0, snippetChars);
        arr.push({ pageNumber: item.pageNumber || null, text });
      }
      if (byDoc.size >= maxDocs && arr.length >= snippetsPerDoc) {
        // continue to fill other docs' first snippets, no early break
      }
    }

    const docEntries = Array.from(byDoc.entries()).slice(0, maxDocs);
    // Summarize each document separately to ensure coverage, then concatenate
    const system = 'You summarize one document accurately and concisely. Avoid speculation.';
    const perDocMaxTokens = Math.max(200, Math.floor(Number(process.env.SUMMARY_MAX_TOKENS || 800) / Math.max(1, docEntries.length)));
    const sections = [];
    for (const [sourcePath, parts] of docEntries) {
      const name = path.basename(sourcePath);
      const joined = parts
        .map((p) => (p.pageNumber ? `(p.${p.pageNumber}) ` : '') + p.text)
        .join('\n');
      const user = `Document name: ${name}\nSnippets (from this document only):\n${joined}\n\nTask: Produce Markdown with:\n- A heading with the document name\n- A 1-3 sentence précis of its contents\n- 3-5 bullet themes`;
      const section = await chatComplete([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { temperature: 0.2, max_tokens: perDocMaxTokens });
      if (section) sections.push(section);
    }

    res.json({ ok: true, summary: sections.join('\n\n') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Summary for selected documents
app.post('/api/summary', async (req, res) => {
  try {
    const { selectedDocs } = req.body || {};
    const index = await loadIndex();
    const maxDocs = Number(process.env.SUMMARY_MAX_DOCS || 6);
    const snippetsPerDoc = Number(process.env.SUMMARY_SNIPPETS_PER_DOC || 2);
    const snippetChars = Number(process.env.SUMMARY_SNIPPET_CHARS || 400);

    const allow = Array.isArray(selectedDocs) && selectedDocs.length ? new Set(selectedDocs) : null;
    const byDoc = new Map();
    for (const item of index.items || []) {
      if (allow && !allow.has(item.sourcePath)) continue;
      const key = item.sourcePath;
      if (!byDoc.has(key)) byDoc.set(key, []);
      const arr = byDoc.get(key);
      if (arr.length < snippetsPerDoc) {
        const text = (item.text || '').slice(0, snippetChars);
        arr.push({ pageNumber: item.pageNumber || null, text });
      }
    }

    const docEntries = Array.from(byDoc.entries()).slice(0, maxDocs);
    const system = 'You summarize one document accurately and concisely. Avoid speculation.';
    const perDocMaxTokens = Math.max(200, Math.floor(Number(process.env.SUMMARY_MAX_TOKENS || 800) / Math.max(1, docEntries.length)));
    const sections = [];
    for (const [sourcePath, parts] of docEntries) {
      const name = path.basename(sourcePath);
      const joined = parts
        .map((p) => (p.pageNumber ? `(p.${p.pageNumber}) ` : '') + p.text)
        .join('\n');
      const user = `Document name: ${name}\nSnippets (from this document only):\n${joined}\n\nTask: Produce Markdown with:\n- A heading with the document name\n- A 1-3 sentence précis of its contents\n- 3-5 bullet themes`;
      const section = await chatComplete([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { temperature: 0.2, max_tokens: perDocMaxTokens });
      if (section) sections.push(section);
    }

    res.json({ ok: true, summary: sections.join('\n\n') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Suggest three helpful questions based on current corpus context
app.post('/api/suggest', async (req, res) => {
  try {
    const k = Number(process.env.SUGGEST_TOP_K || 10);
    const { history: rawHistory, selectedDocs } = req.body || {};
    const historyMessages = sanitizeHistory(rawHistory);
    const recent = historyMessages.slice(-6);

    let context = '';
    if (recent.length === 0) {
      // Initial suggestions: ensure coverage across documents
      const index = await loadIndex();
      const maxDocs = Number(process.env.SUGGEST_MAX_DOCS || 8);
      const perDocChars = Number(process.env.SUGGEST_SNIPPET_CHARS || 300);
      const byDoc = new Map();
      for (const item of index.items || []) {
        if (Array.isArray(selectedDocs) && selectedDocs.length) {
          if (!selectedDocs.includes(item.sourcePath)) continue;
        }
        const key = item.sourcePath;
        if (!byDoc.has(key)) byDoc.set(key, []);
        const arr = byDoc.get(key);
        if (arr.length < 1) arr.push({ pageNumber: item.pageNumber || null, text: (item.text || '').slice(0, perDocChars) });
      }
      const docEntries = Array.from(byDoc.entries()).slice(0, maxDocs);
      const parts = docEntries.map(([sourcePath, arr]) => {
        const name = path.basename(sourcePath);
        const s = arr.map((p) => (p.pageNumber ? `(p.${p.pageNumber}) ` : '') + p.text).join('\n');
        return `[${name}] ${s}`;
      });
      context = parts.join('\n\n');
    } else {
      // Conversation-based suggestions: bias retrieval towards recent context
      const seedQuery = recent
        .map((m) => `${m.role}: ${m.content}`)
        .join(' \n ')
        .slice(0, 1200);
      const results = await searchIndex(seedQuery, k, Array.isArray(selectedDocs) && selectedDocs.length ? selectedDocs : null);
      const snippets = results.map(({ item }) => {
        const name = path.basename(item.sourcePath);
        const page = item.pageNumber ? ` p.${item.pageNumber}` : '';
        return `[${name}${page}] ${item.text.slice(0, 500)}`;
      });
      context = snippets.join('\n\n');
    }

    const system = 'You are assisting a user exploring a document corpus. Propose three concise, high-signal questions grounded in the provided context. Ensure each question is unique and does NOT repeat or lightly paraphrase the user\'s recent questions. Output ONLY a JSON array of 3 strings. Do not include any extra text.';
    const convo = recent.map((m) => `- ${m.role}: ${m.content}`).join('\n') || '(no prior conversation)';
    const user = `CONTEXT:\n${context}\n\nRECENT CONVERSATION (may be empty):\n${convo}\n\nTask: Propose three helpful, distinct questions that do not repeat what was just asked.`;

    const raw = await chatComplete([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.3, max_tokens: 200 });

    let questions = [];
    try {
      questions = JSON.parse(raw);
      if (!Array.isArray(questions)) throw new Error('not array');
      questions = questions.map((q) => String(q)).filter(Boolean).slice(0, 3);
    } catch {
      // Fallback: parse lines
      questions = raw
        .split(/\n/)
        .map((l) => l.replace(/^[-*\d\.\)\s]+/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
    }
    // Post-process: de-duplicate and avoid recent user questions
    const normalize = (s) => (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s\?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const recentUser = historyMessages.filter((m) => m.role === 'user').slice(-3).map((m) => normalize(m.content));
    const seen = new Set();
    const filtered = [];
    for (const q of questions) {
      const nq = normalize(q);
      if (!nq) continue;
      let tooSimilar = false;
      for (const ru of recentUser) {
        if (!ru) continue;
        if (nq === ru) { tooSimilar = true; break; }
        if (nq.length >= 12 && (nq.includes(ru) || ru.includes(nq))) { tooSimilar = true; break; }
      }
      if (tooSimilar) continue;
      if (seen.has(nq)) continue;
      seen.add(nq);
      filtered.push(q);
      if (filtered.length === 3) break;
    }
    while (filtered.length < 3) {
      const fillers = [
        'What are the main topics covered across these documents?',
        'Summarize the key takeaways with citations.',
        'Which sections should I read first and why?'
      ];
      const q = fillers[filtered.length % fillers.length];
      const nq = normalize(q);
      if (!seen.has(nq)) { seen.add(nq); filtered.push(q); }
      else break;
    }
    questions = filtered.slice(0, 3);
    res.json({ ok: true, questions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Provider status for UI
app.get('/api/status', async (req, res) => {
  try {
    const info = await getProviderInfo();
    res.json({ ok: true, startedAt: serverStartedAt, ...info });
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
    const { query, history: rawHistory, selectedDocs } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    // Augment retrieval with last assistant answer excerpt (if any)
    const histForRetrieval = sanitizeHistory(rawHistory);
    const lastAssistant = histForRetrieval.filter((m) => m.role === 'assistant').slice(-1)[0];
    const excerptLen = Number(process.env.RETRIEVAL_HISTORY_EXCERPT_CHARS || 800);
    const assistantExcerpt = lastAssistant ? lastAssistant.content.slice(0, excerptLen) : '';
    const retrievalQuery = assistantExcerpt ? `${assistantExcerpt} \n\n${query}` : query;

    const results = await searchIndex(retrievalQuery, 6, Array.isArray(selectedDocs) && selectedDocs.length ? selectedDocs : null);

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
    const { query, history: rawHistory, selectedDocs } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    // Augment retrieval with last assistant answer excerpt (if any)
    const histForRetrieval = sanitizeHistory(rawHistory);
    const lastAssistant = histForRetrieval.filter((m) => m.role === 'assistant').slice(-1)[0];
    const excerptLen = Number(process.env.RETRIEVAL_HISTORY_EXCERPT_CHARS || 800);
    const assistantExcerpt = lastAssistant ? lastAssistant.content.slice(0, excerptLen) : '';
    const retrievalQuery = assistantExcerpt ? `${assistantExcerpt} \n\n${query}` : query;

    const results = await searchIndex(retrievalQuery, 6, Array.isArray(selectedDocs) && selectedDocs.length ? selectedDocs : null);
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

    const chunkLimit = Number(process.env.CHAT_CHUNK_SIZE || 1200);
    let accForFlush = '';
    let hasEmittedDelta = false;

    await chatCompleteStream(
      [
        { role: 'system', content: system },
        ...historyMessages,
        { role: 'user', content: user },
      ],
      { temperature: 0.2, max_tokens: Number(process.env.CHAT_MAX_TOKENS || 2048) },
      (evt) => {
        if (evt.type === 'delta') {
          accForFlush += evt.text || '';
          send('delta', { text: evt.text });
          hasEmittedDelta = true;

          // Determine if we're inside a fenced code block (``` or ~~~ at start of line)
          const fences = (accForFlush.match(/(?:^|\n)\s*(?:```|~~~)/g) || []).length;
          const insideFence = fences % 2 === 1;

          const atSentenceBoundary = /[\.!?]\s*$/.test(accForFlush) || /\n\s*$/.test(accForFlush);
          if (accForFlush.length >= chunkLimit && atSentenceBoundary && !insideFence) {
            // Signal the client to finalize current message and start a new one
            send('flush', { done: false });
            accForFlush = '';
          }
        }
        if (evt.type === 'done') {
          // If nothing was emitted, still send a minimal delta to keep UI consistent
          if (!hasEmittedDelta) send('delta', { text: '' });
          send('done', {});
        }
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
