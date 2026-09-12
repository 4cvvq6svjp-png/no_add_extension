/** Logique pure du content script : amorçage, ROI OCR, mots-clés, segments. */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, loadContentScript } from "./dom-stub.mjs";

const dom = installDomStub();
const {
  CONFIG,
  SegmentStore,
  RoiComposer,
  extractCommercialKeywords,
  combineSources
} = loadContentScript();

/* --------------------------------------------------------------------- */
/*  Amorçage                                                              */
/* --------------------------------------------------------------------- */

test("une session s'initialise sans erreur sur une page /watch", async () => {
  await new Promise((resolve) => queueMicrotask(() => setImmediate(resolve)));

  assert.ok(dom.logs.some((line) => line.includes("Session initialisée")));
  assert.ok(dom.logs.some((line) => line.includes("AheadScanner démarré")));
  assert.deepEqual(dom.warns, [], "aucun avertissement à l'amorçage");
});

test("les cadences périodiques viennent toutes de CONFIG", () => {
  const cadences = dom.timers.map((timer) => timer.ms).sort((a, b) => a - b);
  assert.deepEqual(cadences, [
    CONFIG.skipPollMs,
    CONFIG.urlWatchPollMs,
    CONFIG.heartbeatMs
  ].sort((a, b) => a - b));
});

test("chaque module trouve ses dépendances dans l'ordre du manifeste", () => {
  const expected = [
    "CONFIG", "COMMERCIAL_KEYWORDS", "logInfo", "logWarn", "normalizeText",
    "extractCommercialKeywords", "combineSources", "sleep", "formatError",
    "waitForVideoElement", "getVideoIdFromCurrentUrl", "noDetection",
    "SegmentStore", "PlayerNotifier", "SandboxBridge",
    "RoiComposer", "TesseractOcr", "FrameClassifier", "MseSegmentBuffer",
    "DecoderSandbox", "AdEndProbe", "AheadScanner", "SkipController"
  ];

  const missing = expected.filter((name) => globalThis.__NoAdd[name] === undefined);
  assert.deepEqual(missing, [], "un module publie moins que prévu");
});

/* --------------------------------------------------------------------- */
/*  Composite OCR                                                         */
/* --------------------------------------------------------------------- */

test("le composite OCR conserve le ratio du crop", () => {
  const composer = new RoiComposer();
  assert.equal(composer.compose({ width: 1920, height: 1080 }), true);

  const draws = composer.ctx.draws;
  assert.equal(draws.length, 4, "un dessin par coin");

  const [first] = draws;
  const cropRatio = first.sw / first.sh;
  const cellRatio = first.dw / first.dh;
  assert.ok(
    Math.abs(cropRatio - cellRatio) / cropRatio < 0.01,
    `ratio crop ${cropRatio.toFixed(3)} vs cellule ${cellRatio.toFixed(3)} : ` +
    "une cellule au ratio libre étire les glyphes et fait chuter l'OCR"
  );
});

test("les coins sont lus à la résolution native de la source", () => {
  const composer = new RoiComposer();
  composer.compose({ width: 1920, height: 1080 });

  const cropWidth = Math.round(1920 * CONFIG.ocrCornerWidthFraction);
  const cropHeight = Math.round(1080 * CONFIG.ocrCornerHeightFraction);

  assert.deepEqual(
    composer.ctx.draws.map((draw) => [draw.sx, draw.sy, draw.sw, draw.sh]),
    [
      [0, 0, cropWidth, cropHeight],
      [1920 - cropWidth, 0, cropWidth, cropHeight],
      [0, 1080 - cropHeight, cropWidth, cropHeight],
      [1920 - cropWidth, 1080 - cropHeight, cropWidth, cropHeight]
    ]
  );
});

test("le composite s'adapte à la définition de la source", () => {
  const composer = new RoiComposer();

  composer.compose({ width: 1920, height: 1080 });
  const fullHd = [composer.canvas.width, composer.canvas.height];

  composer.compose({ width: 640, height: 480 });
  const smallSource = [composer.canvas.width, composer.canvas.height];

  assert.equal(fullHd[0], CONFIG.ocrCompositeWidth);
  assert.equal(smallSource[0], CONFIG.ocrCompositeWidth);
  assert.notDeepEqual(fullHd, smallSource, "le ratio 16:9 et le 4:3 ne donnent pas la même hauteur");
});

test("une source sans dimensions est refusée au lieu d'être analysée", () => {
  const composer = new RoiComposer();
  assert.equal(composer.compose({ width: 0, height: 0 }), false);
});

/* --------------------------------------------------------------------- */
/*  Mots-clés                                                             */
/* --------------------------------------------------------------------- */

test("les formulations réelles sont détectées", () => {
  const cases = [
    ["Contenu sponsorisé", ["sponsor"]],
    ["sponsorisé par ACME", ["sponsor"]],
    ["Collaboration commerciale", ["collaboration", "commercial"]],
    ["COLLABORATION COMMERCIALE", ["collaboration", "commercial"]],
    ["COMMUNICATION COMMERCIALE", ["commercial"]],
    ["Partenariat rémunéré", ["partenariat remunere"]],
    ["Publicité", ["publicite"]],
    ["une vidéo tout à fait normale", []],
    ["", []]
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(extractCommercialKeywords(text).sort(), expected.sort(), text);
  }
});

test("un mot-clé isolé suffit : le premier mot est souvent illisible", () => {
  // Le bandeau écrit « COLLABORATION » en graisse fine et « COMMERCIALE » en
  // gras ; la binarisation ne laisse que le second. Exiger la locution
  // complète faisait échouer 5 vidéos du corpus sur 10.
  assert.deepEqual(extractCommercialKeywords("COMMERCIALE"), ["commercial"]);
  assert.deepEqual(extractCommercialKeywords("LABORATION COMMERCIALE"), ["commercial"]);
});

test("les quasi-mots produits par l'OCR sont rattrapés", () => {
  // Tous relevés dans les logs du corpus.
  for (const lu of ["publhocité", "publicito", "publicte"]) {
    assert.deepEqual(extractCommercialKeywords(lu), ["publicite"], lu);
  }
  // Mot amputé par le crop, observé sur FOrRFw9PPvw.
  assert.deepEqual(extractCommercialKeywords("Collaboration commercia").sort(),
                   ["collaboration", "commercial"]);
});

test("le budget d'erreurs reste proportionnel : les mots courts sont stricts", () => {
  // « sponsor » (7 lettres) n'a droit qu'à une faute.
  assert.deepEqual(extractCommercialKeywords("sponsar"), ["sponsor"]);
  assert.deepEqual(extractCommercialKeywords("spinsar"), [], "deux fautes : refusé");
});

test("le bruit OCR ne déclenche rien", () => {
  // Textes réellement lus hors fenêtres de pub dans le corpus.
  for (const bruit of ["nf", "l -", "Yrrif.", "A8 fee fear TS 4 JA", "(4/2)",
                       "amazon music", "— me »", "Pine 9 * + | Ju 4;"]) {
    assert.deepEqual(extractCommercialKeywords(bruit), [], bruit);
  }
});

test("approximateDistance cherche une sous-chaîne, pas la chaîne entière", () => {
  const { approximateDistance } = globalThis.__NoAdd;

  assert.equal(approximateDistance("xx publicite yy", "publicite"), 0, "présent tel quel");
  assert.equal(approximateDistance("xx publhocite yy", "publicite"), 2, "une insertion, une substitution");
  assert.equal(approximateDistance("", "publicite"), 9, "texte vide : tout le mot manque");
  assert.equal(approximateDistance("pu", "publicite"), 7, "texte trop court pour matcher");
});

/* --------------------------------------------------------------------- */
/*  SegmentStore                                                          */
/* --------------------------------------------------------------------- */

test("un segment plus court que minSegmentSeconds est rejeté", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  assert.equal(store.addSegment({ start: 10, end: 12 }), false);
  assert.equal(store.getAll().length, 0);
});

test("les segments proches fusionnent et cumulent leurs sources", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  store.addSegment({ start: 100, end: 110, source: "ahead-ocr" });
  store.addSegment({ start: 125, end: 140, source: "main-video-ocr" });

  assert.deepEqual(
    store.getAll().map((segment) => [segment.start, segment.end, segment.source]),
    [[100, 140, "ahead-ocr+main-video-ocr"]]
  );
});

test("les segments éloignés restent distincts", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  store.addSegment({ start: 100, end: 110, source: "ahead-ocr" });
  store.addSegment({ start: 300, end: 320, source: "ahead-ocr" });

  assert.equal(store.getAll().length, 2);
});

test("findSegmentForTime borne à droite et rejette les temps non finis", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  store.addSegment({ start: 100, end: 110, source: "ahead-ocr" });

  assert.equal(store.findSegmentForTime(105).end, 110);
  assert.equal(store.findSegmentForTime(100).end, 110);
  assert.equal(store.findSegmentForTime(110), null, "la borne haute est exclue");
  assert.equal(store.findSegmentForTime(50), null);
  assert.equal(store.findSegmentForTime(NaN), null);
});

test("combineSources dédoublonne les étiquettes", () => {
  assert.equal(combineSources("a+b", "b+c"), "a+b+c");
  assert.equal(combineSources("ahead-ocr", "ahead-ocr"), "ahead-ocr");
});

/* --------------------------------------------------------------------- */
/*  Binarisation adaptative                                              */
/* --------------------------------------------------------------------- */

test("compose accepte un mode adaptatif sans changer la géométrie", () => {
  const composer = new RoiComposer();
  const source = { width: 1920, height: 1080 };

  assert.equal(composer.compose(source), true);
  const fixe = [composer.canvas.width, composer.canvas.height];
  const drawsFixe = composer.ctx.draws.length;

  assert.equal(composer.compose(source, { adaptive: true }), true);
  assert.deepEqual([composer.canvas.width, composer.canvas.height], fixe,
    "le mode adaptatif ne touche qu'au seuil, pas au découpage");
  assert.equal(composer.ctx.draws.length, drawsFixe * 2, "toujours 4 coins dessinés");
});
