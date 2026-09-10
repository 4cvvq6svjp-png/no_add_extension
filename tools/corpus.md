# Corpus de vidéos de test (fenêtres de pub annotées)

Vidéos réelles avec la fenêtre d'intégration commerciale relevée à la main.
Elles servent de banc d'essai au harness (`capture-logs.mjs --ad start-end`)
pour mesurer la **généralisation multi-vidéos** (DEV-NOTES §4.3) : le coin,
l'intitulé et le contraste du bandeau varient d'un créateur à l'autre.

Chaque ligne se rejoue telle quelle ; le harness rend un verdict HIT/MISS par
fenêtre et sort en code 1 si au moins un MISS.

## Vidéo de référence

Celle codée en dur dans `capture-logs.mjs` (`TEST_VIDEO_URL` + `DEFAULT_ADS`),
utilisée quand aucun `--url` / `--ad` n'est fourni.

| Vidéo | Pub | Durée |
|---|---|---|
| `vRAPfDSmBGM` | 3:49 → 4:57 (229–297 s) | 68 s |

```bash
node tools/capture-logs.mjs --seconds 300
```

## Corpus étendu *(relevé 2026-09-09)*

> Les paramètres `&t=…` présents dans certains liens d'origine ne
> correspondent à rien : **seules les fenêtres ci-dessous font foi**.

| # | Vidéo | Pub | Durée | Note |
|---|---|---|---|---|
| 1 | `sJZBUk0nO5E` | 10:45 → 12:27 (645–747 s) | 102 s | |
| 2 | `AiytemqB_F0` | 1:14 → 2:04 (74–124 s) | 50 s | |
| 3 | `FOrRFw9PPvw` | 3:49 → 4:53 (229–293 s) | 64 s | fenêtre quasi identique à la vidéo de réf. |
| 4 | `Np_Fc7tWXus` | 3:29 → 3:42 (209–222 s) | 13 s | **la plus courte** : marge d'erreur minimale, teste la latence de détection |
| 5 | `0gbJordex-A` | 1:08 → 2:09 (68–129 s) | 61 s | pub très tôt : peu de buffer d'avance disponible |
| 6 | `_UPJzzU3yV0` | 1:27 → 2:53 (87–173 s) | 86 s | pub très tôt (idem) |
| 7 | `lbLj5Yb6SAE` | 17:16 → 18:45 (1036–1125 s) | 89 s | **cas difficile** : bandeau peu lisible même pour un humain. Perfs attendues plus faibles ; c'est le test final, pas un critère de blocage |
| 8 | `fkJVEMze1nY` | 3:35 → 5:02 (215–302 s) | 87 s | |
| 9 | `IL6YjqAlBa4` | 16:08 → 16:44 (968–1004 s) | 36 s | courte, tardive |

### Commandes

```bash
source ~/.nvm/nvm.sh   # Node via nvm

node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=sJZBUk0nO5E" --ad 10:45-12:27 --seconds 300
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=AiytemqB_F0" --ad 1:14-2:04   --seconds 240
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=FOrRFw9PPvw" --ad 3:49-4:53   --seconds 240
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=Np_Fc7tWXus" --ad 3:29-3:42   --seconds 180
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=0gbJordex-A" --ad 1:08-2:09   --seconds 240
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=_UPJzzU3yV0" --ad 1:27-2:53   --seconds 300
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=lbLj5Yb6SAE" --ad 17:16-18:45 --seconds 300
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=fkJVEMze1nY" --ad 3:35-5:02   --seconds 300
node tools/capture-logs.mjs --url "https://www.youtube.com/watch?v=IL6YjqAlBa4" --ad 16:08-16:44 --seconds 240
```

### Précautions de mesure

- `--seconds` est un **plafond de sécurité en temps réel**, pas une position
  vidéo : il doit couvrir démarrage + `--seek-lead` (30 s par défaut) + durée
  de la fenêtre. Les valeurs ci-dessus laissent de la marge.
- Vidéos **5 et 6** : la pub commence avant 1:30, donc le seek de mise en
  place (`start − 30 s`) tombe quasiment au début. Le look-ahead OCR est
  limité par le buffer (DEV-NOTES §4.1) : un MISS ici peut être un manque
  d'avance, pas un défaut de lecture. Comparer avec `--seek-lead 45`.
- Vidéo **4** (13 s) : `--grace 2` laisse très peu de marge. Un MISS mérite
  d'être relu dans le JSONL (`Segment OCR ajouté` arrivé après `end + grace` ?)
  avant d'être compté comme un échec de détection.
- Un run YouTube n'est pas déterministe (bitrate, buffering, A/B UI) : juger
  sur plusieurs runs, comme pour la vidéo de réf (DEV-NOTES §3).
