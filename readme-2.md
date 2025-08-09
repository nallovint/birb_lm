## RAG Try – Quick Start (Ollama or Groq)

This guide shows two ways to run the app:
- Local LLM with Ollama (OpenAI-compatible API)
- Cloud LLM with Groq

It also covers switching providers, using the app, and troubleshooting.

---

## Prerequisites
- Docker Desktop installed and running
- Optional (Groq mode): a Groq API key

The included Docker Compose starts:
- `ollama` (local model server)
- `app` (this web app)

---

## Quick Start A: Groq (online)
### 1) Create an `.env` file in the project root
```bash
# .env
# Select Groq mode
LLM_MODE=groq

# Required for Groq
GROQ_API_KEY=your_groq_api_key_here
# Optional: choose a Groq model
GROQ_MODEL=llama-3.1-8b-instant
```

### 2) Start the app
```bash
docker compose up -d
```

### 3) Open the app
- Visit [http://localhost:3000](http://localhost:3000)
- The header should show: “Provider: Groq • Model: llama-3.1-8b-instant” (or your configured model)

### How to get a Groq API key
- Sign in at the [Groq Console](https://console.groq.com)
- Create an API key and paste it into `GROQ_API_KEY` in `.env`

---

## Quick Start B: Ollama (local)
### 1) Create an `.env` file in the project root
```bash
# .env
# Select local OpenAI-compatible mode
LLM_MODE=ollama

# App will reach Ollama via this URL inside the compose network
LLM_BASE_URL=http://ollama:11434

# Choose an Ollama model (will be pulled next)
LLM_MODEL=llama3.1:8b
```

### 2) Start services and pull a model
```bash
docker compose up -d
# Pull a model (examples below)
docker compose exec ollama ollama pull llama3.1:8b
# If you chose a different model, pull that one instead
```

### 3) Restart the app container to pick up changes
```bash
docker compose up -d --force-recreate app
```

### 4) Open the app
- Visit [http://localhost:3000](http://localhost:3000)
- The header should show: “Provider: Local/OpenAI-compatible (http://ollama:11434) • Model: llama3.1:8b”

---

## Switching between Groq and Ollama
You can switch any time by editing `.env` and restarting the `app` container.

Groq (cloud):
```bash
LLM_MODE=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.1-8b-instant
```

Ollama (local):
```bash
LLM_MODE=ollama
LLM_BASE_URL=http://ollama:11434
LLM_MODEL=llama3.1:8b
```

Apply changes:
```bash
docker compose up -d --force-recreate app
```

Notes:
- If `LLM_MODE` is not set, the app attempts to auto-detect a local server at `http://ollama:11434`; otherwise it falls back to Groq if `GROQ_API_KEY` is present.
- Explicit `LLM_MODE` is recommended for clarity.

---

## How to use the app
### 1) Add your documents
- Place PDF, DOCX, MD, or TXT files in the `docs/` folder.

### 2) Rebuild the index
- In the top bar, click “Rebuild index from docs/”.
- The status text shows progress and how many chunks were indexed.

### 3) Select the documents to use
- On the left, you’ll see a list of documents with checkboxes.
- Select one or more documents.
- Click “Use selected” or send your first message; the selection panel hides and your selection is locked for the session.

### 4) Chat
- Ask questions in the input box; responses cite sources.
- Suggestions refresh based on your conversation and selected docs.
- The summary panel on the right summarizes only the selected documents.

---

## Troubleshooting
- **Provider badge is wrong or empty**
  - Ensure `.env` is correct. For Groq, set `LLM_MODE=groq` and `GROQ_API_KEY`. For Ollama, set `LLM_MODE=ollama`, `LLM_BASE_URL`, and `LLM_MODEL`.
  - After changing `.env`, run: `docker compose up -d --force-recreate app`.

- **Ollama not ready / model missing**
  - Check service: `docker compose ps` (look for `ollama` healthy)
  - Pull model: `docker compose exec ollama ollama pull llama3.1:8b`
  - Logs: `docker compose logs -f ollama`

- **App errors or indexing stuck**
  - App logs: `docker compose logs -f app`
  - First-time embedding downloads can take a while; let it finish.
  - If `storage/index.json` exists and you changed `docs/`, click “Rebuild index from docs/”.

- **Changes not taking effect**
  - Recreate the app container: `docker compose up -d --force-recreate app`
  - For code updates: `docker compose up -d --build app`

- **Nothing retrieved / irrelevant answers**
  - Ensure you selected the correct documents (left panel) before first message.
  - Click “Rebuild index from docs/” after changing files in `docs/`.

- **Port conflicts**
  - Ensure ports 3000 (app) and 11434 (Ollama) are free on your host.

- **Network/SSE issues (streaming)**
  - Disable strict ad-blockers for http://localhost:3000.
  - Corporate proxies may interfere with streaming; try a different network.

---

## Environment variables (reference)
- `LLM_MODE`: `groq` or `ollama` (also accepts `openai-compatible`)
- `GROQ_API_KEY`: required for Groq
- `GROQ_MODEL`: e.g., `llama-3.1-8b-instant`
- `LLM_BASE_URL`: OpenAI-compatible base URL (Ollama in compose: `http://ollama:11434`)
- `LLM_MODEL`: local model name (e.g., `llama3.1:8b`)
- `DOCS_DIR`: defaults to `docs`
- `INDEX_DIR`: defaults to `storage`

Open http://localhost:3000 to use the app.
