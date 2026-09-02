# Notes de développement — détection & outillage

Journal des travaux sur la fiabilité de la détection/skip et l'outillage de test.
Voir aussi `tools/README.md` (harness de capture des logs).

---

## 1. Outillage : harness de capture des logs (`tools/`)

`tools/capture-logs.mjs` (Playwright, dev-only, gitignoré) charge l'extension
dans un Chromium dédié, joue une vidéo YouTube et capture **tous les contextes
console** (page + iframes décodeur/OCR + service worker + réseau) dans
`logs/*.jsonl`, avec un résumé stdout (compteurs heartbeat, verdicts, raison
d'arrêt). Plus besoin de copier les logs de la console à la main.

Modes principaux :
- `--ad start-end` : fenêtre pub → seek + verdict HIT/MISS + arrêt anticipé.
- `--full-window` : joue toute la fenêtre, compte **tous** les skips (couverture).
- `--passive` : lecture depuis le début, sans seek.
- `--no-seek` : garde les fenêtres mais lecture continue + skip des pré-rolls.
- `--screenshot <t>` : capture une frame à `t` (pour localiser un overlay).
- `--no-extension` : diagnostic sans l'extension.

Prérequis : Node (installé via nvm ici — `source ~/.nvm/nvm.sh`). Le streaming
YouTube nécessite de lancer les runs hors sandbox réseau.

---

## 2. Corrections apportées

### 2.1 Réassemblage fMP4 — bug « 0 samples » *(cause racine du non-décodage)*
`content/mainContent.js` (`accumulateMp4Chunk` / `extractMp4Segments`).

YouTube découpe un même segment fMP4 (moof+mdat) sur **plusieurs**
`appendBuffer()`. L'extension parsait chaque chunk isolément → `mdat` tronqué →
`parseMediaSegment` renvoie 0 sample → quasi aucune frame décodée, OCR aveugle.
**Fix** : accumuler les chunks et n'enfiler que des **unités moof+mdat
complètes** (reset sur changement de `timestampOffset` = seek). Résultat : tous
les segments parsent, frames décodées, look-ahead actif.

### 2.2 Anti-détection YouTube — flux 403 après ~45s
`tools/capture-logs.mjs` (options de lancement).

Playwright lance Chromium avec `--enable-automation` → `navigator.webdriver=true`
→ BotGuard flague la session → `videoplayback` renvoie 403 après ~45-75s (et les
seeks profonds d'emblée). **Fix (côté harness)** :
`ignoreDefaultArgs:["--enable-automation"]` + `--disable-blink-features=AutomationControlled`
+ `addInitScript` masquant `navigator.webdriver` + user-agent Chrome réaliste.
Depuis, le flux tient indéfiniment et les seeks marchent. **Valider avec un
profil propre** (`rm -rf tools/.profile`).

### 2.3 OCR ciblé sur les coins + upscale + binarisation *(fiabilité de lecture)*
`content/mainContent.js` (`FrameClassifier.prepareRoiCanvas`, `CONFIG.ocr*`).

Le texte de disclosure (« Publicité ») est **brûlé dans la vidéo, petit, dans un
coin** (haut-droit sur la vidéo de réf). L'OCR tournait sur la frame entière
1280×720 → charabia, ~1 lecture réussie sur toute la pub. **Fix** :
- composer les **4 coins** cropés serré et **upscalés** dans un canvas 1600×900
  (1 seule passe Tesseract, pas 4× le coût) ;
- **binariser** (ne garder que les pixels quasi-blancs → texte noir sur blanc).

Effet mesuré : matches OCR **1 → 10** sur la pub de référence.

### 2.4 Commit proactif du segment + fusion agressive
`content/mainContent.js` (`consumeDetection`, `CONFIG` bridging).

Avant : le segment n'était finalisé qu'**après** la pub (25s de grâce sur une
détection négative) → le skip arrivait trop tard, ne coupait que la fin.
**Fix** : à chaque détection positive, insérer immédiatement un segment
`[t-marge, t+fenêtre]` (le look-ahead permet de couper dès le **début**), et
fusionner agressivement (`mergeGapSeconds` large) puisque le texte « Publicité »
signale un état *continu* « pub en cours ».

---

## 3. Résultats validés (vidéo de réf `vRAPfDSmBGM`, pub 3:49–4:57)

Run `--full-window` :
- Détection OCR fiable du sponsor (« Publicité » / Saily), **~13s en avance**.
- Segment unique (`storeSize=1`), **~45/68s de pub sautées** (11 sauts).
- Toute la chaîne fonctionne : décodage → OCR → segment → **skip**.

---

## 4. Pistes d'amélioration (à reprendre)

### 4.1 Micro-sauts → saut net *(principal)*
Actuellement le skip se fait en ~11 petits sauts avec ~2s de pub jouées entre
chaque (le look-ahead ne confirme qu'~10-15s d'avance, limité par le buffer + la
vitesse OCR ; le playhead rattrape la fin du segment qui grandit).
**Piste** : projection en avant plus agressive (gros sauts) **+ rognage de la fin
du segment quand le mot-clef disparaît vraiment** (N négatifs consécutifs) pour
ne pas dépasser la fin réelle de la pub. Nécessite de gérer un « segment vivant »
qu'on étend puis rogne (le `SegmentStore` ne sait pas rogner aujourd'hui).

### 4.2 OCR encore plus robuste
- Seuil de binarisation adaptatif (Otsu) plutôt que fixe (`ocrBinarizeThreshold`).
- ROI dynamique : localiser le bloc de texte (via `TextDetector` quand dispo)
  au lieu des 4 coins fixes.
- Scanner plus en avance / plus vite (l'OCR Tesseract est le goulot ; backlog de
  segments non scannés visible dans le heartbeat).

### 4.3 Généralisation multi-vidéos
Le coin exact et l'intitulé varient selon les créateurs (« Publicité »,
« Collaboration commerciale », « Communication commerciale »…). Les 4 coins +
la liste `COMMERCIAL_KEYWORDS` couvrent déjà pas mal ; à éprouver sur d'autres
vidéos et ajuster crops/mots-clefs.

### 4.4 Bornes & faux positifs
- Réduire le léger dépassement en début/fin de segment (paddings).
- Exiger 2 confirmations avant un skip si des faux positifs apparaissent.

---

## 5. Comment tester

```bash
source ~/.nvm/nvm.sh                      # Node via nvm
cd tools && npm install && npx playwright install chromium   # 1re fois
cd .. && node tools/capture-logs.mjs --full-window --seconds 300
# puis inspecter logs/run-*.jsonl (grep "Skip appliqué", "Segment OCR", …)
```
