# no_add_extension

Prototype d’extension Chromium (Chrome/Brave) qui tente de détecter et sauter automatiquement les segments de **collaboration commerciale** sur YouTube, en privilégiant une logique **en direct dès la première lecture**.

---

## 1) Objectif produit

L’objectif de cette V1 est de construire une base technique solide pour :

- lire une vidéo YouTube normalement côté utilisateur ;
- analyser en parallèle la vidéo via un lecteur fantôme et/ou les overlays DOM de YouTube ;
- identifier des segments probables de collaboration commerciale ;
- skipper automatiquement ces segments pendant la lecture.

Important : cette V1 est un **prototype fonctionnel** orienté architecture et expérimentation (réseau/perf), pas une solution garantie 100% sur tous les formats YouTube.

---

## 2) Fonctionnalités actuellement implémentées

### Détection par overlay DOM YouTube

- Observation du lecteur YouTube (`#movie_player`) avec :
  - un polling périodique ;
  - un `MutationObserver`.
- Recherche de mots-clés commerciaux (ex : `collaboration commerciale`) dans des zones UI du player.
- Quand un overlay commercial apparaît/disparaît, un segment est créé.

### Détection par “lecteur fantôme” + OCR

- Création d’un deuxième `<video>` caché (muted, invisible) qui lit la même source quand c’est possible.
- Ce lecteur fantôme tente de rester en avance sur le lecteur principal.
- Capture périodique d’une frame (toutes les 5 secondes par défaut).
- OCR dans cet ordre de préférence :
  1. `TextDetector` (API native Chromium si disponible) ;
  2. sinon **Tesseract.js** (fichiers embarqués sous `libs/tesseract/`, modèle de langue `fra` téléchargé une première fois depuis `tessdata.projectnaptha.com`).
- Si des mots-clés commerciaux sont détectés sur plusieurs frames, un segment est constitué.

### Skip automatique en direct

- Le lecteur principal surveille le temps courant.
- Si `currentTime` entre dans un segment détecté, on saute à la fin du segment (`end + marge`).
- Une notification discrète est affichée dans le player pour indiquer le skip.

---

## 3) Arborescence

```text
no_add_extension/
├── manifest.json
├── package.json
├── README.md
├── background/
│   └── serviceWorker.js
├── content/
│   └── mainContent.js
└── libs/
    └── tesseract/
        ├── tesseract.min.js
        ├── worker.min.js
        └── tesseract-core-simd.wasm.js
```

---

## 4) Rôle précis de chaque fichier

## `manifest.json`

Fichier central de l’extension (Manifest V3) :

- déclare l’extension (`name`, `description`, `version`) ;
- déclare les permissions (`storage`) ;
- cible YouTube (`https://www.youtube.com/*`) ;
- injecte le script principal `content/mainContent.js` ;
- déclare le service worker `background/serviceWorker.js`.

---

## `background/serviceWorker.js`

Service worker minimal pour la couche background :

- enregistre un état runtime léger en session storage ;
- répond à des messages de “ping” envoyés par le content script ;
- expose un point de lecture de stats runtime (`runtime:get-stats`).

Rôle principal en V1 : préparer une base de communication extension ↔ content script, utile pour les évolutions.

---

## `content/mainContent.js`

Fichier principal de la logique métier.  
Il contient plusieurs classes :

### `NoAddYouTubeController`

Orchestrateur de session :

- détecte les navigations YouTube SPA (`yt-navigate-finish`, `popstate`, watcher URL) ;
- initialise/détruit proprement les composants à chaque changement de vidéo ;
- crée `SegmentStore`, `OverlayDetector`, `GhostAnalyzer`, `SkipController`, `PlayerNotifier`.

### `SegmentStore`

Gestion des segments à skipper :

- ajoute des segments `start/end` ;
- fusionne les segments qui se chevauchent ou sont proches ;
- applique une durée minimale ;
- retrouve le segment actif pour un temps donné.

### `OverlayDetector`

Détection “DOM-first” :

- observe le DOM YouTube ;
- inspecte les zones du player pour y trouver les mots-clés commerciaux ;
- ouvre/ferme un segment selon apparition/disparition de l’overlay.

### `FrameClassifier`

Détection sur image :

- capture une frame vidéo dans un canvas redimensionné ;
- lance l’OCR via `TextDetector` (si disponible) ;
- extrait le texte et cherche les mots-clés commerciaux.

### `GhostAnalyzer`

Moteur d’analyse en parallèle :

- crée un lecteur vidéo caché (“ghost player”) ;
- essaie de maintenir une avance temporelle sur le lecteur principal ;
- échantillonne des frames toutes les X secondes ;
- transforme les détections OCR en segments commerciaux.

### `SkipController`

Moteur de skip :

- lit le `currentTime` du lecteur principal ;
- vérifie s’il est dans un segment ;
- avance automatiquement à la fin du segment (+ marge).

### `PlayerNotifier`

Affichage UX minimal :

- injecte une petite notification discrète dans le player lors des skips/activations.

---

## `package.json`

Fichier de gestion projet côté Node (sans dépendances runtime pour l’instant) :

- metadata de projet ;
- script `pack` pour générer rapidement un zip de l’extension.

---

## 5) Architecture fonctionnelle (pipeline)

1. L’utilisateur ouvre une vidéo YouTube (`/watch?v=...`).
2. Le contrôleur initialise une session.
3. Deux sources de détection s’activent :
   - `OverlayDetector` (DOM YouTube),
   - `GhostAnalyzer` + `FrameClassifier` (analyse image en avance).
4. Les segments détectés sont normalisés/fusionnés dans `SegmentStore`.
5. `SkipController` consulte `SegmentStore` en continu.
6. Quand un segment est atteint, la vidéo est skippée automatiquement.

---

## 6) Paramètres clés (dans `CONFIG`)

Les paramètres sont dans `content/mainContent.js` :

- `frameSampleSeconds` : pas d’échantillonnage OCR (5s) ;
- `ghostPlaybackRate` : vitesse du lecteur fantôme ;
- `ghostTargetLeadSeconds` / `ghostMinLeadSeconds` : avance visée/minimale ;
- `skipMarginSeconds` : marge ajoutée à la fin d’un segment ;
- `minSegmentSeconds` : ignore les segments trop courts ;
- `noMatchGraceSeconds` : délai avant fermeture d’un segment OCR.

Ces paramètres sont précisément les leviers pour tes exercices réseau/performance.

---

## 7) Installation locale (mode développeur)

1. Ouvrir `chrome://extensions` (ou `brave://extensions`).
2. Activer **Mode développeur**.
3. Cliquer sur **Charger l’extension non empaquetée**.
4. Sélectionner le dossier `no_add_extension/`.
5. Ouvrir YouTube et lancer une vidéo.
6. Ouvrir la console devtools pour voir les logs préfixés `[NoAddExtension]`.

---

## 8) Limites connues de la V1

- `TextDetector` n’est pas disponible partout/à toutes les versions.
- Selon la source YouTube (MSE/DRM/CORS), le lecteur fantôme peut échouer.
- L’OCR frame par frame peut coûter CPU selon machine/résolution.
- Les overlays YouTube changent dans le temps : il faudra ajuster les sélecteurs.
- Les détections restent heuristiques (faux positifs/faux négatifs possibles).

---

## 9) Pistes d’amélioration (prochaines versions)

- Ajouter un vrai moteur OCR dédié (WebAssembly / worker dédié).
- Ajouter une page d’options (seuils, mots-clés, mode agressif/éco).
- Ajouter un panneau debug avec :
  - avance du ghost,
  - FPS d’analyse,
  - latence OCR,
  - segments détectés en temps réel.
- Ajouter stratégie adaptative selon qualité réseau/CPU.
- Étendre à d’autres plateformes vidéo.

---

## 10) Résumé

Cette V1 met en place la base complète :

- architecture multi-composants claire,
- détection hybride (DOM + image),
- skip automatique en direct,
- structure prête pour itérations techniques avancées (perf/réseau).

---

## 11) Troubleshooting (logs fréquents)

### Message « aucun moteur OCR » / `TextDetector` absent

- Si `TextDetector` n’est pas dispo, l’extension utilise désormais **Tesseract.js** embarqué (voir `libs/tesseract/`).
- Tu dois voir un log du type `Moteur OCR pour le lecteur fantôme` avec `backend: "tesseract"` puis, au premier run, `Worker Tesseract prêt`.
- La **première** analyse peut être longue (téléchargement du modèle `fra` ~ quelques Mo). Il faut une connexion réseau pour ce téléchargement.
- Si **les deux** échouent, seule la détection overlay DOM reste active.

### Erreurs `googlevideo ... 403 (Forbidden)` en boucle

Souvent la pile d’appels mentionne `kevlar_base_module` : c’est **le code YouTube**, pas forcément l’extension.

Signification :

- certaines requêtes signées vers `googlevideo/videoplayback` sont refusées (jeton expiré, client non autorisé, etc.) ou liées au lecteur interne ;
- **ce n’est pas** en soi la preuve que “l’OCR de l’extension” échoue.

À part :

- certaines URL vidéo signées YouTube ne sont pas rejouables par un second lecteur “fantôme” créé par l’extension.

Ce qui a été durci dans le code :

- le lecteur fantôme préfère maintenant les sources `blob:` ;
- il évite les sources purement `googlevideo` signées pour réduire ces erreurs ;
- il logue la raison de sélection/refus de source.

### `net::ERR_BLOCKED_BY_CLIENT`

Signification :

- requêtes bloquées par un bloqueur (Brave Shields, uBlock, etc.), pas forcément par `no_add_extension`.

Actions :

- désactiver temporairement les bloqueurs sur YouTube pendant les tests techniques de l’extension ;
- puis réactiver et comparer le comportement.
