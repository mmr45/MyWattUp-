// MyWattUp — Logique de la page Dashboard

import { supabase, requireAuth } from "/js/supabaseClient.js";

const user = await requireAuth();
if (user) {
  initDashboard(user);
}

async function initDashboard(user) {
  // Prénom / initiales pour l'accueil
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  const email = user.email || "";
  const initials = email.slice(0, 2).toUpperCase();
  document.getElementById("avatar").textContent = initials;
  document.getElementById("greeting").textContent = `Bonjour`;

  // Log du jour (créé automatiquement s'il n'existe pas encore)
  const today = new Date().toISOString().split("T")[0];

  const { data: log } = await supabase
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("log_date", today)
    .maybeSingle();

  if (log) {
    updateScoreRing(log.daily_score || 0);
    document.getElementById("sleep-value").textContent = log.sleep_score
      ? `${log.sleep_score}%`
      : "--";
    document.getElementById("activity-value").textContent = log.activity_score
      ? `${log.activity_score}%`
      : "--";
    document.getElementById("ai-tip").textContent =
      log.ai_recommendation || "Continue comme ça aujourd'hui !";
  } else {
    updateScoreRing(0);
  }
}

function updateScoreRing(score) {
  const circumference = 427; // 2 * PI * r(68)
  const offset = circumference - (score / 100) * circumference;
  document.getElementById("score-ring").style.strokeDashoffset = offset;
  document.getElementById("score-value").textContent = score;
}
