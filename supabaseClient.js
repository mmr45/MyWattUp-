// MyWattUp — Client Supabase centralisé
// Importé par toutes les pages ayant besoin de la base de données / auth

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ⚠️ Remplace ces valeurs par celles de ton projet Supabase
// (Project Settings > API dans le dashboard Supabase)
const SUPABASE_URL = "https://vwodpdoloavliccnnenh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Y2RJWLROM9glPStk9TxVCw_DnkBM...";
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper : récupère l'utilisateur connecté, redirige vers /index.html sinon
export async function requireAuth() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    window.location.href = "/index.html";
    return null;
  }
  return session.user;
}

// Helper : déconnexion
export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = "/index.html";
}
