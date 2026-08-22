// onboarding.js
import { supabase } from './supabaseClient.js';
import { getCurrentUser } from './auth.js';

// ============================================
// CRÉER LE PROFIL (appelé à la fin de l'onboarding)
// ============================================
export async function createProfile({ sportType, objective, allergies, consentGiven }) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Aucun utilisateur connecté. Redirection vers /login.html requise.");
  }

  if (!consentGiven) {
    throw new Error("Le consentement à la politique de confidentialité est requis pour continuer.");
  }

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      user_id: user.id,
      sport_type: sportType,     // 'force' | 'endurance' | 'general'
      objective: objective,      // 'perte_de_poids' | 'prise_de_masse' | 'performance' | 'maintien' | 'recuperation'
      allergies: allergies || null,
      consent_given: true,
      consent_date: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("Erreur création profil :", error.message);
    throw error;
  }

  return data;
}

// ============================================
// EXEMPLE D'UTILISATION DANS onboarding.html
// ============================================
//
// <form id="onboardingForm">
//   <fieldset>
//     <legend>Ton sport</legend>
//     <label><input type="radio" name="sportType" value="force" required /> Force</label>
//     <label><input type="radio" name="sportType" value="endurance" /> Endurance</label>
//     <label><input type="radio" name="sportType" value="general" /> Général</label>
//   </fieldset>
//
//   <fieldset>
//     <legend>Ton objectif</legend>
//     <select name="objective" required>
//       <option value="perte_de_poids">Perte de poids</option>
//       <option value="prise_de_masse">Prise de masse</option>
//       <option value="performance">Performance</option>
//       <option value="maintien">Maintien</option>
//       <option value="recuperation">Récupération</option>
//     </select>
//   </fieldset>
//
//   <label>
//     Allergies / contraintes alimentaires (optionnel)
//     <textarea name="allergies" placeholder="ex. arachides, lactose..."></textarea>
//   </label>
//
//   <button type="submit">Valider mon profil</button>
// </form>
//
// <script type="module">
//   import { createProfile } from './onboarding.js';
//
//   document.getElementById('onboardingForm').addEventListener('submit', async (e) => {
//     e.preventDefault();
//     const formData = new FormData(e.target);
//
//     try {
//       await createProfile({
//         sportType: formData.get('sportType'),
//         objective: formData.get('objective'),
//         allergies: formData.get('allergies'),
//       });
//       window.location.href = '/dashboard.html';
//     } catch (err) {
//       alert("Erreur : " + err.message);
//     }
//   });
// </script>
