# tools/ — Harness de capture des logs (dev-only)

Outillage de test qui charge **No Add Extension** dans une instance Chrome dédiée,
ouvre une vidéo YouTube et capture **tous les logs** (page + iframes sandbox
décodeur/OCR + service worker) vers un fichier JSONL, avec un résumé sur stdout.

Ce dossier est **hors de l'extension livrée** (gitignoré, exclu du `npm run pack`).

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
| `--headless`  | off    | Mode headless (`--headless=new`). |

## Comment ça juge une pub (HIT/MISS)

Pour chaque `--ad [start,end]`, le harness **seek à `start − seek-lead`**, laisse
jouer à travers la fenêtre, et cherche un signal de détection de l'extension :

- `Skip appliqué` (skip effectif),
- `Overlay commercial détecté` (détection DOM),
- `Segment OCR ajouté` / `Segment overlay ajouté` (segment stocké),
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
