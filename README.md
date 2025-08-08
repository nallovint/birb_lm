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
- Docker Desktop to be installed on the machine - follow your relevant instructions at [Docker Desktop](https://www.docker.com/products/docker-desktop/)

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

### 1. Groq (Online mode) Edit `.env` and uncomment `LLM_MODE=groq` and comment out `LLM_MODE=ollama`
```bash
GROQ_API_KEY=<YOUR_GROQ_KEY>
GROQ_MODEL=llama3-8b-8192 # see information below on how to get groq key and set model

# Choose ONE mode
# LLM_MODE=ollama
LLM_MODE=groq

# If using Ollama/local OpenAI-compatible
LLM_BASE_URL=http://ollama:11434
LLM_MODEL=llama3.2:1b
# LLM_MODEL=gemma2:2b     # alternate models
# LLM_MODEL=llama3.1:8b   # you can use
```

### 1. Ollama (Local mode) Edit `.env` and and uncomment `LLM_MODE=ollama` and comment out `LLM_MODE=groq`
```bash
GROQ_API_KEY=<YOUR_GROQ_KEY>
GROQ_MODEL=llama3-8b-8192 # see information below on how to get groq key and set model

# Choose ONE mode
LLM_MODE=ollama
# LLM_MODE=groq

# If using Ollama/local OpenAI-compatible
LLM_BASE_URL=http://ollama:11434
# LLM_MODEL=llama3.2:1b # comment this line
# LLM_MODEL=gemma2:2b    
LLM_MODEL=llama3.1:8b   # uncomment this line
```

### 2. Run

```bash
docker compose up -d
# next lines are only required if you are using a local LLM (Ollama)
docker compose exec ollama ollama pull llama3.1:8b # or another of the models listed above in Part 1
docker compose up -d --force-recreate app

# open http://localhost:3000
```
### (This command can also be used if you need to pull a new model)

### 3. Library creation

- Copy any PDF, DOCX or TXT files into `docs/`
- In the web UI, click the `Rebuild` button at the top to index

If you wish to see progress of this, run the following in a separate terminal window:
```bash
docker compose logs -f app
```
The UI will also show when indexing is complete and how many chunks were indexed. This is an abritrary value and only useful to the program.

### 4. Go to site

Head to [http://localhost:3000](http://localhost:3000)


### If you update the `.env`, you need to run this -
#### (You will also need to do this if you change the mode (step 1) above from Online -> Local or Local -> Online)

```bash
docker compose up -d --force-recreate app
```

---------------------

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
  ```

