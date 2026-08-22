# MyWattUp — Structure du projet

Application PWA santé / sport / nutrition. Stack : HTML/JS vanilla + Supabase + Vercel (même logique que Bâtipro).

## Arborescence

```
mywattup/
├── index.html              → Connexion / inscription (page publique d'entrée)
├── onboarding.html         → Création du profil sportif (à créer, suit le modèle dashboard.html)
├── dashboard.html          → Écran d'accueil : score du jour, résumé (FAIT — fonctionnel)
├── journal.html            → Journal quotidien : sommeil, activité, forme (à créer)
├── repas.html               → Plan de repas de la semaine (à créer)
├── scanner.html             → Scan code-barres + historique (à créer)
├── profil.html               → Profil, objectif, abonnement (à créer)
├── manifest.json            → Config PWA (nom, icônes, couleurs) — FAIT
├── sw.js                    → Service worker (cache, mode hors-ligne) — FAIT
├── css/
│   └── style.css            → Styles globaux, tokens de couleur MyWattUp — FAIT
├── js/
│   ├── supabaseClient.js    → Client Supabase centralisé — FAIT (à compléter avec tes clés)
│   ├── pwa.js                → Enregistrement du service worker — FAIT
│   └── pages/
│       ├── auth.js           → Logique connexion/inscription — FAIT
│       ├── dashboard.js      → Logique dashboard — FAIT
│       ├── onboarding.js     → (à créer)
│       ├── journal.js        → (à créer)
│       ├── repas.js          → (à créer)
│       └── scanner.js        → (à créer)
└── icons/
    ├── icon-192.png          → Généré depuis le logo (à copier ici)
    ├── icon-512.png          → Généré depuis le logo (à copier ici)
    └── icon-maskable-512.png → Version avec marge de sécurité pour Android (à créer)
```

## Étapes pour démarrer

1. **Configurer Supabase**
   - Crée un projet sur supabase.com
   - Exécute le script `mywattup_schema.sql` fourni dans l'éditeur SQL
   - Récupère l'URL et la clé anon dans Project Settings > API
   - Colle-les dans `js/supabaseClient.js`

2. **Copier les icônes**
   - Copie `mywattup_logo_512.png` dans `icons/icon-512.png`
   - Génère une version 192x192 et une version "maskable" (marge de 20% autour du logo, fond plein) — un outil comme https://maskable.app/editor peut t'aider

3. **Tester en local**
   - Un simple serveur statique suffit (ex. `npx serve .` depuis le dossier du projet)
   - Les modules ES (`import`/`export`) nécessitent un serveur HTTP, pas un simple double-clic sur le fichier

4. **Déployer sur Vercel**
   - Connecte le repo GitHub à Vercel (comme pour Bâtipro)
   - Aucune configuration de build nécessaire (site statique)
   - Vérifie que `manifest.json` et `sw.js` sont bien accessibles à la racine du domaine

## Pages restantes à créer

Les pages `onboarding.html`, `journal.html`, `repas.html`, `scanner.html` et `profil.html`
suivent le même modèle que `dashboard.html` : même `<head>`, même barre de navigation basse,
un script dédié dans `js/pages/`. Les contenus visuels de chaque écran sont détaillés dans
le cahier des charges (section 3.5).

## Prochaine intégration technique

- **Scanner** : appel à l'API OpenFoodFacts (https://world.openfoodfacts.org/api/v2/product/{barcode}.json)
- **Coach IA / génération de repas** : appel à l'API Anthropic Claude depuis une fonction serverless
  (ne jamais exposer la clé API côté client — passer par une Vercel Function ou une Supabase Edge Function,
  comme cela a été fait pour la génération PDF sur Bâtipro)
