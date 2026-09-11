// api/_ai.js — appel au fournisseur IA, partagé par les endpoints.
// Le préfixe "_" empêche Vercel d'en faire une route publique.

// ---------------------------------------------------------------- provider
// Ordre de priorité : le premier dont la clé existe est utilisé.
export const PROVIDERS = [
  {
    name: 'anthropic',
    envs: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: (model, prompt) => ({ model, max_tokens: 2000, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
    extract: (d) => (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
  },
  {
    name: 'openai',
    envs: ['OPENAI_API_KEY'],
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (model, prompt) => ({ model, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
    extract: (d) => d.choices?.[0]?.message?.content || '',
  },
  {
    name: 'openrouter',
    envs: ['OPENROUTER_API_KEY'],
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4o-mini',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (model, prompt) => ({ model, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
    extract: (d) => d.choices?.[0]?.message?.content || '',
  },
  {
    name: 'mistral',
    envs: ['MISTRAL_API_KEY'],
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-large-latest',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (model, prompt) => ({ model, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
    extract: (d) => d.choices?.[0]?.message?.content || '',
  },
  {
    name: 'groq',
    envs: ['GROQ_API_KEY'],
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (model, prompt) => ({
      model,
      temperature: 1,
      max_completion_tokens: 4000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    extract: (d) => d.choices?.[0]?.message?.content || '',
  },
  {
    name: 'gemini',
    envs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    model: 'gemini-2.0-flash',
    headers: (key) => ({ 'x-goog-api-key': key }),
    body: (_model, prompt) => ({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1 } }),
    extract: (d) => d.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '',
  },
];

export function resolveProvider() {
  for (const p of PROVIDERS) {
    for (const envName of p.envs) {
      if (process.env[envName]) return { ...p, key: process.env[envName], envName };
    }
  }
  return null;
}

// ---------------------------------------------------------------- modèle
// Au-delà de ce délai, on n'attend pas : on renvoie le temps d'attente à l'utilisateur.
const MAX_AUTO_WAIT_S = 10;

export class RateLimitError extends Error {
  constructor(waitS) {
    super(`limite fournisseur atteinte, attendre ${waitS}s`);
    this.waitS = waitS;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// "5.289s", "1m3.5s", "520ms" -> secondes
function parseDuration(str) {
  let total = 0;
  const re = /([\d.]+)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(str))) {
    const v = Number(m[1]);
    total += m[2] === 'ms' ? v / 1000 : m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : v;
  }
  return total;
}

// Délai imposé par le fournisseur : message « try again in 5.2s » (précis),
// sinon en-tête retry-after, sinon 60 s par prudence.
function readRetryAfter(r, body) {
  const fromMsg = body.match(/try again in ([\dhms.]+)/i);
  if (fromMsg) {
    const s = parseDuration(fromMsg[1]);
    if (s > 0) return s;
  }
  const fromHeader = Number(r.headers.get('retry-after'));
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
  return 60;
}

// autoWait : si le fournisseur sature et que l'attente est courte, on attend
// puis on relance une fois, sans que l'utilisateur voie d'erreur.
export async function callModel(provider, prompt, { autoWait = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...provider.headers(provider.key) },
      body: JSON.stringify(provider.body(provider.model, prompt)),
    });

    if (r.status === 429) {
      const waitS = readRetryAfter(r, await r.text());
      if (autoWait && attempt === 0 && waitS <= MAX_AUTO_WAIT_S) {
        await sleep(Math.ceil((waitS + 0.5) * 1000));
        continue;
      }
      throw new RateLimitError(waitS);
    }

    if (!r.ok) {
      const body = await r.text();
      throw new Error(`${provider.name} ${r.status} : ${body.slice(0, 300)}`);
    }

    const text = provider.extract(await r.json());
    if (!text) throw new Error(`${provider.name} : réponse vide`);
    return text;
  }
}

export function formatWait(waitS) {
  const s = Math.max(1, Math.ceil(waitS));
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}
