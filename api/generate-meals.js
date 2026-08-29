export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { profile } = req.body;

  const prompt = `Génère un plan de repas sur 1 jour pour un profil ${profile.sport_type}, objectif ${profile.objective}, contraintes/allergies : ${profile.allergies || 'aucune'}.
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
    let raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return res.status(502).json({ error: 'Réponse IA vide' });

    raw = raw.replace(/```json|```/g, '').trim();

    let meals;
    try {
      meals = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'JSON invalide reçu de l\'IA' });
    }

    res.status(200).json({ meals });
  } catch (err) {
    res.status(500).json({ error: 'Erreur appel Groq' });
  }
}
