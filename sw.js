// MyWattUp — Service Worker
// Gère le cache pour l'installation PWA et un fonctionnement minimal hors-ligne

const CACHE_NAME = "mywattup-cache-v1";

// Fichiers statiques mis en cache dès l'installation
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/dashboard.html",
  "/journal.html",
  "/repas.html",
  "/scanner.html",
  "/profil.html",
  "/css/style.css",
  "/js/supabaseClient.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Installation : mise en cache des fichiers de base
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activation : nettoyage des anciens caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Stratégie : network first, fallback sur le cache si hors-ligne
// (les données Supabase ont besoin du réseau, mais l'app reste affichable hors-ligne)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          return cached || caches.match("/index.html");
        });
      })
  );
});
