import { buildAndSaveIndex } from './retriever.js';

async function main() {
  const dir = process.env.DOCS_DIR || 'docs';
  const idx = await buildAndSaveIndex(dir);
  console.log(`Indexed ${idx.items.length} chunks from ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
