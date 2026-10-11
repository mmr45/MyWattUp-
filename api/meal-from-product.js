// api/meal-from-product.js — compose UN repas autour d'un produit scanné.
//
// Sécurité (même logique que generate-meals / recipe) :
//  - le navigateur n'envoie que le code-barres, une quantité bornée, un créneau
//    et des cibles numériques bornées ; aucun texte libre n'atteint le prompt ;
//  - le produit est relu côté serveur sur OpenFoodFacts (nom, nutriments,
//    ingrédients), le profil est relu en base ;
//  - on exige que ce code-barres ait été scanné par l'utilisateur dans les
//    dernières 24 h : le nombre de repas proposés reste donc limité par le quota
//    de scans (5/jour en offre Gratuite) sans toucher aux quotas existants ;
//  - les calories/macros du produit sont calculées ici à partir de ses valeurs
//    réelles ; seule la partie « compléments » est estimée par le modèle.

import { createClient } from '@supabase/supabase-js';
import { sanitize } from './_quota.js';
import { resolveProvider, callModel, RateLimitError, formatWait } from './_ai.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLOTS = {
  petit_dej: { label: 'petit-déjeuner', share: 0.25 },
  dejeuner: { label: 'déjeuner', share: 0.4 },
  diner: { label: 'dîner', share: 0.35 },
  collation: { label: 'collation', share: 0.1 },
};

// Même table que côté navigateur : terme saisi par l'utilisateur -> tags OpenFoodFacts + mots.
const ALLERGEN_GROUPS = [
  { terms: ['lait', 'lactose', 'laitier', 'laitage', 'milk', 'dairy'], tags: ['en:milk'] },
  { terms: ['gluten', 'ble', 'seigle', 'orge', 'avoine'], tags: ['en:gluten'] },
  { terms: ['arachide', 'cacahuete', 'peanut'], tags: ['en:peanuts'] },
  { terms: ['fruit a coque', 'fruits a coque', 'noix', 'noisette', 'amande', 'pistache', 'cajou', 'pecan'], tags: ['en:nuts'] },
  { terms: ['oeuf', 'oeufs', 'egg'], tags: ['en:eggs'] },
  { terms: ['soja', 'soy'], tags: ['en:soybeans'] },
  { terms: ['poisson', 'fish'], tags: ['en:fish'] },
  { terms: ['crustace', 'crevette'], tags: ['en:crustaceans'] },
  { terms: ['mollusque'], tags: ['en:molluscs'] },
  { terms: ['celeri'], tags: ['en:celery'] },
  { terms: ['moutarde'], tags: ['en:mustard'] },
  { terms: ['sesame'], tags: ['en:sesame-seeds'] },
  { terms: ['sulfite'], tags: ['en:sulphur-dioxide-and-sulphites'] },
  { terms: ['lupin'], tags: ['en:lupin'] },
];

const norm = (t) => String(t || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/œ/g, 'oe');

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)));
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const r1 = (v) => Math.round(v * 10) / 10;

function cleanNeeds(needs) {
  if (!needs || typeof needs !== 'object') return null;
  const out = {
    kcal_jour: clampInt(needs.kcal_jour, 1200, 5000),
    proteines_g: clampInt(needs.proteines_g, 30, 400),
    glucides_g: clampInt(needs.glucides_g, 50, 900),
    lipides_g: clampInt(needs.lipides_g, 20, 300),
  };
  return Object.values(out).some(v => v === null) ? null : out;
}

// Retourne les allergènes du profil retrouvés dans le produit (liste de libellés).
function findAllergenHits(allergiesText, product) {
  const items = String(allergiesText || '')
    .split(/[,;\n/]+|\bet\b/i)
    .map(s => norm(s).replace(/^(sans|pas de|pas d'|no)\s+/, '').trim())
    .filter(s => s.length >= 3);
  if (!items.length) return [];

  const tagsText = norm([...(product.allergens_tags || []), ...(product.traces_tags || [])].join(' '));
  const haystack = norm(`${product.ingredients_text_fr || product.ingredients_text || ''} ${product.product_name || ''}`);
  const hits = new Set();

  for (const item of items) {
    const group = ALLERGEN_GROUPS.find(g => g.terms.some(t => item.includes(t) || t.includes(item)));
    if (group) {
      const found = group.tags.some(tag => tagsText.includes(norm(tag)))
        || group.terms.some(t => haystack.includes(t));
      if (found) hits.add(item);
    } else if (haystack.includes(item) || tagsText.includes(item)) {
      hits.add(item);
    }
  }
  return [...hits];
}

function productMacros(product, quantityG) {
  const n = product.nutriments || {};
  const ratio = quantityG / 100;
  let kcal100 = num(n['energy-kcal_100g']);
  if (kcal100 === null && num(n['energy_100g']) !== null) kcal100 = n['energy_100g'] / 4.184;
  const p100 = num(n.proteins_100g);
  const c100 = num(n.carbohydrates_100g);
  const f100 = num(n.fat_100g);
  if (kcal100 === null && p100 === null && c100 === null && f100 === null) return null;
  return {
    kcal: Math.round((kcal100 ?? 0) * ratio),
    proteines_g: r1((p100 ?? 0) * ratio),
    glucides_g: r1((c100 ?? 0) * ratio),
    lipides_g: r1((f100 ?? 0) * ratio),
  };
}

async function fetchProduct(barcode) {
  const fields = 'product_name,brands,nutriments,nutriscore_grade,nova_group,allergens_tags,traces_tags,ingredients_text,ingredients_text_fr';
  const r = await fetch(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`,
    { headers: { 'User-Agent': 'MyWattUp/1.0 (contact via site)' }, signal: AbortSignal.timeout(7000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data?.status === 1 ? data.product : null;
}

function buildPrompt({ product, name, quantityG, macros, profile, slot, target, avoid, seed }) {
  const cible = target
    ? `Cible approximative de ce ${slot.label} : ~${target.kcal} kcal, ~${target.proteines_g} g de protéines, ~${target.glucides_g} g de glucides, ~${target.lipides_g} g de lipides (le total produit + compléments doit s'en approcher à ±15 %).`
    : `Profil morphologique incomplet : vise un ${slot.label} réaliste (350-700 kcal selon le créneau).`;

  const grade = ['a', 'b', 'c', 'd', 'e'].includes(product.nutriscore_grade) ? product.nutriscore_grade.toUpperCase() : 'non renseigné';
  const nova = [1, 2, 3, 4].includes(Number(product.nova_group)) ? Number(product.nova_group) : 'non renseigné';
  const ingredients = sanitize(product.ingredients_text_fr || product.ingredients_text, 300) || 'non renseignés';

  return `Tu es diététicien. Compose UN ${slot.label} pour une seule personne, construit autour d'un produit déjà choisi.

PRODUIT DE DÉPART (quantité fixée, ne la modifie pas)
- Nom : ${name}${product.brands ? ` (${sanitize(product.brands, 60)})` : ''}
- Quantité retenue : ${quantityG} g → ${macros.kcal} kcal, ${macros.proteines_g} g de protéines, ${macros.glucides_g} g de glucides, ${macros.lipides_g} g de lipides (valeurs exactes)
- Nutri-score : ${grade} · NOVA : ${nova}
- Ingrédients : ${ingredients}

PROFIL
- Sport : ${profile.sport_type || 'non renseigné'}
- Objectif : ${profile.objective || 'non renseigné'}
- Allergies / exclusions : ${profile.allergies || 'aucune'}

${cible}

RÈGLES
1. Le produit reste l'élément central du repas. Ajoute de 2 à 5 compléments simples, trouvables en supermarché français, pour équilibrer : si le produit est sucré ou gras, ajoute protéines, fibres, fruits ou légumes ; s'il est pauvre en protéines, ajoute une source de protéines.
2. Aucun complément ne doit contenir un allergène ou une exclusion du profil, même en trace.
3. Quantités des compléments en grammes, aliments tels que mangés, avec kcal et macros pour la quantité indiquée (estimations réalistes).
4. 25 minutes maximum, de 2 à 5 étapes courtes, à l'impératif, en tutoyant.
5. Aucun complément alimentaire, aucun diagnostic, aucune allégation de santé, aucun commentaire sur le poids ou l'apparence.
6. Si le produit est un dessert ou un snack sucré, fais-en plutôt un petit-déjeuner ou une collation équilibrée qu'un plat salé forcé.
${avoid ? `7. Ne propose pas la même idée que : « ${avoid} ».\n` : ''}
Graine de variation : ${seed}

RÉPONSE
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises Markdown, à ce format exact :
{"nom":"", "complements":[{"nom":"","quantite_g":0,"kcal":0,"proteines_g":0,"glucides_g":0,"lipides_g":0}], "etapes":[""], "justification":""}
"justification" : une phrase qui explique pourquoi ce repas convient à ce profil.`;
}

function parseMeal(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error(`Réponse illisible : ${cleaned.slice(0, 200)}`);
  const m = JSON.parse(cleaned.slice(start, end + 1));

  const complements = (Array.isArray(m.complements) ? m.complements : [])
    .map(c => ({
      nom: sanitize(c?.nom, 60),
      quantite_g: clampInt(c?.quantite_g, 1, 600),
      kcal: clampInt(c?.kcal, 0, 1500),
      proteines_g: clampInt(c?.proteines_g, 0, 150),
      glucides_g: clampInt(c?.glucides_g, 0, 300),
      lipides_g: clampInt(c?.lipides_g, 0, 150),
    }))
    .filter(c => c.nom && c.quantite_g !== null && c.kcal !== null)
    .slice(0, 6)
    .map(c => ({ ...c, proteines_g: c.proteines_g ?? 0, glucides_g: c.glucides_g ?? 0, lipides_g: c.lipides_g ?? 0 }));

  const etapes = (Array.isArray(m.etapes) ? m.etapes : [])
    .map(e => sanitize(e, 300)).filter(Boolean).slice(0, 6);

  const nom = sanitize(m.nom, 80);
  if (!nom || !complements.length || etapes.length < 2) throw new Error('Repas incomplet');
  return { nom, complements, etapes, justification: sanitize(m.justification, 300) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const provider = resolveProvider();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !provider) {
    console.error('meal-from-product: configuration incomplète (Supabase ou clé IA manquante)');
    return res.status(500).json({ error: 'Service momentanément indisponible.' });
  }

  // ---- Authentification --------------------------------------------------
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Session manquante — reconnecte-toi.' });
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Session invalide — reconnecte-toi.' });

  // ---- Entrées : tout est validé / borné ---------------------------------
  const barcode = String(req.body?.barcode || '').trim();
  if (!/^[0-9]{6,14}$/.test(barcode)) return res.status(400).json({ error: 'Code-barres invalide.' });
  const quantityG = clampInt(req.body?.quantity_g, 5, 1000);
  if (quantityG === null) return res.status(400).json({ error: 'Quantité invalide.' });
  const slotKey = Object.prototype.hasOwnProperty.call(SLOTS, req.body?.meal_slot) ? req.body.meal_slot : 'dejeuner';
  const slot = SLOTS[slotKey];
  const needs = cleanNeeds(req.body?.needs);
  const avoid = sanitize(req.body?.avoid, 80);

  let step = 'init';
  try {
    // ---- Le produit doit avoir été scanné par cet utilisateur (24 h) -----
    step = 'scan';
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: scans, error: scanErr } = await supabaseAdmin
      .from('scanned_products')
      .select('id')
      .eq('user_id', user.id)
      .eq('barcode', barcode)
      .gte('scanned_at', since)
      .limit(1);
    if (scanErr) throw new Error(`scanned_products: ${scanErr.message}`);
    if (!scans?.length) {
      return res.status(403).json({ error: 'Scanne d\'abord ce produit pour en faire un repas.' });
    }

    // ---- Produit + profil relus côté serveur ----------------------------
    step = 'donnees';
    const [product, profileRow] = await Promise.all([
      fetchProduct(barcode),
      supabaseAdmin.from('profiles').select('sport_type, objective, allergies').eq('user_id', user.id).maybeSingle(),
    ]);
    if (!product) return res.status(404).json({ error: 'Produit introuvable sur OpenFoodFacts.' });
    if (profileRow.error) throw new Error(`profil: ${profileRow.error.message}`);

    const profile = {
      sport_type: sanitize(profileRow.data?.sport_type, 60),
      objective: sanitize(profileRow.data?.objective, 60),
      allergies: sanitize(profileRow.data?.allergies, 200),
    };

    const hits = findAllergenHits(profile.allergies, product);
    if (hits.length) {
      return res.status(422).json({
        error: `Ce produit contient ou peut contenir : ${hits.join(', ')}. Je ne crée pas de repas avec.`,
      });
    }

    const macros = productMacros(product, quantityG);
    if (!macros) {
      return res.status(422).json({ error: 'Valeurs nutritionnelles manquantes pour ce produit — impossible de composer un repas fiable.' });
    }

    const name = sanitize(product.product_name, 100) || 'Produit scanné';
    const target = needs ? {
      kcal: Math.round(needs.kcal_jour * slot.share),
      proteines_g: Math.round(needs.proteines_g * slot.share),
      glucides_g: Math.round(needs.glucides_g * slot.share),
      lipides_g: Math.round(needs.lipides_g * slot.share),
    } : null;

    // ---- Génération -------------------------------------------------------
    step = `modele:${provider.name}`;
    const seed = Math.random().toString(36).slice(2, 10);
    const meal = parseMeal(await callModel(provider, buildPrompt({
      product, name, quantityG, macros, profile, slot, target, avoid, seed,
    })));

    const totals = meal.complements.reduce((t, c) => ({
      kcal: t.kcal + c.kcal,
      proteines_g: t.proteines_g + c.proteines_g,
      glucides_g: t.glucides_g + c.glucides_g,
      lipides_g: t.lipides_g + c.lipides_g,
      quantite_g: t.quantite_g + c.quantite_g,
    }), { ...macros, quantite_g: quantityG });

    return res.status(200).json({
      meal: {
        nom: meal.nom,
        produit: { nom: name, quantite_g: quantityG, ...macros },
        complements: meal.complements,
        etapes: meal.etapes,
        justification: meal.justification,
        totaux: {
          kcal: Math.round(totals.kcal),
          proteines_g: r1(totals.proteines_g),
          glucides_g: r1(totals.glucides_g),
          lipides_g: r1(totals.lipides_g),
          quantite_g: Math.round(totals.quantite_g),
        },
        cible: target,
      },
    });
  } catch (err) {
    console.error('meal-from-product', step, err);
    if (err instanceof RateLimitError) {
      return res.status(503).json({ error: `Beaucoup de demandes en ce moment — réessaie dans ${formatWait(err.waitS)}.` });
    }
    return res.status(500).json({ error: 'Impossible de composer le repas — réessaie dans un instant.' });
  }
}
