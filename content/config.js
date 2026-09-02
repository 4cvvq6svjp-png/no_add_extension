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
    // Commit proactif d'un segment autour de chaque détection (look-ahead) :
    // marge avant + fenêtre en avant, fusionnées au fil des détections.
    segmentStartPadSeconds: 8,
    // Projection AVEUGLE en avant sur une détection. Volontairement courte (~1
    // GOP) : c'est la sonde qui établit la vraie fin de pub. Une valeur large
    // faisait dépasser la fin réelle d'autant sur la dernière frame positive.
    segmentForwardSeconds: 5,
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

    /* --- Plafonds et seuils d'abandon --------------------------------- */
    maxCapturedSegments: 30,
    maxMp4AccumBytes: 8_000_000,
    maxConfigureFailures: 3,
    maxTesseractFailures: 5,

    /* --- Timeouts des sandboxes --------------------------------------- */
    decoderReadyTimeoutMs: 15000,
    decoderRequestTimeoutMs: 30000,
    ocrReadyTimeoutMs: 25000,
    ocrInitTimeoutMs: 120000,
    ocrRequestTimeoutMs: 90000
  };

  /**
   * Formulations de disclosure recherchées, écrites sans accent : la
   * comparaison se fait sur du texte normalisé (voir util.js).
   *
   * La recherche est par SOUS-CHAÎNE, donc « sponsor » couvre déjà « contenu
   * sponsorisé », « vidéo sponsorisée » et « sponsorisé par » — les lister
   * séparément n'ajoutait aucune détection.
   */
  const COMMERCIAL_KEYWORDS = [
    "collaboration commerciale",
    "communication commerciale",
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
