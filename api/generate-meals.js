// api/generate-meals.js — version diagnostique
//
// Différences avec la version précédente :
//  - accepte plusieurs noms possibles pour les variables d'environnement
//  - vérifie leur présence AVANT tout appel réseau et dit lesquelles manquent
//  - renvoie le message d'erreur réel dans "detail" (à retirer une fois réglé)

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.PUBLIC_SUPABASE_URL;

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SERVICE_ROLE_KEY;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const MEAL_KEYS = ['petit_dejeuner', 'dejeuner', 'diner'];

function missingEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

// ---------------------------------------------------------------- helpers
async function getUserFromToken(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function countPlansForDate(userId, planDate) {
  const url = `${SUPABASE_URL}/rest/v1/meal_plans?user_id=eq.${userId}&plan_date=eq.${planDate}&select=id`;
  const r = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: 'count=exact' },
  });
  const range = r.headers.get('content-range') || '*/0';
  return parseInt(range.split('/')[1] || '0', 10);
}

async function isPro(userId) {
  const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=plan`;
  const r = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] && rows[0].plan === 'pro';
}

// ---------------------------------------------------------------- prompt
function buildPrompt({ profile, needs, previousMeals, planDate, seed }) {
  const banned = (previousMeals || [])
    .slice(-90)
    .map(m => `- ${m.name}${m.ingredients ? ` (${String(m.ingredients).slice(0, 90)})` : ''}`)
    .join('\n') || '(aucun — première génération)';

  const cibles = needs
    ? `Cibles du jour (calculées à partir de sa taille, son poids, son âge, son sexe, son niveau d'activité et son objectif) :
- Énergie totale : ${needs.kcal_jour} kcal
- Protéines : ${needs.proteines_g} g
- Glucides : ${needs.glucides_g} g
- Lipides : ${needs.lipides_g} g
Répartition attendue : petit-déjeuner ~25 %, déjeuner ~40 %, dîner ~35 % de l'énergie.
La somme des kcal des 3 repas doit tomber à ±7 % de la cible.`
    : `Profil morphologique incomplet : vise un total réaliste de 1900-2300 kcal sur les 3 repas et signale-le brièvement dans la justification du petit-déjeuner.`;

  return `Tu es diététicien. Tu composes les 3 repas du ${planDate} pour une seule personne.

PROFIL
- Sport : ${profile?.sport_type || 'non renseigné'}
- Objectif : ${profile?.objective || 'non renseigné'}
- Niveau d'activité : ${profile?.activity_level || 'non renseigné'}
- Allergies / exclusions : ${profile?.allergies || 'aucune'}

${cibles}

REPAS DÉJÀ PROPOSÉS À CETTE PERSONNE (21 derniers jours) — INTERDITS
${banned}

RÈGLES DE VARIÉTÉ (les plus importantes)
1. Aucun repas ne doit reprendre un plat de la liste interdite, ni une simple variante (même protéine + même féculent + même mode de cuisson = variante, donc interdit).
2. Les 3 repas du jour doivent utiliser 3 sources de protéines différentes et 3 féculents/bases différents.
3. Change de registre culinaire par rapport aux derniers jours.
4. Varie les modes de cuisson (poêlé, vapeur, four, cru, mijoté) et les textures.
5. Aucune allergie ni exclusion ne doit apparaître, même en trace.
6. Repas réalistes, ingrédients trouvables en supermarché français, 25 min de préparation max.

Graine de variation (utilise-la pour t'écarter de tes réponses habituelles) : ${seed}

RÉPONSE
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises Markdown, à ce format exact :
{
  "petit_dejeuner": {"nom":"", "ingredients":["",""], "kcal":0, "proteines_g":0, "glucides_g":0, "lipides_g":0, "justification":"", "source":""},
  "dejeuner": {"nom":"", "ingredients":["",""], "kcal":0, "proteines_g":0, "glucides_g":0, "lipides_g":0, "justification":"", "source":""},
  "diner": {"nom":"", "ingredients":["",""], "kcal":0, "proteines_g":0, "glucides_g":0, "lipides_g":0, "justification":"", "source":""}
}
"justification" : une phrase reliant explicitement le repas au profil et aux cibles.
"source" : un repère public reconnu (PNNS, ANSES, OMS) ou "".`;
}

// ---------------------------------------------------------------- modèle
async function callModel(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`API modèle ${r.status} : ${body.slice(0, 300)}`);
  }

  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseMeals(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Réponse illisible : ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  for (const k of MEAL_KEYS) {
    if (!parsed[k] || !parsed[k].nom) throw new Error(`Repas manquant : ${k}`);
  }
  return parsed;
}

function hasDuplicate(meals, previousMeals) {
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ')
    .split(/\s+/).filter(w => w.length > 3);
  const past = (previousMeals || []).map(m => new Set(norm(m.name)));
  return MEAL_KEYS.some((k) => {
    const words = norm(meals[k].nom);
    if (!words.length) return false;
    return past.some((set) => words.filter(w => set.has(w)).length / words.length >= 0.6);
  });
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // 1) Variables d'environnement — cause n°1 des 500 après un déploiement.
  const missing = missingEnv();
  if (missing.length) {
    return res.status(500).json({
      error: 'Configuration serveur incomplète.',
      detail: `Variables manquantes sur Vercel : ${missing.join(', ')}`,
    });
  }

  let step = 'init';
  try {
    step = 'auth';
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Session manquante — reconnecte-toi.' });

    const authUser = await getUserFromToken(token);
    if (!authUser || !authUser.id) return res.status(401).json({ error: 'Session invalide — reconnecte-toi.' });

    const body = req.body || {};
    const { profile = {}, needs = null, previous_meals = [], seed = '' } = body;
    const planDate = body.plan_date || new Date().toISOString().slice(0, 10);

    step = 'quota';
    if (!(await isPro(authUser.id))) {
      const used = await countPlansForDate(authUser.id, planDate);
      if (used >= 1) {
        return res.status(429).json({ error: "Tu as déjà généré tes repas aujourd'hui — passe en Pro pour régénérer à volonté." });
      }
    }

    step = 'modele';
    const raw = await callModel(buildPrompt({ profile, needs, previousMeals: previous_meals, planDate, seed }));

    step = 'parse';
    let meals = parseMeals(raw);

    step = 'retry';
    if (hasDuplicate(meals, previous_meals)) {
      try {
        meals = parseMeals(await callModel(buildPrompt({
          profile, needs, planDate,
          seed: `${seed}-retry-${Date.now()}`,
          previousMeals: [...previous_meals, ...MEAL_KEYS.map(k => ({ name: meals[k].nom, ingredients: '' }))],
        })));
      } catch (_) { /* on garde la 1re version */ }
    }

    return res.status(200).json({ meals });
  } catch (err) {
    console.error('generate-meals', step, err);
    return res.status(500).json({
      error: 'Erreur lors de la génération — réessaie dans un instant.',
      detail: `[${step}] ${err && err.message ? err.message : String(err)}`,
    });
  }
}
