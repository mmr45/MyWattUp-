// shared-head.js
// Fichier UNIQUE qui injecte les balises favicon + PWA dans le <head>,
// et enregistre le service worker pour que l'app soit installable sur mobile.

document.head.insertAdjacentHTML('beforeend', `
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32">
  <link rel="icon" href="/icons/favicon-16.png" type="image/png" sizes="16x16">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="theme-color" content="#14161a">

  <!-- Réglages iOS : améliore l'affichage une fois ajouté à l'écran d'accueil -->
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="MyWattUp">
`);

// Enregistrement du service worker → nécessaire pour que Chrome/Android
// propose automatiquement "Installer l'application"
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Erreur enregistrement service worker :', err);
    });
  });
}
