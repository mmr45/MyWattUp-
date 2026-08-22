// MyWattUp — Enregistrement du service worker
// À inclure sur toutes les pages via <script type="module" src="/js/pwa.js"></script>

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("Service worker enregistré :", reg.scope))
      .catch((err) => console.error("Échec service worker :", err));
  });
}

// Capture de l'événement d'installation PWA (Android/Chrome)
let deferredPrompt;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;

  // Affiche un bouton d'installation personnalisé si présent sur la page
  const installBtn = document.getElementById("install-btn");
  if (installBtn) {
    installBtn.hidden = false;
    installBtn.addEventListener("click", async () => {
      installBtn.hidden = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });
  }
});
