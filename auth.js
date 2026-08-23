// auth.js
import { supabase } from './supabaseClient.js';

// ============================================
// INSCRIPTION
// ============================================
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    console.error("Erreur inscription :", error.message);
    throw error;
  }

  // data.user existe même si email non confirmé (selon config Supabase)
  const user = data.user;

  // Crée la ligne de profil avec un avatar aléatoire dès l'inscription.
  if (user) {
    const avatarSeed = user.id + '-' + Date.now();
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ user_id: user.id, avatar_seed: avatarSeed }, { onConflict: 'user_id' });

    if (profileError) {
      // On ne bloque pas l'inscription pour ça, mais on log l'erreur.
      console.error("Erreur création avatar par défaut :", profileError.message);
    }
  }

  return user;
}

// ============================================
// CONNEXION
// ============================================
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error("Erreur connexion :", error.message);
    throw error;
  }

  return data.user;
}

// ============================================
// DÉCONNEXION
// ============================================
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error("Erreur déconnexion :", error.message);
}

// ============================================
// RÉCUPÉRER L'UTILISATEUR CONNECTÉ (session actuelle)
// ============================================
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ============================================
// GARANTIR L'EXISTENCE D'UN PROFIL (avec avatar + pseudo par défaut)
// Utile en filet de sécurité si la ligne profiles n'a pas été créée à l'inscription.
// ============================================
export async function ensureProfile(user) {
  const { data: existing, error: fetchError } = await supabase
    .from('profiles')
    .select('username, avatar_seed, avatar_url, sport_type, objective, allergies')
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchError) {
    console.error("Erreur vérification profil :", fetchError.message);
  }

  if (existing) return existing;

  const avatarSeed = user.id + '-' + Date.now();
  const { data: created, error: upsertError } = await supabase
    .from('profiles')
    .upsert({ user_id: user.id, avatar_seed: avatarSeed }, { onConflict: 'user_id' })
    .select('username, avatar_seed, avatar_url, sport_type, objective, allergies')
    .single();

  if (upsertError) {
    console.error("Erreur création profil par défaut :", upsertError.message);
    throw upsertError;
  }

  return created;
}

// ============================================
// VÉRIFIER SI L'UTILISATEUR A DÉJÀ UN PROFIL
// (utile pour rediriger vers onboarding ou dashboard)
// ============================================
export async function hasProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error("Erreur vérification profil :", error.message);
    return false;
  }

  return !!data;
}

// ============================================
// EXEMPLE D'UTILISATION DANS UNE PAGE HTML
// ============================================
//
// <form id="loginForm">
//   <input type="email" id="email" required />
//   <input type="password" id="password" required />
//   <button type="submit">Se connecter</button>
// </form>
//
// <script type="module">
//   import { signIn, hasProfile } from './auth.js';
//
//   document.getElementById('loginForm').addEventListener('submit', async (e) => {
//     e.preventDefault();
//     const email = document.getElementById('email').value;
//     const password = document.getElementById('password').value;
//
//     try {
//       const user = await signIn(email, password);
//       const profileExists = await hasProfile(user.id);
//       window.location.href = profileExists ? '/dashboard.html' : '/onboarding.html';
//     } catch (err) {
//       alert("Connexion impossible : " + err.message);
//     }
//   });
// </script>
