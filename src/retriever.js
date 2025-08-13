import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { pipeline } from '@xenova/transformers';
import { htmlToText } from 'html-to-text';
import YAML from 'yaml';
import xlsx from 'xlsx';
import unzipper from 'unzipper';

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
  if (ext === '.html' || ext === '.htm') {
    const raw = await fs.readFile(filePath, 'utf-8');
    return htmlToText(raw, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] });
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.log' || ext === '.jsonl') {
    // Treat as plain text for simplicity
    return await fs.readFile(filePath, 'utf-8');
  }
  if (ext === '.json') {
    try {
      const obj = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      return JSON.stringify(obj, null, 2);
    } catch {
      return await fs.readFile(filePath, 'utf-8');
    }
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      const txt = await fs.readFile(filePath, 'utf-8');
      const obj = YAML.parse(txt);
      return JSON.stringify(obj, null, 2);
    } catch {
      return await fs.readFile(filePath, 'utf-8');
    }
  }
  if (ext === '.ipynb') {
    try {
      const nb = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const cells = Array.isArray(nb.cells) ? nb.cells : [];
      const parts = [];
      for (const cell of cells) {
        const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        if (cell.cell_type === 'markdown') {
          parts.push(src.trim());
        } else if (cell.cell_type === 'code') {
          const lang = (nb.metadata?.language_info?.name) || 'python';
          parts.push('```' + lang + '\n' + src.trim() + '\n```');
        }
      }
      return parts.join('\n\n');
    } catch {
      return await fs.readFile(filePath, 'utf-8');
    }
  }
  if (ext === '.xlsx') {
    try {
      const wb = xlsx.readFile(filePath, { cellDates: false });
      const sheets = wb.SheetNames || [];
      const chunks = [];
      for (const name of sheets) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        const tsv = xlsx.utils.sheet_to_csv(ws, { FS: '\t' });
        chunks.push(`# Sheet: ${name}\n${tsv}`.trim());
      }
      return chunks.join('\n\n');
    } catch {
      return '';
    }
  }
  if (ext === '.epub') {
    try {
      const text = await extractEpubText(filePath);
      return text;
    } catch {
      return '';
    }
  }
  if (ext === '.pptx') {
    try {
      const text = await extractPptxText(filePath);
      return text;
    } catch {
      return '';
    }
  }
  return '';
}

export async function listDocFiles(docDir = 'docs') {
  const base = path.resolve(docDir);
  const patterns = [
    '**/*.pdf',
    '**/*.docx',
    '**/*.md',
    '**/*.txt',
    '**/*.html', '**/*.htm',
    '**/*.csv', '**/*.tsv', '**/*.log', '**/*.jsonl',
    '**/*.json', '**/*.yaml', '**/*.yml',
    '**/*.ipynb',
    '**/*.xlsx',
    '**/*.epub',
    '**/*.pptx',
  ];
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

export async function embedTexts(texts, { onProgress } = {}) {
  const extractor = await getEmbedder();
  const embeddings = [];
  const YIELD_EVERY_N = Number(process.env.EMBED_YIELD_EVERY_N || 5);
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const out = await extractor(t, { pooling: 'mean', normalize: true });
    embeddings.push(Array.from(out.data));
    if ((i + 1) % LOG_EVERY_N_ITEMS === 0) {
      console.log(`[embed] processed ${i + 1}/${texts.length}`);
    }
    onProgress?.({ processed: i + 1, total: texts.length });
    if (YIELD_EVERY_N > 0 && (i + 1) % YIELD_EVERY_N === 0) {
      // Yield to event loop to allow status polling to respond during long embeddings
      await new Promise((r) => setTimeout(r, 0));
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

export async function searchIndex(query, k = 6, allowedSourcePaths = null) {
  const index = await loadIndex();
  if (!index.items.length) return [];
  const [qvec] = await embedTexts([query]);
  const allow = Array.isArray(allowedSourcePaths) && allowedSourcePaths.length
    ? new Set(allowedSourcePaths.map((p) => path.resolve(p)))
    : null;
  const candidates = allow
    ? index.items.filter((it) => allow.has(path.resolve(it.sourcePath)))
    : index.items;
  if (!candidates.length) return [];
  const scored = candidates.map((item) => ({ item, score: cosineSimilarity(qvec, item.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(k, scored.length));
}

export async function buildCorpusChunks(docDir = 'docs', { onProgress } = {}) {
  const files = await listDocFiles(docDir);
  const chunks = [];
  let chunkId = 0;
  const YIELD_EVERY_N = Number(process.env.BUILD_YIELD_EVERY_N || 50);
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
        onProgress?.({ processed: chunkId });
        if (YIELD_EVERY_N > 0 && chunkId % YIELD_EVERY_N === 0) {
          await new Promise((r) => setTimeout(r, 0));
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
        onProgress?.({ processed: chunkId });
        if (YIELD_EVERY_N > 0 && chunkId % YIELD_EVERY_N === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
  }
  console.log(`[build] total chunks: ${chunkId}`);
  return chunks;
}

export async function estimateCorpusChunks(docDir = 'docs') {
  const files = await listDocFiles(docDir);
  let total = 0;
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const pages = await extractPdfPages(filePath);
      total += pages.length;
    } else {
      const text = await loadTextFromFile(filePath);
      total += chunkText(text).length;
    }
  }
  return total;
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

async function extractEpubText(filePath) {
  const { default: EPUB } = await import('epub');
  return await new Promise((resolve, reject) => {
    try {
      const epub = new EPUB(filePath);
      const parts = [];
      epub.on('error', (err) => reject(err));
      epub.on('end', () => {
        const items = Array.isArray(epub.flow) ? epub.flow : [];
        if (!items.length) return resolve(parts.join('\n\n'));
        let done = 0;
        for (const it of items) {
          epub.getChapterRaw(it.id, (err, html) => {
            if (!err && html) {
              const txt = htmlToText(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] });
              parts.push(txt.trim());
            }
            done += 1;
            if (done === items.length) resolve(parts.join('\n\n'));
          });
        }
      });
      epub.parse();
    } catch (e) {
      reject(e);
    }
  });
}

async function extractPptxText(filePath) {
  const dir = await unzipper.Open.file(filePath);
  const slideFiles = dir.files
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f.path))
    .sort((a, b) => {
      const na = Number((a.path.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const nb = Number((b.path.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return na - nb;
    });
  const slides = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const entry = slideFiles[i];
    const buf = await entry.buffer();
    const xml = buf.toString('utf-8');
    const texts = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      texts.push(m[1]);
    }
    const slideText = texts.join(' ').replace(/[\s\u00A0]+/g, ' ').trim();
    if (slideText) slides.push(`Slide ${i + 1}:\n${slideText}`);
  }
  return slides.join('\n\n');
}
