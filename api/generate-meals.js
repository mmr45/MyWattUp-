// /api/generate-meals.js
// Endpoint Vercel (Node serverless function) — génère un plan de 3 repas
// (petit-déjeuner, déjeuner, dîner) personnalisé, en s'appuyant sur des
// repères nutritionnels reconnus (PNNS, ANSES, OMS) et en évitant de
// reproposer des repas déjà générés récemment pour l'utilisateur.
//
// Variables d'environnement attendues :
//   GROQ_API_KEY   -> clé API Groq (https://console.groq.com)
//   GROQ_MODEL     -> optionnel, ex. "llama-3.3-70b-versatile" (défaut ci-dessous)

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Repères nutritionnels utilisés pour ancrer le prompt. Garder ce bloc
// synchronisé avec les sources déjà citées ailleurs dans l'app (PNNS/ANSES).
const NUTRITION_GUIDELINES = `
Tu es un assistant nutritionnel. Tu dois t'appuyer strictement sur des repères
reconnus par les autorités de santé, notamment :

- PNNS (Programme National Nutrition Santé, Santé publique France) :
  structure en 3 repas/jour, "5 fruits et légumes par jour", privilégier les
  féculents complets, limiter les produits ultra-transformés, le sucre et le sel.
- ANSES (Agence nationale de sécurité sanitaire) : références nutritionnelles
  en macronutriments pour l'adulte (glucides ~40-55% de l'apport énergétique,
  lipides ~35-40%, protéines selon profil), et repères d'hydratation.
- OMS : limiter les sucres libres à moins de 10% de l'apport énergétique
  quotidien, le sel à moins de 5g/jour.
- Apport protéique adapté à l'activité physique : environ 0,83 g/kg/jour pour
  un adulte sédentaire (ANSES), et jusqu'à 1,2-2,0 g/kg/jour pour une personne
  pratiquant une activité sportive régulière selon l'intensité, cohérent avec
  les repères utilisés par des sociétés savantes en nutrition du sport.

Règles impératives :
1. Ne jamais inclure d'allergène déclaré par l'utilisateur.
2. Adapter l'équilibre calorique et protéique à l'objectif déclaré
   (perte de poids, prise de masse, maintien, performance sportive).
3. Ne PAS reproposer un repas listé dans "à éviter" (voir plus bas) —
   varier les familles d'aliments (céréales, légumineuses, protéines
   animales/végétales, légumes de saison) d'une génération à l'autre.
4. Rester réaliste et accessible (ingrédients courants, préparation simple).
5. Pour chaque repas, fournir une courte justification nutritionnelle
   reliée explicitement à un repère ci-dessus (PNNS, ANSES ou OMS), et
   indiquer la source utilisée dans le champ "source".

Ceci ne remplace pas l'avis d'un(e) diététicien(ne) ou d'un médecin,
en particulier en cas de pathologie, de grossesse, ou de trouble du
comportement alimentaire.
`.trim();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  try {
    const { profile = {}, previous_meals = [] } = req.body || {};
    const { sport_type, objective, allergies } = profile;

    if (!process.env.GROQ_API_KEY) {
      res.status(500).json({ error: 'Configuration serveur manquante (GROQ_API_KEY).' });
      return;
    }

    const avoidList = Array.isArray(previous_meals) && previous_meals.length > 0
      ? previous_meals.slice(0, 30).join(', ')
      : 'Aucun historique disponible.';

    const userPrompt = `
Profil utilisateur :
- Type de sport / activité : ${sport_type || 'non précisé'}
- Objectif : ${objective || 'non précisé'}
- Allergies / intolérances déclarées : ${allergies || 'aucune déclarée'}

Repas déjà générés récemment (à éviter absolument, propose autre chose) :
${avoidList}

Génère un plan pour aujourd'hui avec exactement 3 repas : petit-déjeuner,
déjeuner, dîner. Réponds UNIQUEMENT en JSON valide, sans texte autour, au
format suivant :

{
  "petit_dejeuner": { "nom": "...", "ingredients": ["..."], "justification": "...", "source": "PNNS | ANSES | OMS" },
  "dejeuner": { "nom": "...", "ingredients": ["..."], "justification": "...", "source": "PNNS | ANSES | OMS" },
  "diner": { "nom": "...", "ingredients": ["..."], "justification": "...", "source": "PNNS | ANSES | OMS" }
}
`.trim();

    // Normalisation pour comparaison stricte (accents/casse/espaces ignorés).
    const normalize = (s) => (s || '')
      .toString()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');

    // previous_meals peut arriver sous deux formes (compat ascendante) :
    // - ancien format : tableau de strings (noms uniquement)
    // - nouveau format : tableau de { name, ingredients }
    const previousList = Array.isArray(previous_meals) ? previous_meals : [];
    const normalizedPrevious = previousList.map(p => {
      if (typeof p === 'string') return { name: normalize(p), tokens: new Set() };
      const name = normalize(p.name);
      const tokens = extractIngredientTokens(p.ingredients || '');
      return { name, tokens };
    });
    const avoidSet = new Set(normalizedPrevious.map(p => p.name));
    const required = ['petit_dejeuner', 'dejeuner', 'diner'];

    // Seuil de similarité (Jaccard sur les tokens d'ingrédients) au-delà
    // duquel on considère un repas "trop proche" d'un repas déjà généré,
    // même si le nom diffère.
    const SIMILARITY_THRESHOLD = 0.6;

    function extractIngredientTokens(text) {
      // Le champ "ingredients" stocké côté frontend contient la
      // justification + éventuellement "Ingrédients : a, b, c" + "(Source : ...)".
      // On isole grossièrement les mots significatifs (>=4 lettres) comme
      // proxy des ingrédients/aliments mentionnés.
      return new Set(
        normalize(text)
          .replace(/\(source.*?\)/g, '')
          .split(/[^a-z0-9]+/)
          .filter(w => w.length >= 4)
      );
    }

    function jaccardSimilarity(setA, setB) {
      if (setA.size === 0 || setB.size === 0) return 0;
      let intersection = 0;
      for (const item of setA) if (setB.has(item)) intersection++;
      const union = setA.size + setB.size - intersection;
      return union === 0 ? 0 : intersection / union;
    }

    function isTooSimilar(candidateMeal) {
      const candidateTokens = extractIngredientTokens(
        Array.isArray(candidateMeal.ingredients)
          ? candidateMeal.ingredients.join(' ')
          : (candidateMeal.justification || '')
      );
      for (const past of normalizedPrevious) {
        if (past.tokens.size === 0) continue;
        const score = jaccardSimilarity(candidateTokens, past.tokens);
        if (score >= SIMILARITY_THRESHOLD) return true;
      }
      return false;
    }

    async function callGroq(extraInstruction) {
      const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.9, // un peu de hasard contrôlé -> aide à la variété
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: NUTRITION_GUIDELINES },
            { role: 'user', content: userPrompt + (extraInstruction ? `\n\n${extraInstruction}` : '') }
          ]
        })
      });

      if (!groqResp.ok) {
        const errText = await groqResp.text();
        console.error('Erreur Groq:', errText);
        return { error: 'Le service de génération est momentanément indisponible.' };
      }

      const groqData = await groqResp.json();
      const raw = groqData?.choices?.[0]?.message?.content;
      if (!raw) return { error: 'Réponse vide du modèle.' };

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error('JSON invalide reçu de Groq:', raw);
        return { error: 'Réponse du modèle mal formée.' };
      }
      return { meals: parsed };
    }

    // Jusqu'à 3 tentatives : si un repas généré matche exactement (nom
    // normalisé) un repas de l'historique à éviter, on redemande en
    // renforçant la consigne, plutôt que de faire confiance au modèle
    // du premier coup.
    const MAX_ATTEMPTS = 3;
    let meals = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const extra = attempt > 1
        ? `RAPPEL IMPORTANT : ta génération précédente contenait un repas déjà utilisé récemment, ce qui est interdit. Propose des repas totalement différents de la liste "à éviter", avec des ingrédients principaux différents.`
        : null;

      const result = await callGroq(extra);
      if (result.error) {
        lastError = result.error;
        continue;
      }

      const candidate = result.meals;
      const missing = required.filter(k => !candidate[k] || !candidate[k].nom);
      if (missing.length > 0) {
        lastError = `Repas manquants dans la réponse : ${missing.join(', ')}`;
        continue;
      }

      const exactDuplicates = required.filter(k => avoidSet.has(normalize(candidate[k].nom)));
      const similarDuplicates = required.filter(k => isTooSimilar(candidate[k]));
      const allDuplicates = [...new Set([...exactDuplicates, ...similarDuplicates])];

      if (allDuplicates.length > 0 && (avoidSet.size > 0 || normalizedPrevious.some(p => p.tokens.size > 0))) {
        lastError = `Repas trop proches de l'historique détectés (${allDuplicates.join(', ')}), nouvelle tentative...`;
        continue; // on retente
      }

      meals = candidate;
      break;
    }

    if (!meals) {
      res.status(502).json({ error: lastError || 'Impossible de générer un plan varié après plusieurs tentatives.' });
      return;
    }

    // Normalisation : ingredients peut arriver en tableau -> on le remet
    // en texte lisible dans la justification, pour rester compatible avec
    // le champ "ingredients" (texte) déjà utilisé côté frontend.
    for (const key of required) {
      const m = meals[key];
      if (Array.isArray(m.ingredients)) {
        m.justification = `${m.justification || ''}${m.justification ? ' — ' : ''}Ingrédients : ${m.ingredients.join(', ')}`.trim();
      }
    }

    res.status(200).json({ meals });
  } catch (err) {
    console.error('Erreur generate-meals:', err);
    res.status(500).json({ error: 'Erreur interne lors de la génération.' });
  }
};
