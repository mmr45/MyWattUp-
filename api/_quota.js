// api/_quota.js — quota IA partagé par les 3 endpoints.
// Le préfixe "_" empêche Vercel d'en faire une route publique.
//
// consumeQuota() vérifie ET enregistre l'appel en base AVANT l'appel IA
// (fonction SQL consume_ai_quota, atomique). Le navigateur n'écrit plus rien.

export async function consumeQuota(supabaseAdmin, userId, kind) {
  const { data, error } = await supabaseAdmin.rpc('consume_ai_quota', {
    p_user_id: userId,
    p_kind: kind,
  });
  if (error) throw new Error(`consume_ai_quota: ${error.message}`);
  return data; // id de la ligne ai_usage, ou null si quota atteint
}

// Rend le crédit si le fournisseur IA a échoué (panne, timeout) : l'utilisateur
// ne doit pas perdre son essai du jour pour une erreur qui n'est pas la sienne.
export async function refundQuota(supabaseAdmin, usageId) {
  if (!usageId) return;
  const { error } = await supabaseAdmin.from('ai_usage').delete().eq('id', usageId);
  if (error) console.error('refundQuota:', error.message);
}

// Les champs libres (profil, description) sont des données hostiles vis-à-vis
// du modèle : on neutralise sauts de ligne et marqueurs de rôle, et on borne.
export function sanitize(value, maxLen = 200) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/```/g, '')
    .replace(/\b(system|assistant|user)\s*:/gi, '')
    .trim()
    .slice(0, maxLen);
}

export function parisToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}
