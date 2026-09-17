/**
 * Réglages et constantes partagées.
 *
 * Tout ce qui se règle vit ici : seuils de détection, cadences, timeouts des
 * sandboxes, et les formulations de disclosure recherchées.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});

  const EXTENSION_TAG = "[NoAddExtension]";

  const OCR_MESSAGE_CHANNEL = "no-add-extension-ocr";

  const MSE_CHANNEL = "no-add-mse-intercept";

  const DECODER_CHANNEL = "no-add-decoder";

  const CONFIG = {
    frameSampleSeconds: 4,
    minSegmentSeconds: 3,
    // Le texte de disclosure est présent PENDANT TOUTE la pub : une détection
    // signale un état continu « pub en cours ». On fusionne donc agressivement
    // les détections espacées pour couvrir l'intégralité du segment.
    mergeGapSeconds: 20,
    skipMarginSeconds: 0.4,
    skipCooldownMs: 900,
    analysisPollMs: 1200,
    // OCR ciblé : le texte de disclosure (« Publicité »…) est petit et niché
    // dans un coin. On crope SERRÉ chaque coin (petite fraction) et on l'upscale
    // fortement dans une grande cellule → le texte devient assez gros pour que
    // Tesseract le lise de façon fiable sur (presque) chaque frame, en 1 passe.
    // La hauteur du composite est DÉRIVÉE du ratio du crop (voir RoiComposer) :
    // une cellule au ratio libre étirait les glyphes et faisait chuter l'OCR.
    ocrCornerWidthFraction: 0.30,
    ocrCornerHeightFraction: 0.18,
    ocrCompositeWidth: 1600,
    // Binarisation : le texte de disclosure est quasi-blanc. On ne garde que
    // les pixels très clairs (texte) → noir sur blanc, lisible par Tesseract.
    ocrBinarizeThreshold: 190,
    // Certains créateurs affichent un texte SOMBRE sur une boîte claire :
    // le seuil fixe efface alors tout. Quand la première passe ne trouve rien,
    // on recompose avec un seuil calculé par cellule (Otsu) et on réessaie.
    // Une seconde passe seulement sur les frames qui échouaient déjà : aucune
    // régression possible sur celles qui fonctionnent, et aucun coût ajouté
    // quand la détection réussit du premier coup.
    ocrAdaptiveFallback: true,
    // Commit proactif d'un segment autour de chaque détection (look-ahead) :
    // marge avant + fenêtre en avant, fusionnées au fil des détections.
    segmentStartPadSeconds: 8,
    // Projection AVEUGLE en avant sur une détection ; c'est la sonde qui
    // établit ensuite la vraie fin de pub.
    //
    // Longtemps réglée à 5 (~1 GOP) par crainte de dépasser la fin réelle. La
    // mesure a montré l'inverse : à 5, le dernier saut s'arrêtait AVANT la fin
    // de la pub dans 13 runs sur 18, et cette queue coûtait 34 % de toute la
    // pub vue. On sous-estimait, on ne débordait pas.
    //
    // A/B apparié sur 8 fenêtres (tools/ab-forward.mjs, les trois valeurs dos à
    // dos sur chaque vidéo pour neutraliser la dérive du réseau) :
    //
    //        pub vue   queue   contenu légitime perdu
    //   5     123,5s   26,3s   0,0s
    //  10     112,3s   17,2s   3,7s  (pire cas +3,4s)
    //  12     107,2s   10,7s   7,7s  (pire cas +3,5s)
    //
    // 10 prend l'essentiel du gain : passer de 5 à 10 économise 11,2s de pub
    // pour 3,7s de contenu mangé (3 pour 1), alors que 10 → 12 n'économise plus
    // que 5,1s pour 4,0s de plus (1,3 pour 1) — on y paie presque une seconde
    // de vraie vidéo par seconde de pub évitée.
    //
    // Le gain vient de la QUEUE, pas du nombre de sauts : celui-ci baisse bien
    // (53 → 46 → 38) mais le coût par saut monte d'autant (1,83 → 2,07 →
    // 2,54s), si bien que le poste « milieu » ne bouge pas.
    segmentForwardSeconds: 10,
    // Garde-fou anti sur-saut : au-delà de ce saut, la sonde exige 2 lectures
    // OCR positives distinctes avant d'étendre le segment. Pendant une vraie
    // pub le texte est permanent (confirmation immédiate) ; un faux positif
    // isolé ne peut donc pas faire sauter du contenu légitime.
    bigJumpThresholdSeconds: 20,
    probeMinPositivesForBigJump: 2,
    initTimeoutMs: 20000,

    /* --- Cadences et délais ------------------------------------------ */
    heartbeatMs: 5000,
    noMseDataTimeoutMs: 8000,
    skipPollMs: 220,
    skipDiagnosticThrottleMs: 10000,
    urlWatchPollMs: 900,
    notifierTimeoutMs: 2500,

    /* --- Correspondance des mots-clés --------------------------------- */
    // Budget d'erreurs toléré par mot-clé : longueur / diviseur, plafonné.
    // L'OCR insère et substitue des caractères (« publhocité » pour
    // « publicité ») et le crop peut amputer un mot (« commercia »). Un budget
    // proportionnel laisse les mots courts stricts — « sponsor » n'a droit
    // qu'à une erreur — tout en tolérant deux fautes sur « publicite ».
    keywordEditDivisor: 4,
    keywordMaxEdits: 2,

    /* --- Plafonds et seuils d'abandon --------------------------------- */
    maxCapturedSegments: 30,
    maxMp4AccumBytes: 8_000_000,
    maxConfigureFailures: 3,
    maxTesseractFailures: 5,

    /* --- Timeouts des sandboxes --------------------------------------- */
    decoderReadyTimeoutMs: 15000,
    decoderRequestTimeoutMs: 30000,
    ocrReadyTimeoutMs: 25000,
    // Premier démarrage : téléchargement du modèle `fra` compris. 120s était
    // démesuré pour une boucle de scan qui tourne toutes les 2s.
    ocrInitTimeoutMs: 60000,
    ocrRequestTimeoutMs: 90000,
    // Délai avant de retenter un démarrage raté, doublé à chaque échec puis
    // plafonné. Le plafond reste la cadence des tentatives de reprise.
    ocrRetryBaseDelayMs: 2000,
    ocrRetryMaxDelayMs: 60000
  };

  /**
   * Formulations de disclosure recherchées, écrites sans accent : la
   * comparaison se fait sur du texte normalisé et TOLÉRANT (voir util.js).
   *
   * Deux principes, tous deux issus de la mesure sur le corpus :
   *
   * - **Des mots isolés, pas des locutions.** « collaboration commerciale »
   *   s'affiche souvent avec le premier mot en graisse fine, que la
   *   binarisation détruit ; l'OCR ne rend alors que « COMMERCIALE ». Exiger
   *   la locution complète faisait échouer 5 vidéos sur 10 alors que le texte
   *   était parfaitement lu. Chercher les deux mots séparément a porté la
   *   détection de 4 à 9 vidéos sur 10.
   * - **Des radicaux courts.** « commercial » couvre « commerciale »,
   *   « commerciaux » et « communication commerciale ». Lister les locutions
   *   en plus n'ajoutait aucune détection : elles sont subsumées.
   */
  const COMMERCIAL_KEYWORDS = [
    "collaboration",
    "commercial",
    "partenariat remunere",
    "publicite",
    "sponsor"
  ];

  NoAdd.EXTENSION_TAG = EXTENSION_TAG;
  NoAdd.OCR_MESSAGE_CHANNEL = OCR_MESSAGE_CHANNEL;
  NoAdd.MSE_CHANNEL = MSE_CHANNEL;
  NoAdd.DECODER_CHANNEL = DECODER_CHANNEL;
  NoAdd.CONFIG = CONFIG;
  NoAdd.COMMERCIAL_KEYWORDS = COMMERCIAL_KEYWORDS;
})();
