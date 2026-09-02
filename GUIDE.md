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

- Sous Windows et Mac, YouTube envoie du **MP4 fragmenté** (extension `.mp4`).
- Sous Linux, YouTube envoie du **WebM** (un autre format de container).

On a un petit programme (`mp4demux.js`) qui sait ouvrir les deux. Le tout premier morceau, appelé **init segment**, contient la "fiche d'identité" de la vidéo : sa résolution (ex. 1920×1080), son codec (la méthode de compression : VP9, H.264…), sa cadence d'images. Les morceaux suivants, appelés **media segments**, contiennent les images proprement dites.

### Étape 3 — On décode les images

Chaque media segment contient plusieurs images compressées. On utilise une fonction récente du navigateur appelée **WebCodecs** (une boîte à outils standard pour décoder de la vidéo) pour transformer ces données compressées en vraies images visibles.

On ne décode pas TOUTES les images — ce serait inutile et coûteux. On ne prend qu'une **keyframe** (image-clé) toutes les 5 secondes. Une keyframe est une image complète qui ne dépend d'aucune autre, donc on peut la décoder isolément ; c'est juste assez pour voir le texte sponsorisé s'il est là.

### Étape 4 — On cherche le texte dans l'image

Une fois qu'on a une vraie image, on en prend uniquement la **bande du haut** (le quart supérieur), parce que le texte de divulgation YouTube apparaît toujours en haut. Ça réduit énormément le travail.

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
| **Codec** | Méthode de compression de la vidéo elle-même. YouTube utilise H.264 (`avc1`) ou VP9 (`vp09`) selon les cas. Le container *contient* le codec. |
| **fMP4** | Une variante de MP4 ("fragmented MP4") où le fichier est découpé en petits morceaux indépendants. Adapté au streaming. |
| **WebM** | Un container alternatif au MP4, basé sur la norme **Matroska/EBML**. Utilisé par YouTube sous Linux. |
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

## 7. État actuel du projet (au 7 mai 2026)

### Ce qui marche
- L'interception de la vidéo : on capture bien les morceaux que YouTube reçoit.
- Le décodage MP4 (Windows/Mac) : on extrait correctement les images.
- L'OCR : la lecture du texte sur les images fonctionne.
- Le saut automatique : quand une zone est enregistrée, le saut se déclenche bien.

### Ce qui vient d'être réparé
Quatre bugs ont été corrigés récemment :

1. **Décodage WebM (Linux) cassé.** Le programme qui lit les fichiers WebM s'arrêtait trop tôt parce qu'il rencontrait un bloc de "taille inconnue" (`size = -1`) dans la structure du fichier. Sur Linux, YouTube envoie justement ce type de fichier, donc rien ne fonctionnait. → Corrigé en réécrivant la lecture pour qu'elle continue à chercher dans les blocs de taille inconnue au lieu de s'arrêter.

2. **Copie tardive du morceau vidéo.** L'interceptor faisait sa copie **après** avoir donné la donnée à YouTube. Selon les cas, le navigateur pouvait avoir effacé la donnée entretemps : on copiait du vide. → Corrigé en faisant la copie **avant** de transmettre à YouTube.

3. **Course entre deux configurations.** Si YouTube changeait la qualité d'une vidéo en plein milieu (passage de 1080p à 720p, par exemple), notre décodeur pouvait se retrouver configuré pour l'ancienne qualité tout en lisant les nouvelles données → erreur. Corrigé en comparant l'identité de l'init segment avant et après chaque configuration.

4. **Logs de débogage très bruyants.** Le code de lecture WebM imprimait une trentaine de messages dans la console à chaque vidéo. → Nettoyé.

### Ce qui reste comme limites connues
- **Tesseract télécharge ses données depuis un site externe** au premier lancement. Sur les machines où le moteur rapide intégré au navigateur fonctionne, on n'en a pas besoin, mais c'est une dépendance réseau qui pourrait être éliminée en intégrant les données dans l'extension (~1,3 Mo).
- **Le format AV1 sur WebM** (un autre codec récent) n'est pas encore géré.
- **YouTube pourrait changer sa façon de marquer les vidéos** ou la position du texte de divulgation, ce qui casserait la détection. C'est une dépendance qu'on ne contrôle pas.

---

## 8. Résumé en 30 secondes pour expliquer à quelqu'un d'autre

> "C'est une extension Chrome qui regarde la vidéo YouTube en avance pendant qu'elle se télécharge, lit le texte qui apparaît à l'écran avec un système de reconnaissance de caractères, repère le marqueur 'collaboration commerciale', et fait avancer automatiquement la vidéo pour ne pas que tu voies le passage sponsorisé."

---

*Ce document est volontairement non-technique. Pour les détails de mise en œuvre (noms de fonctions, formats binaires, protocoles de messages), voir [ARCHITECTURE.md](ARCHITECTURE.md).*
