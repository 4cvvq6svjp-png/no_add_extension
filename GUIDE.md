# Guide du projet "No Add Extension"

> Document d'introduction destiné à un lecteur non-technique. L'objectif est que tu puisses comprendre **ce que fait l'extension**, **comment elle s'y prend**, et **où on en est** sans avoir à lire une seule ligne de code.

---

## 1. En une phrase

Une extension Chrome qui repère automatiquement les passages sponsorisés dans les vidéos YouTube et fait avancer la vidéo pour les sauter.

---

## 2. Le problème qu'on essaie de résoudre

Quand un YouTubeur dit "merci à X qui sponsorise cette vidéo", la loi française et européenne l'oblige à afficher un texte à l'écran pendant toute la durée du segment payé. Ce texte ressemble à :

- "Collaboration commerciale"
- "Contenu sponsorisé"
- "Communication commerciale"

Ces textes sont notre **point de repère** : si on les voit à l'écran, on sait qu'on est dans une partie sponsorisée. L'extension cherche ces mots-clés dans la vidéo et, quand elle les trouve, elle saute par-dessus.

---

## 3. L'idée centrale (et pourquoi elle est maligne)

Le défi : si on attend que le spectateur ARRIVE au passage sponsorisé pour le détecter, c'est déjà trop tard — il en a vu une seconde ou deux. On veut sauter **avant** qu'il le voie.

Solution : on triche en **regardant la vidéo en avance**.

YouTube ne te livre pas la vidéo image par image au moment où tu la regardes. Il télécharge à l'avance plusieurs dizaines de secondes (parfois une minute entière) pour que la vidéo ne se coupe pas si ta connexion ralentit. C'est ce qu'on appelle le **buffer** (la "mémoire tampon").

Notre extension se branche sur ce flux : pendant que YouTube reçoit les morceaux de vidéo en avance, on en prend une copie, on la décode discrètement de notre côté, et on regarde si le texte sponsorisé apparaît dans ces images futures. Quand le spectateur arrive enfin à ce moment de la vidéo, on a déjà tout préparé : on connaît le début, la fin, et on saute.

C'est comme un assistant qui lirait le livre quelques pages à l'avance pour te prévenir des passages chiants.

---

## 4. Comment ça fonctionne concrètement, étape par étape

### Étape 1 — On se branche sur le flux vidéo

YouTube utilise une fonction du navigateur appelée **MSE** (Media Source Extensions) pour alimenter le lecteur en vidéo. À chaque fois qu'un nouveau morceau arrive du serveur, YouTube appelle une fonction nommée `appendBuffer` (littéralement "ajouter au tampon").

On modifie cette fonction au démarrage de la page : à chaque appel, on fait une copie du morceau pour nous, puis on laisse YouTube faire son travail normal. YouTube ne se rend compte de rien.

### Étape 2 — On reconnaît le format des morceaux

Les morceaux qu'on a copiés sont des données compressées dans un **container** (boîte qui emballe le flux vidéo). Selon le système d'exploitation :

- Le plus souvent, YouTube envoie du **MP4 fragmenté** — y compris sous Linux
  depuis 2026, avec un codec récent appelé AV1.
- Plus rarement, du **WebM** (un autre format de container), qui était la norme
  sous Linux jusque-là.

On a un petit programme (`mp4demux.js`) qui sait ouvrir les deux. Le tout premier morceau, appelé **init segment**, contient la "fiche d'identité" de la vidéo : sa résolution (ex. 1920×1080), son codec (la méthode de compression : VP9, H.264…), sa cadence d'images. Les morceaux suivants, appelés **media segments**, contiennent les images proprement dites.

### Étape 3 — On décode les images

Chaque media segment contient plusieurs images compressées. On utilise une fonction récente du navigateur appelée **WebCodecs** (une boîte à outils standard pour décoder de la vidéo) pour transformer ces données compressées en vraies images visibles.

On ne décode pas TOUTES les images — ce serait inutile et coûteux. On ne prend qu'une **keyframe** (image-clé) toutes les 5 secondes. Une keyframe est une image complète qui ne dépend d'aucune autre, donc on peut la décoder isolément ; c'est juste assez pour voir le texte sponsorisé s'il est là.

### Étape 4 — On cherche le texte dans l'image

Une fois qu'on a une vraie image, on n'en garde que les **quatre coins**, découpés petits puis fortement agrandis et assemblés côte à côte en une seule image. C'est là que le texte de divulgation se trouve, et il y est minuscule : sur une image entière, l'OCR ne rend que du charabia. On agrandit donc les coins pour que les lettres deviennent assez grosses pour être lues, tout en n'ayant qu'une seule image à analyser au lieu de quatre.

Un détail compte plus qu'il n'y paraît : chaque coin est agrandi **en respectant ses proportions**. Pendant un temps ils étaient étirés en hauteur de 66 %, ce qui déformait les lettres et faisait chuter la reconnaissance.

Sur cette bande, on lance de l'**OCR** (Optical Character Recognition — reconnaissance optique de caractères : transformer une image de texte en texte lisible par ordinateur). Deux moteurs sont disponibles :

- **TextDetector** : un moteur intégré au navigateur, très rapide (~10 ms par image), disponible sur la plupart des Chromium récents.
- **Tesseract** : un moteur classique, gros (~20 Mo), beaucoup plus lent (~300 ms) mais qui fonctionne partout. C'est notre filet de sécurité.

Le texte récupéré est nettoyé (les accents enlevés, mis en minuscules) puis comparé à la liste des mots-clés ("collaboration commerciale", "sponsor", "publicité"…).

### Étape 5 — On enregistre la zone sponsorisée

Quand le texte est trouvé sur une image à 1m23s et qu'il disparaît à 1m48s, on note dans une petite liste interne : "segment sponsorisé entre 1m23 et 1m48".

### Étape 6 — On saute pendant la lecture

Pendant que le spectateur regarde la vidéo normalement, un petit surveillant (`SkipController`) vérifie 4 fois par seconde où en est la lecture. Si la position courante tombe dans une zone enregistrée, il déplace la lecture juste après la fin de la zone. Une petite notification s'affiche : "Segment commercial sauté".

---

## 5. Vocabulaire : les mots du métier

| Terme | Définition simple |
|-------|-------------------|
| **Extension** | Petit programme qui s'ajoute au navigateur pour modifier ou améliorer le comportement des sites web. |
| **Manifest V3** | La norme actuelle imposée par Chrome pour le format des extensions. Notre `manifest.json` suit ces règles. |
| **MSE** (Media Source Extensions) | API du navigateur que YouTube utilise pour alimenter son lecteur vidéo morceau par morceau au lieu de charger un fichier d'un coup. |
| **Buffer** | Mémoire tampon. Sur YouTube, c'est l'avance de vidéo téléchargée mais pas encore regardée (typiquement 15 à 60 secondes). |
| **`appendBuffer`** | La fonction que YouTube appelle pour rajouter un morceau de vidéo au lecteur. C'est l'endroit qu'on intercepte. |
| **Interceptor** | Notre petit programme qui se substitue à `appendBuffer` pour faire passer le travail normal *et* nous donner une copie au passage. |
| **Container** | Format de fichier qui emballe le flux vidéo (et l'audio, les sous-titres…). Les deux qu'on rencontre : MP4 et WebM. |
| **Codec** | Méthode de compression de la vidéo elle-même. YouTube utilise AV1 (`av01`), H.264 (`avc1`) ou VP9 (`vp09`) selon les cas. Le container *contient* le codec. |
| **fMP4** | Une variante de MP4 ("fragmented MP4") où le fichier est découpé en petits morceaux indépendants. Adapté au streaming. |
| **WebM** | Un container alternatif au MP4, basé sur la norme **Matroska/EBML**. Longtemps utilisé par YouTube sous Linux, aujourd'hui minoritaire. |
| **EBML** | Format de stockage en blocs étiquetés utilisé par WebM. Sa particularité : les blocs peuvent avoir une taille "inconnue" (élément qui s'étend jusqu'à la fin du flux), ce qui complique la lecture. |
| **Init segment** | Le tout premier morceau d'une vidéo, qui décrit ses caractéristiques (résolution, codec…). Sans lui, on ne peut pas décoder les morceaux suivants. |
| **Media segment** | Les morceaux qui suivent l'init segment et qui contiennent les vraies images compressées. |
| **Keyframe** (image-clé) | Image complète, autonome, qui ne dépend d'aucune autre. Toutes les ~2 secondes en moyenne. C'est ce qu'on décode pour faire de l'OCR. |
| **WebCodecs** | API moderne du navigateur pour décoder de la vidéo image par image. C'est ce qui transforme nos morceaux compressés en vraies images. |
| **OCR** (Optical Character Recognition) | Lecture automatique de texte dans une image. On en a deux : TextDetector (rapide, intégré) et Tesseract (lent, mais marche partout). |
| **Canvas** | Une surface de dessin invisible en mémoire. On y "pose" l'image décodée pour pouvoir la rogner et l'envoyer à l'OCR. |
| **`postMessage`** | Méthode standard pour faire communiquer deux parties d'un site web qui sont isolées l'une de l'autre. On l'utilise partout pour passer les données entre nos différents morceaux. |
| **Iframe** | Une mini-page web embarquée dans une autre. Sert à isoler du code dans son propre environnement. On en utilise deux : une pour le décodage vidéo, une pour Tesseract. |
| **Sandbox** | "Bac à sable", environnement isolé où du code peut tourner sans contaminer le reste. Nos iframes sont des sandboxes. |
| **CSP** (Content Security Policy) | Règles de sécurité du navigateur qui interdisent par défaut certaines opérations dangereuses (comme exécuter du WASM). YouTube a une CSP stricte qui nous oblige à mettre Tesseract dans une iframe d'extension où on contrôle la CSP. |
| **WASM** (WebAssembly) | Technologie qui permet d'exécuter du code compilé (rapide) dans le navigateur. Tesseract est compilé en WASM. |
| **MAIN world / ISOLATED world** | Deux univers JavaScript distincts dans lesquels une extension Chrome peut tourner. MAIN partage tout avec la page (nécessaire pour intercepter les fonctions de YouTube). ISOLATED est un univers privé pour l'extension. On utilise les deux. |
| **`document_start` / `document_idle`** | Deux moments où une extension peut démarrer son code : `document_start` = avant que la page commence à s'exécuter (utile pour intercepter), `document_idle` = quand la page a fini de charger (plus simple à manipuler). |

---

## 6. Plan général du système

```
              YouTube (la page)
                    │
                    │ télécharge des morceaux de vidéo
                    ▼
              SourceBuffer.appendBuffer  ← on l'a remplacée
                    │
            ┌───────┴────────┐
            │                │
   YouTube reçoit        Notre interceptor
   normalement           prend une copie
                              │
                              ▼
                      content/*.js  (le chef d'orchestre)
                              │
                              ├── envoie le morceau à
                              ▼
                      decoder-sandbox  (iframe cachée)
                              │  utilise WebCodecs + mp4demux
                              │  pour extraire des images
                              ▼
                      images décodées
                              │
                              ▼
                      FrameClassifier  (OCR)
                              │  cherche les mots-clés
                              ▼
                      SegmentStore  (liste des zones)
                              │
                              ▼
                      SkipController  (fait avancer la vidéo
                                        au bon moment)
```

---

## 7. État actuel du projet (au 2 septembre 2026)

### Ce qui marche
- **L'interception de la vidéo** : on capture bien les morceaux que YouTube reçoit, y compris quand il en coupe un en plusieurs envois.
- **Le décodage** : les images sont extraites correctement, sur les deux formats de container.
- **La lecture du texte** : l'OCR reconnaît la mention sur environ **quatre images sur cinq** où elle est présente.
- **Le saut automatique** : sur la vidéo de référence, l'extension fait disparaître **environ 92 % du passage sponsorisé**, en trois sauts. Sur les 68 secondes de pub, le spectateur en voit à peu près cinq.

### Ce qui a changé récemment

Le projet a connu une revue de code complète en août-septembre 2026, qui a mené à quatre chantiers.

**Du ménage.** Beaucoup de code ne servait plus : des fonctions qu'aucun chemin n'atteignait, des réglages que plus personne ne lisait, un composant d'arrière-plan sans aucun usage. L'extension ne demande d'ailleurs plus **aucune permission** au navigateur.

**Deux corrections qui ont amélioré la lecture du texte.** L'image envoyée à l'OCR était d'abord rétrécie avant d'être ré-agrandie, ce qui détruisait du détail sur un texte déjà petit ; et les coins étaient étirés en hauteur, ce qui déformait les lettres. Les deux sont corrigés.

**Une réorganisation.** Le fichier principal faisait près de deux mille lignes et mélangeait tout. Il est maintenant découpé en treize fichiers, un par sujet, ce qui rend le code lisible par quelqu'un qui ne l'a pas écrit. Une cinquantaine de tests automatiques ont été ajoutés au passage.

**Un changement de stratégie.** L'extension cherchait la mention à deux endroits : dans l'image, et dans la page HTML de YouTube — cette dernière étant remplie quand un créateur *déclare* officiellement sa promotion. La mesure a tranché : sur quinze essais enregistrés, cette seconde voie n'a **jamais rien trouvé**, parce que les créateurs incrustent le mot dans la vidéo au lieu de le déclarer. Elle a été supprimée, et l'extension se concentre entièrement sur la lecture de l'image.

### Ce qui reste comme limites connues
- **Si l'OCR ne fonctionne pas, plus rien ne détecte.** C'est la contrepartie du changement de stratégie ci-dessus. Les données de reconnaissance sont désormais **livrées avec l'extension** au lieu d'être téléchargées au premier lancement, ce qui supprime la seule dépendance réseau ; et quand le moteur refuse quand même de démarrer, il réessaie tout seul en espaçant ses tentatives, sans jamais abandonner définitivement.
- **Tout ce qu'on sait vient d'une seule vidéo.** Les mesures citées plus haut portent sur une unique vidéo de référence. Rien ne garantit encore que les réglages tiennent sur d'autres formats, d'autres créateurs, d'autres formulations.
- **Les résultats varient d'un essai à l'autre.** Environ un essai sur quatre se passe moins bien que les autres, pour une raison identifiée : après un saut, la réserve d'avance est vidée et l'extension doit la reconstituer.
- **Le format AV1 sur WebM** n'est pas géré.
- **YouTube pourrait changer** sa façon de livrer les vidéos ou la formulation de ses mentions, ce qui casserait la détection. C'est une dépendance qu'on ne contrôle pas.

## 8. Résumé en 30 secondes pour expliquer à quelqu'un d'autre

> "C'est une extension Chrome qui regarde la vidéo YouTube en avance pendant qu'elle se télécharge, lit le texte qui apparaît à l'écran avec un système de reconnaissance de caractères, repère le marqueur 'collaboration commerciale', et fait avancer automatiquement la vidéo pour ne pas que tu voies le passage sponsorisé."

---

*Ce document est volontairement non-technique. Pour les détails de mise en œuvre (noms de fonctions, formats binaires, protocoles de messages), voir [ARCHITECTURE.md](ARCHITECTURE.md).*
