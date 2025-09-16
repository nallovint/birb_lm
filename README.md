# BirbLM – Notebook‑style Document Chat (Groq or Ollama)

A lightweight RAG (Retrieval‑Augmented Generation) web app to chat with documents you place in `docs/`. It supports a cloud model via Groq or a local OpenAI‑compatible model via Ollama. The app runs with Docker Compose and includes:

- Settings UI for runtime provider switching (Groq/Ollama)
- Document Manager (drag‑drop + browse uploads, delete)
- Rebuildable vector index with live progress (in Settings and Chat)
- Clean chat UI with citations and selectable document context

## Features
- Indexes `PDF`, `DOCX`, `MD`, and `TXT`
- Vector embeddings via `@xenova/transformers` (MiniLM)
- Retrieval‑augmented answers with inline numeric refs and an end Citations list (📄 filename.ext pg. N)
- Runtime provider switching; no container restart required
- Document selection panel locks after first message; defaults persist

## Requirements
- Docker Desktop
- Optional: Groq API key (cloud mode)
- Optional: Ollama running (local mode; Compose includes an `ollama` service)

## Quick Start (Docker)

### 0) Start Docker Desktop

### 1) Clone and start
```bash
git clone <this-repo-url>
cd birb_lm
# Start services (app + ollama)
docker compose up -d
```

### 2) Open the app
- Landing page: http://localhost:3000
- Use “Settings” to choose provider and test connection
- Use “Open App” to launch the chat UI

### 3) Choose your provider (no restart needed)
- Settings: http://localhost:3000/settings.html
- Groq: paste API key and set model (e.g., `llama-3.1-8b-instant`) → Test Connection → Save Settings
- Ollama: set URL (`http://ollama:11434` in Docker, `http://localhost:11434` on host) and model (e.g., `llama3.1:8b`) → Test → Save
- Tip (Ollama): pull the model if needed
```bash
docker compose exec ollama ollama pull llama3.1:8b
```

### 4) Upload documents
- Settings → Documents: drag & drop or browse to upload `.pdf`, `.docx`, `.md`, `.txt`
- See your library; use “Delete” to remove files
- During an index rebuild, uploads are disabled to avoid conflicts

### 5) Rebuild the index
- Click “Rebuild index” in Settings or the Chat header
- Watch the progress bar through “Chunking” and “Embedding” → “Indexed N chunks”

### 6) Chat
- Chat UI: http://localhost:3000/chat.html
- Left panel: select documents to include, then “Use selected” (locks after first message)
- Ask questions; answers use inline numeric refs (e.g., 1 or [1]) and a Citations list (📄 filename.ext pg. N). Suggestions update as you go
- Optional: toggle “Allow outside knowledge for this message” above the input to allow general knowledge for just that message; when off, answers are strictly grounded to the selected documents
- Rebuild progress also appears in the chat header

## How it works
- Indexing: PDFs are one chunk per page; other text is word‑window chunked with overlap; embeddings are saved to `storage/index.json`
- Retrieval: queries are embedded and top‑K chunks are added as context (default top‑K = 12; per‑snippet cap ≈ 2000 chars). Selection restricts retrieval to chosen docs. Conversation carryover defaults: 12 messages total, ~12000 characters budget
- Settings: persisted at `storage/settings.json`, read at runtime to switch providers without restart

## Environment variables (optional)
The Settings UI covers most needs; envs below tune behavior.

- Provider/Models
  - `LLM_MODE` = `groq` | `ollama` (defaults to autodetect)
  - `GROQ_API_KEY` (Groq)
  - `GROQ_MODEL` (default: `llama-3.1-8b-instant`)
  - `LLM_BASE_URL` (OpenAI‑compatible; e.g., `http://ollama:11434`)
  - `LLM_MODEL` (default: `llama3.1:8b`)
- Indexing/Storage
  - `DOCS_DIR` (default: `docs`)
  - `INDEX_DIR` (default: `storage`)
  - `UPLOAD_MAX_BYTES` (default: 20MB)
  - `JSON_BODY_LIMIT` (default: `30mb`)
  - `PDF_MAX_CHARS` (default: 4000)
  - `TXT_CHUNK_SIZE` (default: 600)
  - `TXT_CHUNK_OVERLAP` (default: 80)
  - `EMBED_YIELD_EVERY_N` (default: 5)
  - `BUILD_YIELD_EVERY_N` (default: 50)
  - `HISTORY_MAX_MESSAGES` (default: 12)
  - `HISTORY_CHAR_BUDGET` (default: 12000)
  - `CHAT_CHUNK_SIZE` (default: 1200; affects stream flush heuristics if enabled — currently disabled to keep responses as a single message)

## Useful commands
```bash
# Start/stop
docker compose up -d
docker compose down

# Logs
docker compose logs -f app
# (Optional) Ollama logs
docker compose logs -f ollama

# Pull/update images
docker compose pull

# Rebuild app image after code changes
docker compose up -d --build app

# Pull an Ollama model (examples)
docker compose exec ollama ollama pull llama3.1:8b
# or
docker compose exec ollama ollama pull gemma2:2b
```

## Troubleshooting
- Provider badge shows the wrong provider / model
  - In Settings, Test Connection → Save Settings; hard refresh chat page
  - Ensure Ollama is up and reachable at the configured URL
- Uploads fail via browse/drag‑drop
  - Allowed: `.pdf`, `.docx`, `.md`, `.txt`; size ≤ `UPLOAD_MAX_BYTES`
  - Check server logs: `docker compose logs -f app`
- Rebuild progress seems stuck at “Embedding”
  - Small corpora may finish between polls; try more/larger files
  - Tune `EMBED_YIELD_EVERY_N=1` and `BUILD_YIELD_EVERY_N=10` if needed
- No results in answers or answers seem too limited
  - Rebuild after adding files; ensure correct documents were selected before first message
  - If you need broader answers, enable “Allow outside knowledge for this message” for that turn
  - You can increase retrieval breadth by adjusting envs (see defaults above)
- Ollama issues
  - Check health: `docker compose ps` (should be healthy)
  - List models: `docker compose exec ollama ollama list`

## Development (without Docker)
Requires Node.js 20+
```bash
npm install
npm start
# Visit http://localhost:3000
```
Notes:
- You still need a reachable model endpoint (Ollama on `http://localhost:11434`) or a `GROQ_API_KEY`
- First run downloads embedding weights; subsequent runs are faster

## Security
- API keys are never logged
- Filenames are sanitized; path traversal blocked on delete
- File types and sizes validated on upload

## License
CC BY-NC 4.0

