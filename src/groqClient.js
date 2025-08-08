import 'dotenv/config';
import Groq from 'groq-sdk';

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

function getClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set.');
  return new Groq({ apiKey });
}

export async function chatComplete(messages, { model = DEFAULT_MODEL, temperature = 0.2, max_tokens = 800 } = {}) {
  const client = getClient();
  const res = await client.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
  });
  return res.choices?.[0]?.message?.content ?? '';
}

export { DEFAULT_MODEL };
