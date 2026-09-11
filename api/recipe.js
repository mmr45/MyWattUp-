// api/recipe.js — recette détaillée d'un repas.
//
// Générée à la première ouverture, puis gardée dans meals.recipe : un repas ne
// coûte qu'un seul appel IA, quel que soit le nombre de fois où on l'ouvre.
// Pas de quota dédié : le nombre de repas est déjà limité par la génération.
//
// Sécurité : le navigateur n'envoie que l'id du repas. Nom et ingrédients sont
// relus en base, et on vérifie que le repas appartient bien à l'utilisateur.

import { createClient } from '@supabase/supabase-js';
import { sanitize } from './_quota.js';
import { resolveProvider, callModel, RateLimitError, formatWait } from './_ai.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)));
}

const strList = (arr, maxItems, maxLen) => (Array.isArray(arr) ? arr : [])
  .map(x => sanitize(x, maxLen))
  .filter(Boolean)
  .slice(0, maxItems);

// Même contrôle pour une recette fraîche et pour une recette déjà en base
// (la colonne est modifiable par son propriétaire, on ne lui fait pas confiance).
function cleanRecipe(r) {
  if (!r || typeof r !== 'object') return null;
  const etapes = strList(r.etapes, 12, 400);
  if (etapes.length < 2) return null;
  return {
    preparation_min: clampInt(r.preparation_min, 0, 240),
    cuisson_min: clampInt(r.cuisson_min, 0, 480),
    ustensiles: strList(r.ustensiles, 8, 40),
    etapes,
    astuce: sanitize(r.astuce, 240),
  };
}

function buildPrompt(meal) {
  return `Tu es cuisinier. Écris la recette de ce plat pour UNE personne, avec exactement les ingrédients et quantités donnés.

PLAT : ${sanitize(meal.name, 120)}
INGRÉDIENTS : ${sanitize(meal.ingredients, 600) || 'non précisés'}

RÈGLES
1. N'ajoute aucun ingrédient, à part sel, poivre et eau.
2. Si un ingrédient est donné « cuit » (riz cuit, lentilles cuites…), indique dans l'étape le poids sec à faire cuire et comment le cuire.
3. De 3 à 8 étapes, dans l'ordre réel de préparation. Une action principale par étape.
4. Donne les repères utiles : durée, feu (doux, moyen, vif), température du four, signe de cuisson.
5. Phrases courtes, à l'impératif, en tutoyant. Pas de numéro au début des étapes.
6. Matériel courant d'une cuisine française.
7. Aucune allégation santé.

RÉPONSE
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises Markdown, à ce format exact :
{"preparation_min":0, "cuisson_min":0, "ustensiles":[""], "etapes":[""], "astuce":""}
"astuce" : une phrase pratique (gagner du temps, conserver, varier), ou "".`;
}

function parseRecipe(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error(`Réponse illisible : ${cleaned.slice(0, 200)}`);
  const recipe = cleanRecipe(JSON.parse(cleaned.slice(start, end + 1)));
  if (!recipe) throw new Error('Recette incomplète');
  return recipe;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const provider = resolveProvider();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !provider) {
    console.error('recipe: configuration incomplète (Supabase ou clé IA manquante)');
    return res.status(500).json({ error: 'Service momentanément indisponible.' });
  }

  // ---- Authentification --------------------------------------------------
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Session manquante — reconnecte-toi.' });
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Session invalide — reconnecte-toi.' });

  const mealId = String(req.body?.meal_id || '');
  if (!UUID_RE.test(mealId)) return res.status(400).json({ error: 'Repas inconnu.' });

  let step = 'lecture';
  try {
    // ---- Le repas, et la preuve qu'il est à cet utilisateur --------------
    const { data: meal, error: mealErr } = await supabaseAdmin
      .from('meals')
      .select('id, meal_plan_id, name, ingredients, recipe')
      .eq('id', mealId)
      .maybeSingle();
    if (mealErr) throw new Error(`meals: ${mealErr.message}`);
    if (!meal) return res.status(404).json({ error: 'Repas introuvable.' });

    const { data: plan, error: planErr } = await supabaseAdmin
      .from('meal_plans')
      .select('user_id')
      .eq('id', meal.meal_plan_id)
      .maybeSingle();
    if (planErr) throw new Error(`meal_plans: ${planErr.message}`);
    if (!plan || plan.user_id !== user.id) return res.status(404).json({ error: 'Repas introuvable.' });

    // ---- Déjà générée : on la renvoie telle quelle ------------------------
    const cached = cleanRecipe(meal.recipe);
    if (cached) return res.status(200).json({ recipe: cached });

    // ---- Première ouverture : génération puis sauvegarde -----------------
    step = `modele:${provider.name}`;
    const recipe = parseRecipe(await callModel(provider, buildPrompt(meal)));

    step = 'sauvegarde';
    const { error: upErr } = await supabaseAdmin.from('meals').update({ recipe }).eq('id', meal.id);
    if (upErr) console.error('recipe: sauvegarde', upErr.message); // la recette est quand même renvoyée

    return res.status(200).json({ recipe });
  } catch (err) {
    console.error('recipe', step, err);
    if (err instanceof RateLimitError) {
      return res.status(503).json({ error: `Beaucoup de demandes en ce moment — réessaie dans ${formatWait(err.waitS)}.` });
    }
    return res.status(500).json({ error: 'Impossible d\'écrire la recette — réessaie dans un instant.' });
  }
}
