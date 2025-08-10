# Technical Specification: BirbLM (Groq or Local OpenAI-compatible)

## 1. Purpose and Scope
This application provides a minimal document chat experience with retrieval-augmented generation (RAG). It indexes local documents under `docs/`, stores an embedding index in `storage/index.json`, and serves a web UI for querying. Responses are grounded by retrieved chunks and produced by either a local OpenAI-compatible server (e.g., Ollama) or Groq (cloud), selected at runtime.

## 2. High-level Architecture
- Browser UI (static files in `public/`)
- Node.js API server (`src/server.js`)
  - Document ingestion and indexing endpoints
  - Chat endpoint that calls the LLM client and manages message chunking
  - Provider status endpoint for UI
- LLM client (`src/llmClient.js`)
  - Auto-detects local vs. Groq, or obeys explicit `LLM_MODE`
  - Uniform chat API
- Retriever/indexer (`src/retriever.js`)
  - Loads files, extracts text, chunks it, embeds via `@xenova/transformers`, and persists index
- Optional CLI ingest (`src/ingest.js`)
- Containerization (`Dockerfile`, `docker-compose.yml`)

## 3. Runtime Modes (LLM provider selection)
Provider selection resolves in this order (see `src/llmClient.js`):
1) Explicit override via `LLM_MODE`:
   - `LLM_MODE=ollama` (or `openai`, `openai-compatible`) → use OpenAI-compatible API at `LLM_BASE_URL` (default `http://ollama:11434`).
   - `LLM_MODE=groq` → use Groq SDK with `GROQ_API_KEY`.
2) If no explicit mode:
   - If `LLM_BASE_URL` is set → use OpenAI-compatible.
   - Else probe common local endpoints: `http://ollama:11434`, `http://host.docker.internal:11434`.
   - Else if `GROQ_API_KEY` present → use Groq.
   - Else throw a configuration error.

Model defaults:
- OpenAI-compatible default model: `LLM_MODEL` (e.g., `llama3.2:1b`).
- Groq default model: `GROQ_MODEL` or `llama-3.1-8b-instant`.

The UI header calls `/api/status` to show the active provider and model.

## 4. API Surface
- Static UI: `GET /` serves files from `public/`.
- `POST /api/ingest`
  - Rebuilds the index from `DOCS_DIR` (default `docs/`).
  - Returns `{ ok: true, chunks: <count> }`.
- `POST /api/chat`
  - Body: `{ query: string }`
  - Retrieves top-k chunks (default 6) from the index, builds a grounded prompt, calls the LLM, splits the answer into UI-friendly chunks, and returns `{ ok: true, chunks: string[] }`.
- `GET /api/status`
  - Returns `{ ok: true, provider, baseUrl, model }` for UI indicator.

## 5. UI Flow (`public/`)
- `index.html` loads a simple chat UI and buttons for rebuilding the index.
- `app.js`:
  - `ingest()` calls `/api/ingest` and shows progress text.
  - `send()` posts queries to `/api/chat` and streams returned message chunks.
  - Fetches `/api/status` on load to display provider/model.
  - Renders Markdown via `marked` + `DOMPurify`.

## 6. Chat Request Flow (`src/server.js`)
1) Validate input.
2) `searchIndex(query, k=6)` returns the most relevant indexed items.
3) Compose system and user messages:
   - System instructions enforce grounded answers and cite only basenames: `(Source: filename.ext p.N)`.
4) `chatComplete(messages, options)` delegates to `llmClient`.
5) Split the final answer for the UI via `chunkMarkdown()`.

### 6.1 Heading-aware chunking
`chunkMarkdown(text, maxLen)` prefers semantic splits:
- Split by Markdown headings first.
- For oversize blocks, split by paragraphs; if needed, then by sentences.
- Final fallback splits at whitespace to avoid mid-word cuts.

## 7. Retrieval and Indexing (`src/retriever.js`)
- Supported formats: `.pdf` (via `pdfjs-dist`), `.docx` (via `mammoth`), `.md`, `.txt`.
- Pipeline:
  1) `listDocFiles(docDir)` uses `fast-glob` to collect files.
  2) `loadTextFromFile(path)` extracts text per file type.
  3) Chunking:
     - PDFs: one chunk per page to preserve page-level citations.
     - Others: word-based chunks with overlap via `chunkText()`.
  4) Embedding:
     - `@xenova/transformers` feature-extraction pipeline
     - Default model: `Xenova/all-MiniLM-L6-v2`
     - Options `{ pooling: 'mean', normalize: true }`
  5) Persist index:
     - JSON at `storage/index.json` with fields: `dim`, and `items[]` containing `{ vector, text, sourcePath, pageNumber, chunkId, tokenCount }`.

- Retrieval:
  - Compute query embedding, cosine similarity to all items, take top-k.

## 8. LLM Client (`src/llmClient.js`)
- OpenAI-compatible path
  - POST `${baseUrl}/v1/chat/completions`
  - Headers: `Authorization: Bearer <apiKey>` (uses `LLM_API_KEY`/`OPENAI_API_KEY`/`GROQ_API_KEY` or `ollama` default)
  - Body: `{ model, messages, temperature, max_tokens }`
  - Returns the first choice message content.
- Groq path
  - Uses `groq-sdk` with `GROQ_API_KEY`.
- Error handling
  - Non-200 responses throw with the upstream message for transparency.

## 9. Environment Variables
- Provider selection
  - `LLM_MODE` = `ollama` | `groq` (optional override)
  - `LLM_BASE_URL` (OpenAI-compatible base URL; defaults to `http://ollama:11434` in Compose)
  - `LLM_MODEL` (e.g., `llama3.2:1b`, `gemma2:2b`)
  - `LLM_API_KEY` (rarely needed for local endpoints)
  - `GROQ_API_KEY`, `GROQ_MODEL`
- Server and indexing
  - `PORT` (default 3000)
  - `DOCS_DIR` (default `docs`)
  - `INDEX_DIR` (default `storage`)
  - `PDF_MAX_CHARS` (cap per page)
  - `TXT_CHUNK_SIZE`, `TXT_CHUNK_OVERLAP`
  - `LOG_EVERY_N_ITEMS`

## 10. Dockerization
- `Dockerfile`
  - Base: `node:20-slim`
  - Installs build tools for native modules (python3, make, g++)
  - `npm ci --omit=dev`
  - Copies `public/`, `src/`, and optional `docs/`, `storage/`
  - Exposes `3000`, runs `node src/server.js`
- `docker-compose.yml`
  - `ollama` service: `ollama/ollama:latest`, port `11434`, healthcheck
  - `app` service: builds the Node app, waits for `ollama` healthy
  - Mounts `./docs` and `./storage` to persist data
  - Loads `.env` into `app` via `env_file`
  - Ports: `3000:3000` for UI/API, `11434:11434` for Ollama

## 11. Operational Guidance
- Typical Docker workflow
  1) `mkdir -p docs storage`
  2) Choose a model in `.env` (uncomment ONE `LLM_MODEL`) and set `LLM_MODE=ollama` or `LLM_MODE=groq`.
  3) `docker compose up -d`
  4) If Ollama mode: `docker compose exec ollama ollama pull <model>`
  5) `docker compose up -d --force-recreate app`
  6) Open `http://localhost:3000`
  7) Verify provider/model via `/api/status` or UI header
- Logs and progress
  - `docker compose logs -f app`
  - `docker compose exec app node src/ingest.js`
- Health checks
  - `docker compose ps`
  - `curl -s http://localhost:11434/api/version`

## 12. Error Handling and Limits
- Common errors
  - Model not found (Ollama): pull the model first.
  - Insufficient memory (Ollama): choose a smaller model (e.g., `llama3.2:1b`) or increase Docker memory.
  - Missing credentials (Groq): set `GROQ_API_KEY`.
  - No provider configured: set `LLM_MODE` or one of `LLM_BASE_URL`/`GROQ_API_KEY`.
- Server returns structured JSON errors from `/api/ingest` and `/api/chat`.

## 13. Security Considerations
- The UI is static with client-initiated requests to server endpoints.
- CORS: enabled for all origins by default (`cors()`); tighten as needed for production.
- No authentication is implemented; consider adding auth for multi-user deployments.
- `DOMPurify` is used to sanitize rendered Markdown.

## 14. Extensibility
- Alternative vector stores: replace `saveIndex`/`loadIndex` with a DB-backed store (e.g., SQLite+vss, Qdrant, pgvector).
- Alternative embedding models: change the model used by `@xenova/transformers` in `getEmbedder()`.
- Alternate file types: extend `loadTextFromFile` to support more formats.
- Streaming responses: wrap OpenAI-compatible API with server-sent events for token streaming.
- UI improvements: add message history, citations hyperlinks, or per-source filtering.

## 15. File Map
- `public/`
  - `index.html`, `style.css`, `app.js`
- `src/`
  - `server.js` (API + UI hosting + provider status + chunking)
  - `llmClient.js` (provider detection + chat abstraction)
  - `retriever.js` (text extraction, chunking, embeddings, search, persistence)
  - `ingest.js` (CLI index build)
  - `groqClient.js` (legacy/simple Groq client; not used by server)
- Root
  - `Dockerfile`, `docker-compose.yml`, `README.md`, `tech_spec.md`

## 16. Sequence (Chat)
1) UI `POST /api/chat { query }`
2) Server retrieves top-k chunks via cosine similarity
3) Compose grounded messages with citations policy
4) `llmClient.chatComplete()` calls local OpenAI-compatible or Groq
5) Split Markdown into chunks for the UI
6) UI renders chunks, preserving Markdown

## 17. Sequence (Ingest)
1) UI or CLI triggers ingest
2) Enumerate files, extract text per type
3) Chunk text (pdf: per page; others: overlapped words)
4) Embed with `@xenova/transformers`
5) Save `storage/index.json`
