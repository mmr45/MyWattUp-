import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { profile, dailyLog, userId, logDate } = req.body;

  const prompt = `Tu es un coach sportif/nutrition bienveillant et concret.
Profil : sport=${profile.sport_type}, objectif=${profile.objective}, contraintes=${profile.allergies || 'aucune'}.
Aujourd'hui : sommeil=${dailyLog.sleep_hours ?? '?'}h (qualité: ${dailyLog.sleep_quality ?? '?'}), activité=${dailyLog.activity_type ?? '?'} ${dailyLog.activity_duration_min ?? 0}min intensité ${dailyLog.activity_intensity ?? '?'}/10, forme ressentie ${dailyLog.mood_score ?? '?'}/10, score du jour=${dailyLog.daily_score ?? '?'}/100.
Donne un conseil personnalisé, 3-4 phrases max, actionnable pour aujourd'hui.`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
      })
    });

    const data = await response.json();
    console.log('Groq status:', response.status, 'Groq body:', JSON.stringify(data));

    const advice = data.choices?.[0]?.message?.content?.trim();
    if (!advice) return res.status(502).json({ error: 'Réponse IA vide', groqStatus: response.status, groqBody: data });

    await supabase.from('daily_logs')
      .update({ ai_recommendation: advice })
      .eq('user_id', userId)
      .eq('log_date', logDate);

    res.status(200).json({ advice });
  } catch (err) {
    console.error('Erreur fetch Groq:', err);
    res.status(500).json({ error: 'Erreur appel Groq', detail: err.message });
  }
}
