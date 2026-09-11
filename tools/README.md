# tools/ — Outillage de test (dev-only)

Deux niveaux de vérification, du plus rapide au plus réaliste :

| | Commande | Ce que ça couvre | Durée |
|---|---|---|---|
| **Tests unitaires** | `npm test` | Logique pure du content script et des parseurs, sans navigateur. | < 1 s |
| **Harness** | `node capture-logs.mjs …` | Chaîne complète dans un vrai Chromium sur une vraie vidéo. | minutes |

Ce dossier est **hors de l'extension livrée** (exclu du `npm run pack`).

---

## Tests unitaires (`test/`)

```bash
cd tools && npm test
```

Exécutent le content script et `mp4demux.js` sous un DOM factice
(`test/dom-stub.mjs`) — aucun navigateur, aucun réseau. Ils couvrent ce qui se
vérifie sans lecture vidéo :

- **`content.test.mjs`** — amorçage d'une session, cadences périodiques lues
  dans `CONFIG`, géométrie du composite OCR (ratio des cellules, crop à la
  résolution native, adaptation à la définition source), liste de mots-clés,
  fusion et recherche dans `SegmentStore`.
- **`mp4demux.test.mjs`** — parsing d'un init segment fMP4 synthétique (codec
  pris dans le MIME, dimensions, `description`, timescale) et lecture des
  entêtes de boîtes, taille étendue 64 bits comprise.

Ce qui n'y est **pas** couvert et reste du ressort du harness : décodage
WebCodecs, OCR Tesseract, interception MSE, sonde de fin de pub, skip réel.

> `test/dom-stub.mjs` charge les modules **dans l'ordre déclaré par le
> manifeste** et lit le namespace qu'ils publient. Les tests exercent donc le
> vrai ordre de chargement : un module qui dépendrait d'un autre chargé après
> lui échouerait ici comme dans le navigateur.

---

## Harness de capture des logs

Charge **No Add Extension** dans une instance Chromium dédiée, ouvre une vidéo
YouTube et capture **tous les logs** (page + iframes sandbox décodeur/OCR +
réseau) vers un fichier JSONL, avec un résumé sur stdout.

## Prérequis

Node.js (≥ 18) et npm. Cette machine ne les a pas encore — au choix, sans sudo :

```bash
# nvm (recommandé, user-local, réversible)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install --lts
```

Playwright télécharge son propre Chromium (voir ci-dessous), donc pas besoin
d'un Chrome système — le Brave snap n'est pas utilisé (son confinement casserait
`--load-extension` + le profil dédié).

## Installation (une fois)

```bash
cd tools
npm install
npx playwright install chromium
```

## Utilisation

```bash
# Capture passive (jusqu'au plafond --seconds)
node capture-logs.mjs --url "https://www.youtube.com/watch?v=XXXX" --seconds 180

# Avec fenêtres de pub annotées : verdict HIT/MISS par segment
node capture-logs.mjs \
  --url "https://www.youtube.com/watch?v=XXXX" \
  --ad 2:05-2:35 --ad 8:10-8:40
```

> **Corpus de vidéos annotées** : `corpus.md` liste des vidéos réelles avec
> leur fenêtre de pub relevée à la main et la commande prête à rejouer. C'est
> le banc d'essai de la généralisation multi-vidéos.

Au **premier lancement**, une fenêtre Chrome s'ouvre : connecte-toi à YouTube /
accepte le consentement si demandé. Le profil (`tools/.profile/`) est persistant,
donc c'est à faire une seule fois.

## Options

| Option        | Défaut | Rôle |
|---------------|--------|------|
| `--url`       | `TEST_VIDEO_URL` | Vidéo à lire. |
| `--ad s-e`    | —      | Fenêtre de pub réelle (répétable). Secondes ou `mm:ss`, ex. `2:05-2:35`. |
| `--seconds`   | 180    | Plafond de sécurité de la durée du run. |
| `--seek-lead` | 30     | Avance (s) avant chaque pub pour stabiliser le buffering/OCR. |
| `--grace`     | 2      | Marge (s) après la fin d'une pub avant de déclarer MISS. |
| `--out`       | `logs/run-<ts>.jsonl` | Fichier de sortie. |
| `--headless`  | off    | Mode headless. |
| `--fault <mode>` | —   | Injecte une panne OCR et vérifie le comportement de reprise (voir ci-dessous). |

## Comment ça juge une pub (HIT/MISS)

Pour chaque `--ad [start,end]`, le harness **seek à `start − seek-lead`**, laisse
jouer à travers la fenêtre, et cherche un signal de détection de l'extension :

- `Skip appliqué` (skip effectif),
- `Segment OCR ajouté` (segment stocké),
- `AheadScanner: frame analysée` avec `keyword: true` (match OCR look-ahead).

- **HIT** : un signal apparaît → on passe immédiatement à la fenêtre suivante.
- **MISS** : le playhead dépasse `end + grace` sans aucun signal → l'extension a
  raté ce segment. Inutile de laisser tourner la vidéo : on passe à la fenêtre
  suivante, et on s'arrête après la dernière.

Le résumé stdout donne : verdicts, dernier heartbeat (`mediaSegmentsReceived`,
`framesDecoded`, `ocrMatches`, `useFallback`, `tesseractDisabled`, `storeSize`…),
nombre de skips, erreurs, et la raison de l'arrêt. Le JSONL contient le détail
complet (`grep`-able par `source` et par tag `[NoAdd-MSE]` / `[NoAdd-Decoder]`).

Code retour `1` si un MISS ou une erreur (utile en script/CI), `0` si tout HIT.

## Banc d'essai multi-vidéos (`run-corpus.mjs`)

`tools/corpus.json` est la **source de vérité** : identifiants YouTube, fenêtres
de pub relevées à la main, plafond `--seconds` par vidéo. Cinq tests en gardent
le format (`npm test`), parce qu'une entrée mal formée ne se verrait qu'après
des dizaines de minutes de runs.

```bash
node tools/run-corpus.mjs                 # passe de détection
node tools/run-corpus.mjs --full-window   # passe de couverture
node tools/run-corpus.mjs --only Np_Fc7tWXus --seek-lead 45
```

### Deux passes, deux questions

| Passe | Question |
|---|---|
| **détection** (défaut) | Le mot-clé est-il lu dans la fenêtre ? |
| **couverture** (`--full-window`) | Quelle part de la pub est réellement sautée ? |

Les runs restent **en série**. Le parallélisme a été envisagé puis écarté : la
couverture dépend de la profondeur du buffer et de la cadence de scan
(DEV-NOTES §4.1), or plusieurs navigateurs simultanés se disputent la bande
passante et le CPU — précisément ces deux variables. On mesurerait la
contention plutôt que le produit.

## Voir ce que l'OCR voit (`--dump-roi`)

Le composite 2×2 que `RoiComposer` construit — quatre coins cropés, agrandis,
binarisés — n'existe qu'en mémoire. `--dump-roi` l'exporte pour chaque frame
analysée, **avant et après binarisation** :

```bash
node tools/capture-logs.mjs --url "…?v=ID" --ad 3:49-4:53 --full-window --dump-roi
# → logs/roi/<ID>/00229.4s-1-brut.png
#   logs/roi/<ID>/00229.4s-2-binarise.png
```

La paire tranche entre les trois causes possibles d'un échec de lecture :

| Ce qu'on observe | Cause |
|---|---|
| le texte est absent de l'image brute | le crop des coins l'a manqué |
| lisible en brut, effacé après binarisation | `ocrBinarizeThreshold` inadapté |
| illisible dans les deux | taille ou contraste insuffisants à la source |

Comme `--fault`, le mode travaille sur une **copie** de l'extension dans un
dossier temporaire : aucun point d'export ne vit dans le code livré. Les images
vont sur disque et non dans le JSONL, qu'une paire de PNG base64 par frame
rendrait illisible. Compter ~650 Ko par frame.

## Injection de panne (`--fault`)

Les runs normaux ne jouent que le chemin heureux : le démarrage OCR réussit à
chaque fois, donc le code de reprise n'est exercé que par les tests unitaires,
avec un pont simulé. `--fault` comble ce trou en conditions réelles.

Le harness **copie l'extension dans un dossier temporaire**, y casse
`pages/ocr-sandbox.js`, et charge cette copie. Rien n'est modifié dans les
sources, et aucun point d'injection ne vit dans le code livré.

| Mode | Ce qu'il simule |
|------|-----------------|
| `sandbox-dead` | L'iframe OCR ne signale jamais sa disponibilité. C'est le cas qui condamnait le moteur pour toujours avant correction. |
| `init-error`   | Le moteur refuse de démarrer (modèle illisible, WASM cassé). C'est le cas qui relançait une initialisation complète à chaque frame. |

```bash
node capture-logs.mjs --fault sandbox-dead --seconds 90
```

Le run n'essaie pas de sauter une pub : il observe et vérifie cinq propriétés,
avec un code retour `0` seulement si toutes sont observées.

- la panne est détectée et loguée ;
- les tentatives sont **espacées** (backoff), pas une par frame ;
- le heartbeat finit par signaler `tesseractDisabled` ;
- **aucun segment n'est consommé** sans OCR disponible ;
- les segments **restent analysables** pour plus tard.

La reprise après retour à la normale n'est pas couverte ici — la copie est
statique, la panne ne se lève pas en cours de run. C'est le rôle des tests
unitaires, qui pilotent une horloge pour ça.
