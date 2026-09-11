// api/generate-meals.js — génère les 3 repas du jour
//
// Sécurité : tout le contenu du prompt est relu en base (profil, historique).
// Du navigateur, on n'accepte que les cibles nutritionnelles, bornées en
// nombres. Le quota est décompté en base AVANT l'appel IA (ai_usage).

import { createClient } from '@supabase/supabase-js';
import { consumeQuota, refundQuota, sanitize, parisToday } from './_quota.js';
import { resolveProvider, callModel, RateLimitError, formatWait } from './_ai.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MEAL_KEYS = ['petit_dejeuner', 'dejeuner', 'diner'];

// ---------------------------------------------------------------- données
function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)));
}

// Seules des valeurs numériques bornées passent : aucun texte libre du
// navigateur n'atteint le prompt.
function cleanNeeds(needs) {
  if (!needs || typeof needs !== 'object') return null;
  const out = {
    kcal_jour: clampInt(needs.kcal_jour, 1200, 5000),
    proteines_g: clampInt(needs.proteines_g, 30, 400),
    glucides_g: clampInt(needs.glucides_g, 50, 900),
    lipides_g: clampInt(needs.lipides_g, 20, 300),
    contexte: sanitize(needs.contexte, 60),
  };
  if ([out.kcal_jour, out.proteines_g, out.glucides_g, out.lipides_g].some(v => v === null)) return null;
  return out;
}

async function loadProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('sport_type, objective, activity_level, allergies')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`profil: ${error.message}`);
  return {
    sport_type: sanitize(data?.sport_type, 60),
    objective: sanitize(data?.objective, 60),
    activity_level: sanitize(data?.activity_level, 40),
    allergies: sanitize(data?.allergies, 200),
  };
}

// Repas des 21 derniers jours, relus en base (plus depuis le navigateur).
async function loadPreviousMeals(userId) {
  const cutoff = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
  const { data: plans, error } = await supabaseAdmin
    .from('meal_plans')
    .select('id')
    .eq('user_id', userId)
    .gte('plan_date', cutoff);
  if (error) throw new Error(`meal_plans: ${error.message}`);
  if (!plans?.length) return [];

  const { data: meals, error: mErr } = await supabaseAdmin
    .from('meals')
    .select('name, ingredients')
    .in('meal_plan_id', plans.map(p => p.id));
  if (mErr) throw new Error(`meals: ${mErr.message}`);

  return (meals || [])
    .filter(m => m.name)
    .map(m => ({ name: sanitize(m.name, 80), ingredients: sanitize(m.ingredients, 90) }));
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
La somme des kcal des 3 repas doit tomber à ±7 % de la cible.${needs.contexte ? `
Contexte du jour : ${String(needs.contexte).slice(0, 80)}. Les cibles ci-dessus en tiennent déjà compte — n'ajoute aucune correction supplémentaire, adapte seulement le choix des aliments (glucides plus présents après une grosse séance, repas plus légers un jour calme).` : ''}`
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
7. Les cibles ci-dessus sont un plancher autant qu'un plafond : ne propose jamais
   une journée nettement en dessous (pas de jeûne, pas de repas sauté, pas de
   mono-diète), et n'ajoute aucun complément alimentaire.
8. Tu n'es pas médecin : aucun diagnostic, aucune allégation de santé, aucun
   commentaire sur le poids ou l'apparence de la personne.

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

function parseMeals(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Réponse tronquée ou illisible (${cleaned.length} car.) : ${cleaned.slice(0, 200)}`);
  }
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

  const provider = resolveProvider();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !provider) {
    console.error('generate-meals: configuration incomplète (Supabase ou clé IA manquante)');
    return res.status(500).json({ error: 'Service momentanément indisponible.' });
  }

  // ---- Authentification (avant tout le reste) ---------------------------
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Session manquante — reconnecte-toi.' });

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Session invalide — reconnecte-toi.' });

  let step = 'init';
  let usageId = null;
  try {
    // ---- Quota : décompté en base AVANT l'appel IA ----------------------
    step = 'quota';
    usageId = await consumeQuota(supabaseAdmin, user.id, 'meals');
    if (!usageId) {
      return res.status(429).json({ error: "Tu as déjà généré tes repas aujourd'hui — passe en Pro pour régénérer à volonté." });
    }

    // ---- Données : relues en base, jamais prises du navigateur ----------
    step = 'donnees';
    const [profile, previousMeals] = await Promise.all([
      loadProfile(user.id),
      loadPreviousMeals(user.id),
    ]);
    const needs = cleanNeeds(req.body?.needs);
    const planDate = parisToday();
    const seed = `${planDate}-${Math.random().toString(36).slice(2, 10)}`;

    step = `modele:${provider.name}`;
    const raw = await callModel(provider, buildPrompt({ profile, needs, previousMeals, planDate, seed }));

    step = 'parse';
    let meals = parseMeals(raw);

    step = 'retry';
    if (hasDuplicate(meals, previousMeals)) {
      try {
        meals = parseMeals(await callModel(provider, buildPrompt({
          profile, needs, planDate,
          seed: `${seed}-retry-${Date.now()}`,
          previousMeals: [...previousMeals, ...MEAL_KEYS.map(k => ({ name: meals[k].nom, ingredients: '' }))],
        }), { autoWait: false }));
      } catch (_) { /* on garde la 1re version */ }
    }

    return res.status(200).json({ meals });
  } catch (err) {
    // Le détail reste dans les logs Vercel, jamais dans la réponse.
    console.error('generate-meals', step, err);
    await refundQuota(supabaseAdmin, usageId);
    if (err instanceof RateLimitError) {
      return res.status(503).json({
        error: `Beaucoup de demandes en ce moment — réessaie dans ${formatWait(err.waitS)}.`,
      });
    }
    return res.status(500).json({ error: 'Erreur lors de la génération — réessaie dans un instant.' });
  }
}
