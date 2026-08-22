// MyWattUp — Authentification (connexion / inscription)

import { supabase } from "/js/supabaseClient.js";

const form = document.getElementById("auth-form");
const errorMsg = document.getElementById("error-msg");
const signupBtn = document.getElementById("signup-btn");

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.style.display = "block";
}

// Connexion
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMsg.style.display = "none";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showError("Email ou mot de passe incorrect.");
    return;
  }

  window.location.href = "/dashboard.html";
});

// Inscription
signupBtn.addEventListener("click", async () => {
  errorMsg.style.display = "none";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!email || !password) {
    showError("Renseigne un email et un mot de passe.");
    return;
  }

  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    showError(error.message);
    return;
  }

  // Redirection vers l'onboarding (création du profil sportif)
  window.location.href = "/onboarding.html";
});
