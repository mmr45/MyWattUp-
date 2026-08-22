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
  return data.user;
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
