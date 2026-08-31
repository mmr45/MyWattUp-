import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ---- Authentification -----------------------------------------------
  // Cet endpoint écrit avec la clé service role (donc sans RLS) : il doit
  // impérativement vérifier qui appelle avant d'écrire quoi que ce soit.
  // On récupère le JWT envoyé par le front (Authorization: Bearer <token>)
  // et on en déduit le vrai user_id — jamais celui fourni dans le body,
  // qui pourrait être falsifié par n'importe quel appelant.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
  const userId = user.id;

  // ---- Validation des données -------------------------------------------
  const { profile, dailyLog, logDate } = req.body || {};
  if (!profile || !dailyLog || !logDate) {
    return res.status(400).json({ error: 'Paramètres manquants (profile, dailyLog, logDate requis).' });
  }

  const prompt = `Tu es un coach sportif/nutrition bienveillant et concret.
Profil : sport=${profile.sport_type}, objectif=${profile.objective}, contraintes=${profile.allergies || 'aucune'}.
Aujourd'hui : sommeil=${dailyLog.sleep_hours ?? '?'}h (qualité: ${dailyLog.sleep_quality ?? '?'}), activité=${dailyLog.activity_type ?? '?'} ${dailyLog.activity_duration_min ?? 0}min intensité ${dailyLog.activity_intensity ?? '?'}/10, forme ressentie ${dailyLog.mood_score ?? '?'}/10, score du jour=${dailyLog.daily_score ?? '?'}/100.
Donne un conseil personnalisé, 3-4 phrases max, actionnable pour aujourd'hui.`;

  try {
    // Timeout explicite : sans ça, un Groq lent peut faire tourner la fonction
    // jusqu'à la limite d'exécution Vercel, avec une erreur peu claire au bout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
          "User-Agent": "MyWattUp/1.0"
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq a répondu en erreur:', response.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Erreur API Groq', groqStatus: response.status, groqBody: data });
    }

    const advice = data.choices?.[0]?.message?.content?.trim();
    if (!advice) {
      console.error('Réponse Groq vide:', JSON.stringify(data));
      return res.status(502).json({ error: 'Réponse IA vide', groqBody: data });
    }

    // ---- Écriture en base, avec vérification de l'erreur --------------
    // C'était le vrai bug : avant, une erreur ici n'était jamais détectée,
    // et l'endpoint renvoyait 200 même si le conseil n'était pas enregistré.
    const { error: updateError } = await supabaseAdmin
      .from('daily_logs')
      .update({ ai_recommendation: advice })
      .eq('user_id', userId)
      .eq('log_date', logDate);

    if (updateError) {
      console.error('Échec de l\'enregistrement du conseil en base:', updateError);
      return res.status(500).json({ error: 'Conseil généré mais non enregistré.', detail: updateError.message });
    }

    return res.status(200).json({ advice });
  } catch (err) {
    console.error('Erreur fetch Groq:', err);
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'Délai dépassé lors de l\'appel à Groq' : 'Erreur appel Groq',
      detail: err.message
    });
  }
}
