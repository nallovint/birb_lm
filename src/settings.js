import fs from 'node:fs/promises';
import path from 'node:path';

const STORAGE_DIR = process.env.INDEX_DIR ? path.resolve(process.env.INDEX_DIR) : path.resolve('storage');
const SETTINGS_PATH = path.join(STORAGE_DIR, 'settings.json');

let cachedSettings = null;
let settingsVersion = 0;

const DEFAULT_SETTINGS = {
  aiProvider: (process.env.LLM_MODE || '').toLowerCase() === 'groq' ? 'groq' : 'ollama',
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  },
  ollama: {
    url: process.env.LLM_BASE_URL || 'http://ollama:11434',
    model: process.env.LLM_MODEL || 'llama3.1:8b',
  },
  documents: {
    defaultSelection: [],
    uploadPath: '/app/docs/',
  },
  lastUpdated: new Date().toISOString(),
};

async function ensureStorageDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

export async function loadSettings() {
  if (cachedSettings) return { ...cachedSettings };
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    cachedSettings = JSON.parse(data);
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
    await saveSettings(cachedSettings);
  }
  return { ...cachedSettings };
}

export async function saveSettings(next) {
  await ensureStorageDir();
  const current = cachedSettings || { ...DEFAULT_SETTINGS };
  const merged = {
    ...current,
    ...next,
    groq: { ...current.groq, ...(next?.groq || {}) },
    ollama: { ...current.ollama, ...(next?.ollama || {}) },
    documents: { ...current.documents, ...(next?.documents || {}) },
    lastUpdated: new Date().toISOString(),
  };
  // Do not erase API key if not explicitly included
  if (next?.groq?.apiKey === undefined) merged.groq.apiKey = current.groq.apiKey;
  cachedSettings = merged;
  settingsVersion += 1;
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return { ...merged };
}

export function getSettingsVersion() {
  return settingsVersion;
}


