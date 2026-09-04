# no_add_extension

Extension Chromium (Chrome/Brave) qui repère les **segments de collaboration
commerciale** dans les vidéos YouTube et les saute automatiquement pendant la
lecture.

Le principe : YouTube télécharge la vidéo avec plusieurs dizaines de secondes
d'avance. L'extension intercepte ces octets au passage, décode quelques images
en avance, y cherche le texte de divulgation obligatoire (« Collaboration
commerciale », « Publicité »…) et, quand le spectateur arrive à cet endroit, la
zone est déjà connue et le saut est immédiat.

> **Prototype.** L'approche est validée de bout en bout sur la vidéo de
> référence, mais les heuristiques (position du texte, formulations, formats de
> flux) ne couvrent pas tout YouTube. Voir [Limites connues](#limites-connues).

---

## Documentation

| Document | Pour qui |
|---|---|
| Ce README | Installer, lancer, comprendre l'organisation du dépôt. |
| [GUIDE.md](GUIDE.md) | Comprendre le fonctionnement **sans lire de code**. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Référence technique : composants, protocoles de messages, formats binaires. |
| [DEV-NOTES.md](DEV-NOTES.md) | Journal des mesures, des corrections et des pistes ouvertes. |
| [tools/README.md](tools/README.md) | Tests unitaires et harness de capture des logs. |

---

## Installation (mode développeur)

1. Ouvrir `chrome://extensions` (ou `brave://extensions`).
2. Activer le **mode développeur**.
3. **Charger l'extension non empaquetée** et sélectionner le dossier
   `no_add_extension/`.
4. Ouvrir une vidéo YouTube.
5. Les logs sont dans la console devtools, préfixés `[NoAddExtension]`,
   `[NoAdd-MSE]` et `[NoAdd-Decoder]`.

Chromium 114 minimum (WebCodecs). L'extension ne demande **aucune permission**
et n'accède qu'à `https://www.youtube.com/*`.

Pour produire une archive : `npm run pack`.

---

## Comment ça marche

```
YouTube appelle SourceBuffer.appendBuffer(segment)
        │
        ├─ mseInterceptor.js   (monde MAIN)      copie les octets au passage
        ▼
   content/*.js                (monde ISOLATED)  orchestration
        │
        ├─ decoder-sandbox     (iframe)          démuxage + WebCodecs
        │      └─ keyframes décodées
        ├─ ocr-sandbox         (iframe)          Tesseract sur les 4 coins
        │      └─ texte reconnu → mots-clés
        ├─ SegmentStore                          zones commerciales fusionnées
        └─ SkipController                        saute quand la lecture y entre
```

Quatre points méritent une explication, détaillée dans
[ARCHITECTURE.md](ARCHITECTURE.md) :

- **Pourquoi intercepter MSE** plutôt que lire un second lecteur vidéo caché :
  YouTube détecte et bride les lecteurs dupliqués, et gérer deux états de
  lecture est fragile. L'interception ne déclenche aucune requête réseau.
- **Pourquoi deux iframes** : la CSP de YouTube bloque le worker WASM de
  Tesseract. Une page `chrome-extension://` est soumise à la CSP de
  l'extension, pas à celle du site.
- **Pourquoi les quatre coins de l'image** : le texte de divulgation est petit,
  incrusté dans la vidéo, et sa position varie selon les créateurs. Les coins
  sont cropés à la résolution native puis agrandis dans un composite unique —
  une seule passe OCR par image.
- **Pourquoi une sonde dichotomique** : une fois une pub détectée, balayer la
  suite segment par segment est lent. L'extension va sonder le bord du buffer
  puis bissecte pour localiser la fin (voir DEV-NOTES §2.6).

---

## Organisation du dépôt

```text
no_add_extension/
├── manifest.json              Manifest V3 : content scripts, CSP, ressources
├── package.json               Script `pack`
├── content/                   Monde ISOLATED, sauf mseInterceptor
│   ├── mseInterceptor.js      Monde MAIN, document_start. Patche appendBuffer.
│   ├── config.js              CONFIG, mots-clés, noms de canaux
│   ├── util.js                Logs, normalisation de texte, helpers DOM
│   ├── segments.js            SegmentStore
│   ├── ui.js                  PlayerNotifier
│   ├── sandbox.js             SandboxBridge (pont vers les iframes)
│   ├── ocr.js                 RoiComposer, TesseractOcr, FrameClassifier
│   ├── mse-buffer.js          MseSegmentBuffer (réassemblage fMP4)
│   ├── decoder.js             DecoderSandbox
│   ├── probe.js               AdEndProbe (sonde de fin de pub)
│   ├── scanner.js             AheadScanner (orchestration du look-ahead)
│   ├── skip.js                SkipController
│   └── main.js                Cycle de vie d'une session + amorçage
├── pages/
│   ├── decoder-sandbox.{html,js}   WebCodecs VideoDecoder
│   └── ocr-sandbox.{html,js}       Tesseract.js
├── libs/
│   ├── mp4demux.js            Parseurs fMP4 (ISO BMFF) et WebM (EBML)
│   └── tesseract/             Moteur OCR embarqué (WASM)
└── tools/                     Dev-only, hors extension livrée
    ├── capture-logs.mjs       Harness Playwright + verdicts HIT/MISS
    └── test/                  Tests unitaires (sans navigateur)
```

Les modules du monde ISOLATED sont chargés dans l'ordre déclaré par
`manifest.json` et publient leurs classes dans un objet `NoAdd` partagé. Chaque
fichier commence par la liste de ce qu'il y prend :

```js
const { CONFIG, logInfo, formatError } = NoAdd;
```

Cet ordre est une dépendance réelle : un module placé avant celui dont il
dépend échouerait. Un test le vérifie (`npm test`).

---

## Réglages

Tous les paramètres sont dans l'objet `CONFIG`, dans `content/config.js`.
Les plus utiles :

| Paramètre | Défaut | Rôle |
|---|---|---|
| `frameSampleSeconds` | 4 | Écart minimal entre deux images analysées. |
| `minSegmentSeconds` | 3 | Durée en deçà de laquelle un segment est ignoré. |
| `mergeGapSeconds` | 20 | Deux détections plus proches que ça fusionnent. |
| `segmentStartPadSeconds` | 8 | Marge ajoutée avant une détection. |
| `segmentForwardSeconds` | 5 | Projection en avant sur une détection (~1 GOP). |
| `skipMarginSeconds` | 0.4 | Marge ajoutée après la fin d'un segment. |
| `bigJumpThresholdSeconds` | 20 | Au-delà, la sonde exige une confirmation. |
| `ocrCornerWidthFraction` / `…Height…` | 0.30 / 0.18 | Taille du crop de chaque coin. |
| `ocrCompositeWidth` | 1600 | Largeur du composite OCR (hauteur dérivée du ratio du crop). |
| `ocrBinarizeThreshold` | 190 | Luminance au-dessus de laquelle un pixel est du texte. |
| `analysisPollMs` | 1200 | Attente **quand il n'y a rien à scanner** (pas un plafond de débit). |

`CONFIG` porte aussi les cadences, les timeouts des sandboxes et les seuils
d'abandon.

---

## Développement

```bash
source ~/.nvm/nvm.sh                                    # Node via nvm
cd tools && npm install && npx playwright install chromium   # 1re fois

npm test                                                # tests unitaires, < 1 s
cd .. && node tools/capture-logs.mjs --full-window --seconds 300
```

Le harness charge l'extension dans un Chromium dédié, joue une vidéo, capture
tous les contextes console dans `logs/*.jsonl` et affiche un résumé (verdicts
HIT/MISS par fenêtre de pub, dernier heartbeat, nombre de sauts). Détail des
modes dans [tools/README.md](tools/README.md).

Pour trier un run, commencer par le heartbeat :

```
AheadScanner heartbeat { currentTime, bufferedAhead, decoderConfigured,
  useFallback, capturedSegments, mediaSegmentsReceived, scansRun,
  framesDecoded, ocrMatches, storeSize, mode, probe }
```

- `mediaSegmentsReceived` à 0 → l'interception MSE n'a pas pris.
- `scansRun` à 0 alors que des segments arrivent → la configuration du décodeur
  échoue (chercher `échec configuration decoder`).
- `framesDecoded` à 0 → regarder les lignes `scan-segment parse:`.
- `ocrMatches` à 0 malgré des frames → lire `textPreview` dans
  `frame analysée` : le texte est peut-être hors des coins cropés, ou la
  formulation n'est pas dans `COMMERCIAL_KEYWORDS`.

---

## Limites connues

- **Le modèle de langue est embarqué** sous `libs/tesseract/lang-data/`. C'était
  la seule dépendance réseau de l'extension, et depuis que l'OCR est le seul
  mécanisme de détection, son échec la rendait muette. Elle n'existe plus.
- **`TextDetector`** (OCR natif, rapide) n'existe pas sur tous les Chromium ;
  sur Linux c'est Tesseract qui travaille, nettement plus lent.
- **L'OCR rate environ une image sur onze** sur la vidéo de référence. C'est ce
  qui impose les garde-fous de la sonde (DEV-NOTES §2.6 et §4.2).
- **AV1 en WebM** n'est pas géré ; AV1 en fMP4 l'est (chemin courant sous Linux).
- **L'OCR est le seul mécanisme de détection.** L'extension lisait aussi
  l'overlay de divulgation que YouTube injecte dans le DOM ; sur quinze runs
  archivés ce chemin n'a jamais produit un seul segment, parce que les
  créateurs incrustent le texte dans l'image plutôt que de déclarer la
  promotion à YouTube. Il a été retiré. Conséquence : si l'OCR tombe, plus
  rien ne détecte.
- **YouTube peut changer** le format de ses flux, ses types MIME ou la
  formulation de ses divulgations à tout moment.

---

## Dépannage

**Tesseract et la CSP de YouTube.** Créer un worker Tesseract depuis le content
script est bloqué par la CSP de `youtube.com`. C'est pourquoi le moteur tourne
dans une iframe `chrome-extension://…/pages/ocr-sandbox.html`, soumise à la CSP
de l'extension. Le content script lui envoie des `ImageBitmap` par
`postMessage`. Une erreur `Creating a worker from 'blob:…' violates … Content
Security Policy` signale que ce contournement n'a pas été emprunté.

**L'OCR ne détecte plus rien.** L'OCR étant le seul mécanisme, sa panne rend
l'extension muette. Le heartbeat est ce qui le révèle : `ocrBackend` dit quel
moteur a été choisi, `tesseractDisabled` passe à `true` après cinq échecs
consécutifs, et `ocrMatches` reste à zéro. Le moteur réessaie tout seul, avec
un délai croissant, et ne se rend jamais définitivement — mais tant qu'il n'est
pas prêt, la boucle de scan attend au lieu de consommer des segments qu'elle ne
pourrait pas analyser.

Pour reproduire une panne et vérifier ce comportement :
`node tools/capture-logs.mjs --fault sandbox-dead --seconds 90`.

**`googlevideo … 403 (Forbidden)` en boucle.** La pile d'appels mentionne
souvent `kevlar_base_module` : c'est du code YouTube, pas l'extension. Dans le
harness, ces 403 venaient de la détection d'automatisation — voir DEV-NOTES §2.2
pour les options de lancement qui les font disparaître.

**`net::ERR_BLOCKED_BY_CLIENT`.** Requêtes bloquées par un bloqueur de publicité
(Brave Shields, uBlock…), pas par cette extension. Le désactiver le temps des
tests, puis comparer.
