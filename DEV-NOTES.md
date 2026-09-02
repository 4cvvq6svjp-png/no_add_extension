# Notes de développement — détection & outillage

Journal des travaux sur la fiabilité de la détection/skip et l'outillage de test.
Voir aussi `tools/README.md` (tests unitaires et harness de capture des logs).

> Les entrées antérieures au découpage (§2.8) citent `content/mainContent.js` :
> ce fichier a depuis été éclaté en modules sous `content/`. Les noms de
> fonctions, eux, sont inchangés.

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

`segmentForwardSeconds` est depuis passé de 12 à **5s** (~1 GOP) : cette
projection est *aveugle*, et sur la dernière frame positive d'une pub elle
faisait dépasser la fin réelle d'autant (saut jusqu'à 309s pour une pub finissant
à 297s). C'est désormais la sonde (§2.6) qui établit la vraie fin.

### 2.5 Boucle de scan continue *(vitesse : 2,13× → ~4,4×)*
`content/mainContent.js` (`AheadScanner.runScanLoop`).

`scanNext` était appelé par un `setInterval(analysisPollMs = 1200ms)` gardé par
`pendingScan`. Le travail réel (décodage + OCR) prend ~1,2s : le tick qui tombait
pendant le travail sortait à vide, et le cycle effectif était **quantisé à 2,4s —
la moitié du débit perdue en attente**, alors que le heartbeat montrait en
permanence `5 non scannés` (~25s de contenu déjà disponible). **Fix** : boucle
auto-réordonnancée qui enchaîne les scans dos à dos tant que `scanNext` renvoie
`true` ; `analysisPollMs` n'est plus qu'un intervalle d'**inactivité**.

### 2.6 Sonde dichotomique de la fin de pub *(avance)*
`content/mainContent.js` (`pickProbeSegment`, `consumeProbeResult`,
`extendAdEnd`, `maybeResolveProbe`).

Le balayage était FIFO (`find(e => !e.scanned)`) : on analysait toujours le bord
*arrière* de la file, donc ~0s devant le playhead, en traversant la pub segment
par segment (13 analyses pour 68s). **Fix** : dès qu'une pub est détectée, on
inverse le sens — on sonde le segment le plus **avancé** du buffer (~40s devant),
puis on bissecte pour localiser la fin. La sonde raisonne sur les *indices* de
`capturedSegments` (via un `seq` monotone, immunisé contre `evictOldSegments`) et
apprend le temps *a posteriori* du `timestamp` renvoyé par le décodeur — elle n'a
donc pas besoin de connaître la position temporelle d'un segment avant de le
sonder.

Deux garde-fous **symétriques**, tous deux nécessaires et mesurés :
- **Anti sur-saut (faux positif)** : un saut > `bigJumpThresholdSeconds` (20s)
  exige 2 lectures positives distinctes. Sans lui, un mot mal lu en plein contenu
  ferait sauter jusqu'à 40s de vidéo légitime.
- **Anti fin prématurée (faux négatif)** : l'OCR rate ~1 frame sur 11. Un négatif
  isolé n'est qu'un **candidat** ; il faut deux segments **consécutifs** négatifs
  pour borner la pub, et tout positif postérieur invalide la borne. La contrainte
  d'adjacence est indispensable : sans elle, des faux négatifs épars (245,8 et
  291,8 sur la vidéo de réf) se confirment entre eux alors qu'un positif les
  sépare. Un candidat non confirmé sert quand même de borne haute provisoire pour
  la bissection, qui reste ainsi utile pendant l'attente de sa confirmation.

### 2.7 Nettoyage A/B/C issu de la revue de code *(2026-09-01)*

Trois lots appliqués d'un coup, dans cet ordre : code mort, duplication, puis
simplifications à effet mesurable. 3 531 → 3 359 lignes de JS **malgré** les
commentaires ajoutés, et deux corrections qui touchent la détection.

**Code mort (A).** Le pré-filtre `TextDetector` de `detectWithTesseract` était
inatteignable : `ocrBackend` n'est affecté qu'au constructeur, donc
`textDetector` présent ⇒ backend `text-detector` ⇒ `detectWithTesseract` jamais
appelée. `noMatchGraceSeconds` n'avait plus de lecteur depuis le commit proactif
de §2.4 (il avait pourtant reçu un réglage 8 → 25). Supprimés aussi : le service
worker (aucun consommateur, avec la permission `storage` et l'entrée
`background` du manifeste), les handlers `decode`/`reset` de la sandbox
décodeur, les champs `maxBufferSeconds` / `lastPositiveSample` /
`activeCommercialStart` / `receivedAt`, et le flush de `OverlayDetector.stop()`
que `teardownSession` effaçait aussitôt.

**Duplication (B).** Le pont iframe était écrit deux fois (OCR et décodeur) et
les deux copies avaient divergé sur la validation des réponses ; il n'existe
plus qu'une classe `SandboxBridge`. `detectFromVideo`/`detectFromBitmap`
fusionnent en `detect(source, …)` — `drawImage` accepte les deux types. Le
parcours de boîtes ISO BMFF existait en trois exemplaires : `mp4demux` expose
désormais `readBoxHeader`, et le manifeste charge `mp4demux.js` **aussi** dans
le monde isolé pour que le réassemblage fMP4 s'en serve.

**Effet mesurable (C).**

- *Ratio du composite OCR.* Le crop 30 %×18 % (576×194 sur du 1080p, ratio 2,97)
  était étiré dans une cellule 800×450 (ratio 1,78) : **glyphes allongés de 66 %
  en vertical**. La hauteur du composite est maintenant dérivée du ratio du crop
  (1600×538). Bonus : **−40 % d'aire de canvas** — moins de binarisation, et
  Tesseract travaille sur d'autant moins de pixels.
- *Plus de canvas intermédiaire.* La frame était réduite en 1280×720 avant
  d'être re-agrandie ×2. Les coins sont désormais lus à la **résolution native**
  de la source.
- *Codec depuis le MIME.* `parseAvcC`/`parseVpcC`/`parseAv1C` reconstruisaient à
  la main une chaîne que le `SourceBuffer` annonce déjà (`av01.0.04M.08…`, et
  notre parseur en déduisait `av01.0.05M.08…`). Il ne reste du parsing binaire
  que ce que le MIME ne donne pas. `hvc1` et `vp09`-en-mp4 marchent au passage.
- *Un flush WebCodecs par lot* au lieu d'un par keyframe, avec des requêtes
  indexées par timestamp : une frame perdue ne peut plus décaler les bitmaps
  suivantes sur la mauvaise keyframe.
- *Sélecteurs DOM restreints* à `.ytp-paid-content-overlay(-text)`. Les logs
  montraient un match « sponsor » à `currentTime: 0` pendant une pub pré-roll
  YouTube : le titre et le chrome du lecteur étaient lus. Pire, un match qui
  colle fige `overlayActive` et empêche ensuite tout vrai overlay d'ouvrir un
  segment.
- *Mots-clés* réduits de 8 à 5 : la comparaison est par sous-chaîne, « sponsor »
  couvrait déjà « contenu sponsorisé », « vidéo sponsorisée » et « sponsorisé
  par ». Liste normalisée une fois au chargement au lieu d'une fois par frame.
- *Boucles à vide arrêtées* : la boucle de scan s'arrête en mode repli (et
  redémarre sur un nouvel init segment) ; l'interceptor cesse de retenir 20
  segments complets une fois le replay servi.
- *`CONFIG` redevient la source de vérité* : les ~16 constantes de temps codées
  en dur (cadences, timeouts sandbox, seuils d'abandon) y sont remontées.

**Mesure sur la vidéo de référence** (4 runs `--full-window` après nettoyage,
comparés aux 6 runs d'août ; toutes les métriques recalculées à l'identique
depuis les JSONL, pas reprises du tableau §3) :

| | août (n=6) | sept. après A/B/C (n=4) |
|---|---|---|
| Pub vue (médiane) | 12,5s **[7,6 – 22,9]** | **5,0s [4,7 – 8,8]** |
| Sauts (médiane) | 6 | 4 |
| Dépassement | +0,4 à +12,4s | +0,4s sur 3 runs /4 |
| Cadence | 1,7s/frame | **2,1s/frame** |
| Lecture OCR dans la pub | 57/68 (84 %) | 31/37 (84 %) |
| Avance max de la sonde | 29,0s | **39,6s** |
| Frames analysées dans la pub | 12 | **9** |

Les distributions de « pub vue » se recouvrent à peine : 3 runs sur 4 sont sous
le **meilleur** run d'août. L'amélioration est donc réelle, mais **son mécanisme
n'est pas établi** :

- ce n'est pas le débit — la cadence par frame a *empiré* (1,7 → 2,1s) ;
- ce n'est pas le taux de lecture OCR — identique à 84 % avant/après.

Ce que la mesure montre, c'est que la sonde **va chercher plus loin** (avance max
29 → 39,6s) et couvre la pub en **moins de frames** (12 → 9). Hypothèse la plus
plausible pour la cadence : le composite non déformé donne à Tesseract un texte
réellement lisible, donc plus long à transcrire — les `textPreview` sont
visiblement plus riches qu'en août. À confirmer en instrumentant la durée d'un
appel OCR.

**Pourquoi le flush par lot ne rapporte rien ici.** Mesuré sur un run
post-nettoyage : 20 scans sur 21 ne décodent **que 0 ou 1 keyframe**, parce
qu'un segment média YouTube n'en contient qu'une (17 scans sur 21 voient
`keyframesTotal: 1`). Le lot est donc de taille 1, et un flush par lot *est* un
flush par keyframe. Le changement reste utile pour la **correction** — une frame
perdue ne peut plus décaler les bitmaps suivantes sur la mauvaise keyframe —
mais pas pour le débit. Le levier est ailleurs, voir §4.5.

**Reste à faire** : le découpage (lot D), les défauts du lot E — dont la
ré-entrance de `setupSession` — et la réécriture du README (F1, faite).

### 2.8 Découpage en modules *(2026-09-02)*

`content/mainContent.js` faisait 1 947 lignes en une seule IIFE, dont **824
pour `AheadScanner`** qui portait huit responsabilités : on ne pouvait pas lire
la sonde sans traverser le réassemblage fMP4. Aucun test ne pouvait atteindre
ces unités.

**Trois étapes, trois commits**, pour que chaque diff soit relisible :
extractions dans le fichier unique (la logique bouge), puis découpage en
fichiers (de simples déplacements), puis restructuration du harness.

`AheadScanner` devient `MseSegmentBuffer` (messages MSE, réassemblage moof+mdat,
éviction, `seq`), `DecoderSandbox` (configure + scan-segment), `AdEndProbe` (la
sonde) et un `AheadScanner` réduit à l'orchestration. `FrameClassifier` devient
`RoiComposer`, `TesseractOcr` et un `FrameClassifier` réduit au choix de
backend.

**L'algorithme de la sonde n'est pas retouché.** Son raisonnement par *indices*
est correct : le temps d'un segment n'est connu qu'APRÈS décodage, la sélection
du prochain segment à sonder ne peut donc être que positionnelle.

**Mécanisme de découpage.** 13 fichiers sous `content/`, listés dans
`manifest.json` ; ils partagent le monde isolé et publient dans un objet
`NoAdd`. Chaque fichier commence par ce qu'il y prend :

```js
const { CONFIG, logInfo, formatError } = NoAdd;
```

Une liste d'imports en tout sauf le nom, sans changer le modèle de chargement
(synchrone, pas de `web_accessible_resources` supplémentaire, résistant à une
double injection). Basculable vers de vrais modules ES plus tard sans
re-découper.

**Ce que ça débloque, concrètement.** Les tests chargent désormais les modules
**dans l'ordre du manifeste** et lisent le namespace : le contournement qui
greffait une ligne d'export sur l'IIFE a disparu, et un module mal placé dans
l'ordre échouerait au test comme dans le navigateur. 14 tests ajoutés sur des
unités jusque-là inatteignables — réassemblage fMP4 (chunk coupé au milieu d'un
`mdat`, deux unités dans un chunk, discontinuité de `timestampOffset`,
stabilité des `seq` sous éviction) et les deux garde-fous de la sonde (deux
négatifs consécutifs, invalidation par un positif postérieur, seuil de
confirmation sur grand saut). **33 tests, < 1 s, sans navigateur.**

Le volume de code augmente (1 947 → ~2 590 lignes réparties) : en-têtes de
classe et documentation. L'objectif de ce lot est la lisibilité, pas la
concision.

---

## 3. Résultats validés (vidéo de réf `vRAPfDSmBGM`, pub 3:49–4:57)

Run `--full-window`, mesures extraites des `Skip appliqué` du JSONL :

| | avant §2.5–2.6 | après (2 runs) |
|---|---|---|
| Pub vue | 22,9s / 68s (66 % sautée) | **9,6s et 10,6s (86 % / 84 % sautée)** |
| Sauts | 11 | 6 |
| Vitesse de scan | 2,13× | **4,25× / 4,45×** |
| Dépassement après la fin de pub | +12,4s | +5s (borné par `segmentForwardSeconds`) |

Toute la chaîne fonctionne : décodage → OCR → sonde → segment → **skip**, sans
skip hors fenêtre de pub, sans erreur, `storeSize=1`.

### La loi qui gouverne le résultat

En corrélant l'horodatage wall-clock et le temps de contenu des `frame analysée` :

```
pub_vue ≈ durée_pub / vitesse_scan − avance_initiale
```

Elle prédisait l'état antérieur au dixième près (68/2,13 − 9,4 = 22,6s pour 22,9s
mesurées). **Le nombre de sauts n'est donc pas la cause** — seuls comptent les
deux termes : la vitesse de scan (§2.5) et l'avance accumulée (§2.6).

---

## 4. Pistes d'amélioration (à reprendre)

### 4.1 Réduire encore les sauts *(traité en partie par §2.5–2.6)*
~~Projection agressive + rognage~~ : hypothèse **invalidée** par la mesure. La
contrainte était la vitesse de scan, pas la politique de saut — simulée, cette
piste retombait sur les mêmes ~23s vues.

Il reste 6 sauts avec ~1,2s de pub jouées après chacun. Cause : **un seek vide le
buffer MSE**, donc juste après un saut la frontière que la sonde peut atteindre
est proche (~10-20s au lieu de 40s), et l'extension suivante est courte. Le
playhead chase donc la sonde extension par extension.
**Pistes** : attendre que le buffer se soit reconstitué avant de sonder la
frontière (pour sauter plus loin, moins souvent) ; ou grouper plusieurs
extensions avant de déclencher le skip. Les deux échangent du temps de pub vue
contre moins de sauts — à arbitrer sur le ressenti visuel.

### 4.2 OCR encore plus robuste
Taux de faux négatifs mesuré sur la pub de réf : **~1 frame sur 11** (le texte
est bien présent mais non lu). C'est ce qui impose le garde-fou d'adjacence de
§2.6 ; le réduire raccourcirait directement la traque de la fin de pub.

- Seuil de binarisation adaptatif (Otsu) plutôt que fixe (`ocrBinarizeThreshold`).
- ROI dynamique : localiser le bloc de texte (via `TextDetector` quand dispo)
  au lieu des 4 coins fixes.
- Scanner plus en avance / plus vite (l'OCR Tesseract est le goulot ; backlog de
  segments non scannés visible dans le heartbeat).

### 4.5 Où est vraiment le débit *(mesuré, §2.7)*
Le flush par lot ne peut rien apporter : un segment média YouTube ne porte
qu'**une** keyframe, donc le lot est toujours de taille 1. Le heartbeat de fin
de run montre par ailleurs `28 capturés (8 non scannés)` — le scanner reste le
goulot, mais frame par frame.

Deux pistes qui s'attaquent au bon terme :
- **Paralléliser les scans** : plusieurs `scan-segment` en vol (le pont supporte
  déjà des `reqId` concurrents), ou une seconde sandbox OCR. Le décodage est
  rapide ; c'est l'appel Tesseract qui domine.
- **Réduire le coût d'un appel Tesseract** : le composite est passé de
  1600×900 à 1600×538 (§2.7), mais rien ne dit que 1600 de large soit
  nécessaire. À balayer.

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
