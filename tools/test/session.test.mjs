/**
 * Correctifs E1 à E3 : ré-entrance du montage de session, borne basse évincée
 * de la sonde, et honnêteté de la valeur de retour de SegmentStore.addSegment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, loadContentScript } from "./dom-stub.mjs";

const dom = installDomStub();
const {
  CONFIG, NoAddYouTubeController, MseSegmentBuffer, AdEndProbe, SegmentStore
} = loadContentScript();

/* --------------------------------------------------------------------- */
/*  E1 — deux navigations concurrentes                                    */
/* --------------------------------------------------------------------- */

/** Intervalles encore vivants à une cadence donnée. */
function liveTimers(ms) {
  return dom.timers.filter((timer) => !timer.cleared && timer.ms === ms).length;
}

test("deux montages concurrents ne laissent qu'une seule session vivante", async () => {
  const controller = new NoAddYouTubeController();
  const heartbeatsBefore = liveTimers(CONFIG.heartbeatMs);

  // Les trois sources de navigation (yt-navigate-finish, popstate, watcher
  // d'URL) peuvent se déclencher coup sur coup : les deux montages entrent
  // avant que le premier n'ait fini d'attendre son <video>.
  await Promise.all([
    controller.setupSession("videoA"),
    controller.setupSession("videoB")
  ]);

  assert.equal(controller.currentVideoId, "videoB", "la dernière navigation gagne");
  assert.equal(
    liveTimers(CONFIG.heartbeatMs) - heartbeatsBefore,
    1,
    "un scanner orphelin laisserait son heartbeat tourner"
  );

  controller.teardownSession();
  assert.equal(liveTimers(CONFIG.heartbeatMs) - heartbeatsBefore, 0);
});

test("trois montages concurrents : seul le dernier est publié", async () => {
  const controller = new NoAddYouTubeController();
  const heartbeatsBefore = liveTimers(CONFIG.heartbeatMs);

  await Promise.all(["a", "b", "c"].map((id) => controller.setupSession(id)));

  assert.equal(controller.currentVideoId, "c");
  assert.equal(liveTimers(CONFIG.heartbeatMs) - heartbeatsBefore, 1);
  controller.teardownSession();
});

/* --------------------------------------------------------------------- */
/*  E2 — borne basse évincée du buffer                                    */
/* --------------------------------------------------------------------- */

function armedProbe({ segmentCount = 6, startTime = 100 } = {}) {
  const buffer = new MseSegmentBuffer({ onInitSegment() {}, onNewMediaSource() {} });
  buffer.initSegment = new ArrayBuffer(8);
  for (let i = 0; i < segmentCount; i++) {
    buffer.enqueue(new ArrayBuffer(8), 0);
  }
  const segmentStore = new SegmentStore({
    mergeGapSeconds: CONFIG.mergeGapSeconds,
    minSegmentSeconds: CONFIG.minSegmentSeconds
  });
  const probe = new AdEndProbe({
    buffer,
    segmentStore,
    mainVideo: { currentTime: startTime },
    sourceTag: "ahead-ocr",
    startTime,
    firstSegment: buffer.segments[0]
  });
  return { buffer, probe, segmentStore };
}

test("la sonde abandonne quand sa borne basse a été évincée", () => {
  const { buffer, probe } = armedProbe();
  probe.lastPositiveTime = 140;

  // L'éviction ne décale pas seulement les indices : elle fait disparaître des
  // seq. Celui du dernier positif n'est plus dans la file.
  buffer.segments = buffer.segments.slice(3);

  assert.equal(probe.pickSegment(), null);
  assert.equal(probe.finished, true, "la sonde se termine");
  assert.equal(probe.resolved, false, "mais sans avoir localisé la fin");
  assert.equal(probe.resumeTime, 140, "le séquentiel reprend au dernier point sûr");
});

test("une sonde abandonnée n'accepte plus de résultat", () => {
  const { buffer, probe } = armedProbe();
  buffer.segments = buffer.segments.slice(3);
  probe.pickSegment();

  const before = probe.lastPositiveTime;
  probe.consumeResult(buffer.segments[0], 200, { hasCommercialKeyword: true });
  assert.equal(probe.lastPositiveTime, before);
});

test("une sonde résolue reste distinguable d'une sonde abandonnée", () => {
  const { buffer, probe } = armedProbe();

  for (const index of [1, 2]) buffer.segments[index].scanned = true;
  probe.consumeResult(buffer.segments[1], 140, { hasCommercialKeyword: false });
  probe.consumeResult(buffer.segments[2], 150, { hasCommercialKeyword: false });

  assert.equal(probe.finished, true);
  assert.equal(probe.resolved, true);
  assert.equal(probe.resumeTime, 140, "reprise après la fin de pub localisée");
});

/* --------------------------------------------------------------------- */
/*  E3 — valeur de retour d'addSegment                                    */
/* --------------------------------------------------------------------- */

test("un segment absorbé sans rien changer renvoie false", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  assert.equal(store.addSegment({ start: 100, end: 120, source: "ahead-ocr" }), true);

  assert.equal(
    store.addSegment({ start: 105, end: 115, source: "ahead-ocr" }),
    false,
    "entièrement contenu dans l'existant, même source"
  );
  assert.deepEqual(store.getAll().map((s) => [s.start, s.end]), [[100, 120]]);
});

test("un segment qui étend réellement la fin renvoie true", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  store.addSegment({ start: 100, end: 120, source: "ahead-ocr" });

  assert.equal(store.addSegment({ start: 105, end: 130, source: "ahead-ocr" }), true);
  assert.equal(store.getAll()[0].end, 130);
});

test("une absorption qui ajoute une source compte comme un changement", () => {
  const store = new SegmentStore({ mergeGapSeconds: 20, minSegmentSeconds: 3 });
  store.addSegment({ start: 100, end: 120, source: "ahead-ocr" });

  assert.equal(store.addSegment({ start: 105, end: 115, source: "dom-overlay" }), true);
  assert.equal(store.getAll()[0].source, "ahead-ocr+dom-overlay");
});
