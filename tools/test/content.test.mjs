/** Logique pure du content script : amorçage, ROI OCR, mots-clés, segments. */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, loadContentScript } from "./dom-stub.mjs";

const dom = installDomStub();
const {
  CONFIG,
  SegmentStore,
  FrameClassifier,
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
    CONFIG.overlayPollMs,
    CONFIG.urlWatchPollMs,
    CONFIG.heartbeatMs
  ].sort((a, b) => a - b));
});

/* --------------------------------------------------------------------- */
/*  Composite OCR                                                         */
/* --------------------------------------------------------------------- */

test("le composite OCR conserve le ratio du crop", () => {
  const classifier = new FrameClassifier();
  assert.equal(classifier.composeCorners({ width: 1920, height: 1080 }), true);

  const draws = classifier.roiCtx.draws;
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
  const classifier = new FrameClassifier();
  classifier.composeCorners({ width: 1920, height: 1080 });

  const cropWidth = Math.round(1920 * CONFIG.ocrCornerWidthFraction);
  const cropHeight = Math.round(1080 * CONFIG.ocrCornerHeightFraction);

  assert.deepEqual(
    classifier.roiCtx.draws.map((draw) => [draw.sx, draw.sy, draw.sw, draw.sh]),
    [
      [0, 0, cropWidth, cropHeight],
      [1920 - cropWidth, 0, cropWidth, cropHeight],
      [0, 1080 - cropHeight, cropWidth, cropHeight],
      [1920 - cropWidth, 1080 - cropHeight, cropWidth, cropHeight]
    ]
  );
});

test("le composite s'adapte à la définition de la source", () => {
  const classifier = new FrameClassifier();

  classifier.composeCorners({ width: 1920, height: 1080 });
  const fullHd = [classifier.roiCanvas.width, classifier.roiCanvas.height];

  classifier.composeCorners({ width: 640, height: 480 });
  const smallSource = [classifier.roiCanvas.width, classifier.roiCanvas.height];

  assert.equal(fullHd[0], CONFIG.ocrCompositeWidth);
  assert.equal(smallSource[0], CONFIG.ocrCompositeWidth);
  assert.notDeepEqual(fullHd, smallSource, "le ratio 16:9 et le 4:3 ne donnent pas la même hauteur");
});

test("une source sans dimensions est refusée au lieu d'être analysée", () => {
  const classifier = new FrameClassifier();
  assert.equal(classifier.composeCorners({ width: 0, height: 0 }), false);
});

/* --------------------------------------------------------------------- */
/*  Mots-clés                                                             */
/* --------------------------------------------------------------------- */

test("la liste réduite couvre toujours toutes les formulations", () => {
  const cases = [
    ["Contenu sponsorisé", ["sponsor"]],
    ["Vidéo sponsorisée", ["sponsor"]],
    ["sponsorisé par ACME", ["sponsor"]],
    ["Collaboration commerciale", ["collaboration commerciale"]],
    ["COMMUNICATION COMMERCIALE", ["communication commerciale"]],
    ["Partenariat rémunéré", ["partenariat remunere"]],
    ["Publicité", ["publicite"]],
    ["une vidéo tout à fait normale", []],
    ["", []]
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(extractCommercialKeywords(text), expected, text);
  }
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
  store.addSegment({ start: 125, end: 140, source: "dom-overlay" });

  assert.deepEqual(
    store.getAll().map((segment) => [segment.start, segment.end, segment.source]),
    [[100, 140, "ahead-ocr+dom-overlay"]]
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
