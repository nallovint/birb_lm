import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { pipeline } from '@xenova/transformers';

const INDEX_DIR = process.env.INDEX_DIR ? path.resolve(process.env.INDEX_DIR) : path.resolve('storage');
const INDEX_PATH = path.join(INDEX_DIR, 'index.json');

// Tunables
const PDF_MAX_CHARS = Number(process.env.PDF_MAX_CHARS || 4000); // limit per-page text length
const TXT_CHUNK_SIZE = Number(process.env.TXT_CHUNK_SIZE || 600); // words
const TXT_CHUNK_OVERLAP = Number(process.env.TXT_CHUNK_OVERLAP || 80); // words
const LOG_EVERY_N_ITEMS = Number(process.env.LOG_EVERY_N_ITEMS || 200);

let embedderPipeline = null; // feature-extraction

async function getEmbedder() {
  if (!embedderPipeline) {
    embedderPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPipeline;
}

async function extractPdfPages(filePath) {
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableRange: true,
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = content.items.map((it) => it.str).join(' ').trim();
    if (text.length > PDF_MAX_CHARS) text = text.slice(0, PDF_MAX_CHARS);
    pages.push({ pageNumber: i, text });
  }
  return pages;
}

export async function loadTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const pages = await extractPdfPages(filePath);
    return pages.map((p) => p.text).join('\n');
  }
  if (ext === '.docx') {
    const data = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer: data });
    return result.value || '';
  }
  if (ext === '.md' || ext === '.txt') {
    return await fs.readFile(filePath, 'utf-8');
  }
  return '';
}

export async function listDocFiles(docDir = 'docs') {
  const base = path.resolve(docDir);
  const patterns = ['**/*.pdf', '**/*.docx', '**/*.md', '**/*.txt'];
  const files = await fg(patterns, { cwd: base, dot: false, onlyFiles: true, absolute: true });
  return files;
}

export function chunkText(text, chunkSize = TXT_CHUNK_SIZE, overlap = TXT_CHUNK_OVERLAP) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(words.length, start + chunkSize);
    chunks.push(words.slice(start, end).join(' '));
    if (end === words.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export async function embedTexts(texts) {
  const extractor = await getEmbedder();
  const embeddings = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const out = await extractor(t, { pooling: 'mean', normalize: true });
    embeddings.push(Array.from(out.data));
    if ((i + 1) % LOG_EVERY_N_ITEMS === 0) {
      console.log(`[embed] processed ${i + 1}/${texts.length}`);
    }
  }
  return embeddings;
}

export async function ensureDirs() {
  await fs.mkdir(INDEX_DIR, { recursive: true });
}

export async function saveIndex(vectorIndex) {
  await ensureDirs();
  await fs.writeFile(INDEX_PATH, JSON.stringify(vectorIndex, null, 2), 'utf-8');
}

export async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { dim: 384, items: [] };
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function searchIndex(query, k = 6) {
  const index = await loadIndex();
  if (!index.items.length) return [];
  const [qvec] = await embedTexts([query]);
  const scored = index.items.map((item) => ({ item, score: cosineSimilarity(qvec, item.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(k, scored.length));
}

export async function buildCorpusChunks(docDir = 'docs') {
  const files = await listDocFiles(docDir);
  const chunks = [];
  let chunkId = 0;
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const pages = await extractPdfPages(filePath);
      for (const { pageNumber, text } of pages) {
        // exactly one chunk per page
        if (!text) continue;
        chunks.push({
          text,
          sourcePath: filePath,
          pageNumber,
          chunkId,
          tokenCount: text.split(/\s+/).length,
        });
        chunkId += 1;
        if (chunkId % LOG_EVERY_N_ITEMS === 0) {
          console.log(`[build] chunks so far: ${chunkId}`);
        }
      }
    } else {
      const text = await loadTextFromFile(filePath);
      const pieces = chunkText(text);
      for (const piece of pieces) {
        if (!piece) continue;
        chunks.push({
          text: piece,
          sourcePath: filePath,
          pageNumber: null,
          chunkId,
          tokenCount: piece.split(/\s+/).length,
        });
        chunkId += 1;
        if (chunkId % LOG_EVERY_N_ITEMS === 0) {
          console.log(`[build] chunks so far: ${chunkId}`);
        }
      }
    }
  }
  console.log(`[build] total chunks: ${chunkId}`);
  return chunks;
}

export async function buildAndSaveIndex(docDir = 'docs') {
  const chunks = await buildCorpusChunks(docDir);
  const texts = chunks.map((c) => c.text);
  const embeddings = texts.length ? await embedTexts(texts) : [];
  const dim = embeddings.length ? embeddings[0].length : 384;
  const items = chunks.map((c, i) => ({
    vector: embeddings[i] ?? new Array(dim).fill(0),
    text: c.text,
    sourcePath: c.sourcePath,
    pageNumber: c.pageNumber,
    chunkId: c.chunkId,
    tokenCount: c.tokenCount,
  }));
  const index = { dim, items };
  await saveIndex(index);
  console.log(`[index] saved ${items.length} items to ${INDEX_PATH}`);
  return index;
}
