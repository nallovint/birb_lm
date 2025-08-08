# RAG Try – Groq or Local (OpenAI-compatible) LLM Document Chat (JavaScript)

This project indexes documents from the `docs/` directory and provides a lightweight web UI to discuss and analyze them using Groq or a local OpenAI-compatible LLM (e.g., Ollama, LM Studio, vLLM).

## Features
- Ingests and indexes documents from `docs/` (PDF, DOCX, MD, TXT)
- Local vector index (JSON) with `@xenova/transformers` embeddings (MiniLM)
- Retrieval-augmented chat using Groq models (default: `llama-3.1-8b-instant`) or a local OpenAI-compatible server
- Minimal web UI with rebuild-and-chat flow
- Cites sources

## Requirements
- Node.js 20+ (only if running locally without Docker)
- Either: a Groq API key, or a local OpenAI-compatible server (e.g., Ollama) running

## Quick start — Docker Compose

## Supported File Types
- `.pdf` (extracted via `pdfjs-dist`)
- `.docx` (via `mammoth`)
- `.md`, `.txt`

## How It Works
- Text is chunked with overlap, embedded using `Xenova/all-MiniLM-L6-v2`, and stored in `storage/index.json`.
- At chat time, the server retrieves the most relevant chunks, constructs a grounded prompt, and calls either:
  - Groq (via SDK) if `LLM_BASE_URL` is not set, or
  - Local OpenAI-compatible endpoint at `LLM_BASE_URL` (`/v1/chat/completions`) if provided.

Note: The app can auto-detect a local OpenAI-compatible server (Ollama) or use Groq. You can also force a mode via `.env` with `LLM_MODE=ollama` or `LLM_MODE=groq`.

You can run both the app and a local model via Docker Compose.

### Quick start

### 1. Edit `.env` and select ONE model (uncomment one):
```bash
LLM_MODE=ollama
# LLM_MODE=groq # if you are running remotely
LLM_BASE_URL=http://ollama:11434

LLM_MODEL=llama3.2:1b
# LLM_MODEL=gemma2:2b     # alternate models
# LLM_MODEL=llama3.1:8b   # you can use
```

### 2. Run

```bash
docker compose up -d
# only required if you are using a local LLM
docker compose exec ollama ollama pull llama3.1:8b 
# open http://localhost:3000
```
### (This command can also be used if you need to pull a new model)

### 3. Go to site

Head to [Link]http://localhost:3000


## If you have any issues

### Check that Ollama is running, if running locally

When using Docker Compose (bundled `ollama` service):

```bash
# Service status (look for ollama: Healthy)
docker compose ps

# Ollama logs
docker compose logs -f ollama

# HTTP health from host
curl -s http://localhost:11434/api/version | jq .

# From inside the ollama container
docker compose exec ollama ollama --version
docker compose exec ollama ollama list
docker compose exec ollama curl -s http://localhost:11434/v1/models | jq .
```

In the app UI, the header badge shows the active provider. It will display
“Local/OpenAI-compatible (http://ollama:11434)” when Ollama is reachable, or “Groq” when using the cloud API.

### View logs and indexing progress

You can watch the server logs to see indexing progress (e.g., messages like `[build] chunks so far:` and `[index] saved ...`).

- With Docker Compose:
  ```bash
  docker compose logs -f app
  # Trigger indexing from the UI (Rebuild index) or via CLI:
  docker compose exec app node src/ingest.js
  ```

- Local (without Docker):
  ```bash
  npm start      # shows logs in the terminal
  # Or run the ingest script directly:
  npm run ingest
  ```

### If you update the model, you need to run

```bash
docker compose up -d --force-recreate app
```


## Notes
- For larger corpora or higher performance, swap the JSON store for a vector DB (e.g., SQLite+vss, Qdrant, pgvector).
- If you change chunking or the embedding model, re-run ingestion.
