export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.GROQ_API_KEY) {
    console.error('[generate-meals] GROQ_API_KEY manquante dans les variables d\'environnement Vercel');
    return res.status(500).json({ error: 'Configuration serveur manquante' });
  }

  const profile = req.body?.profile || {};
  const sportType = profile.sport_type || 'général';
  const objective = profile.objective || 'maintien';
  const allergies = profile.allergies || 'aucune';

  const prompt = `Génère un plan de repas sur 1 jour pour un profil ${sportType}, objectif ${objective}, contraintes/allergies : ${allergies}.
Réponds UNIQUEMENT en JSON valide, sans texte autour, sans balises markdown, dans ce format exact :
{"petit_dejeuner": {"nom": "...", "calories": 0, "justification": "..."}, "dejeuner": {"nom": "...", "calories": 0, "justification": "..."}, "diner": {"nom": "...", "calories": 0, "justification": "..."}, "liste_courses": ["...", "..."]}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.7
      })
    });

    const data = await response.json();

    // On logge systématiquement les erreurs Groq (quota, clé invalide, modèle
    // décommissionné, etc.) au lieu de les avaler silencieusement — sinon
    // impossible de savoir pourquoi la génération échoue depuis les logs Vercel.
    if (!response.ok) {
      console.error('[generate-meals] Erreur Groq', response.status, JSON.stringify(data));
      return res.status(502).json({ error: `Erreur IA (${response.status})` });
    }

    let raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      console.error('[generate-meals] Réponse Groq sans contenu', JSON.stringify(data));
      return res.status(502).json({ error: 'Réponse IA vide' });
    }

    raw = raw.replace(/```json|```/g, '').trim();

    let meals;
    try {
      meals = JSON.parse(raw);
    } catch {
      console.error('[generate-meals] JSON invalide reçu de l\'IA :', raw);
      return res.status(502).json({ error: 'JSON invalide reçu de l\'IA' });
    }

    res.status(200).json({ meals });
  } catch (err) {
    console.error('[generate-meals] Erreur appel Groq', err);
    res.status(500).json({ error: 'Erreur appel Groq' });
  }
}
