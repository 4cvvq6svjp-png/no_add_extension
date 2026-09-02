/**
 * Unités que le découpage (lot D) rend atteignables : le réassemblage fMP4 et
 * la sonde de fin de pub. Auparavant enfouies dans AheadScanner, elles étaient
 * hors de portée de tout test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, loadContentScript } from "./dom-stub.mjs";

installDomStub({ href: "https://www.youtube.com/" }); // pas de /watch : aucune session
const { CONFIG, MseSegmentBuffer, AdEndProbe, SegmentStore } = loadContentScript();

const encoder = new TextEncoder();

/** Boîte ISO BMFF avec un payload de `payloadSize` octets. */
function box(type, payloadSize) {
  const bytes = new Uint8Array(8 + payloadSize);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(encoder.encode(type), 4);
  return bytes;
}

function concat(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function newBuffer({ container = "mp4" } = {}) {
  const buffer = new MseSegmentBuffer({ onInitSegment() {}, onNewMediaSource() {} });
  buffer.initSegment = new ArrayBuffer(8);
  buffer.container = container;
  return buffer;
}

/** Simule un message du monde MAIN. */
function feed(buffer, bytes, timestampOffset = 0) {
  buffer.onMessage({
    data: {
      channel: "no-add-mse-intercept",
      type: "media-segment",
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      timestampOffset
    }
  });
}

/* --------------------------------------------------------------------- */
/*  Réassemblage fMP4                                                     */
/* --------------------------------------------------------------------- */

test("une unité moof+mdat livrée en un seul chunk est mise en file", () => {
  const buffer = newBuffer();
  feed(buffer, concat(box("moof", 16), box("mdat", 64)));

  assert.equal(buffer.segments.length, 1);
  assert.equal(buffer.segments[0].data.byteLength, 8 + 16 + 8 + 64);
});

test("une unité découpée sur plusieurs appendBuffer est recousue", () => {
  const buffer = newBuffer();
  const unit = concat(box("moof", 16), box("mdat", 64));

  // YouTube coupe au milieu du mdat : c'est le cas qui renvoyait 0 sample.
  feed(buffer, unit.subarray(0, 30));
  assert.equal(buffer.segments.length, 0, "rien n'est enfilé tant que le mdat est tronqué");

  feed(buffer, unit.subarray(30));
  assert.equal(buffer.segments.length, 1, "l'unité complète est enfilée après le second chunk");
  assert.equal(buffer.segments[0].data.byteLength, unit.length);
});

test("deux unités dans un même chunk donnent deux segments", () => {
  const buffer = newBuffer();
  feed(buffer, concat(box("moof", 8), box("mdat", 32), box("moof", 8), box("mdat", 48)));

  assert.equal(buffer.segments.length, 2);
  assert.deepEqual(
    buffer.segments.map((s) => s.data.byteLength),
    [8 + 8 + 8 + 32, 8 + 8 + 8 + 48]
  );
});

test("un changement de timestampOffset jette les octets partiels", () => {
  const buffer = newBuffer();
  const unit = concat(box("moof", 16), box("mdat", 64));

  feed(buffer, unit.subarray(0, 30), 0);
  // Un seek : la suite appartient à une autre timeline, on ne doit pas coudre.
  feed(buffer, unit, 12.5);

  assert.equal(buffer.segments.length, 1);
  assert.equal(buffer.segments[0].timestampOffset, 12.5);
});

test("les seq restent stables quand l'éviction décale les indices", () => {
  const buffer = newBuffer();
  for (let i = 0; i < CONFIG.maxCapturedSegments + 5; i++) {
    feed(buffer, concat(box("moof", 8), box("mdat", 8)));
  }

  assert.equal(buffer.segments.length, CONFIG.maxCapturedSegments);
  const first = buffer.segments[0];
  assert.equal(first.seq, 5, "les 5 premiers segments ont été évincés");
  assert.equal(buffer.indexOfSeq(first.seq), 0);
  assert.equal(buffer.indexOfSeq(4), -1, "un seq évincé est introuvable");
});

test("en WebM chaque append est un segment", () => {
  const buffer = newBuffer({ container: "webm" });
  feed(buffer, new Uint8Array(64));
  feed(buffer, new Uint8Array(64));

  assert.equal(buffer.segments.length, 2);
});

/* --------------------------------------------------------------------- */
/*  Sonde de fin de pub                                                   */
/* --------------------------------------------------------------------- */

function armedProbe({ segmentCount = 6, startTime = 100 } = {}) {
  const buffer = newBuffer();
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

const positive = { hasCommercialKeyword: true };
const negative = { hasCommercialKeyword: false };

test("sans borne haute, la sonde vise la frontière du buffer", () => {
  const { buffer, probe } = armedProbe();
  assert.equal(probe.pickSegment(), buffer.segments[5], "le segment le plus avancé");
});

test("dès qu'une borne existe, la sonde bissecte", () => {
  const { buffer, probe } = armedProbe();

  buffer.segments[5].scanned = true;
  probe.consumeResult(buffer.segments[5], 160, negative);

  assert.equal(probe.firstNegativeSeq, null, "un négatif isolé n'est qu'un candidat");
  assert.equal(probe.pendingNegativeSeq, buffer.segments[5].seq);
  assert.equal(probe.pickSegment(), buffer.segments[2], "milieu de [0, 5]");
});

test("il faut deux négatifs CONSÉCUTIFS pour borner la pub", () => {
  const { buffer, probe } = armedProbe();

  buffer.segments[3].scanned = true;
  probe.consumeResult(buffer.segments[3], 150, negative);
  assert.equal(probe.firstNegativeSeq, null);

  // Un négatif non adjacent ne confirme pas : il devient le nouveau candidat
  // s'il est plus proche, sinon il est ignoré.
  buffer.segments[5].scanned = true;
  probe.consumeResult(buffer.segments[5], 170, negative);
  assert.equal(probe.firstNegativeSeq, null, "3 et 5 ne sont pas consécutifs");

  // Le successeur immédiat du candidat, lui, tranche.
  buffer.segments[4].scanned = true;
  probe.consumeResult(buffer.segments[4], 160, negative);
  assert.equal(probe.firstNegativeSeq, buffer.segments[3].seq);
  assert.equal(probe.firstNegativeTime, 150);
});

test("un positif postérieur invalide une borne négative", () => {
  const { buffer, probe } = armedProbe();

  buffer.segments[4].scanned = true;
  probe.consumeResult(buffer.segments[4], 160, negative);
  assert.equal(probe.pendingNegativeSeq, buffer.segments[4].seq);

  // La pub continuait au-delà : le négatif était un raté OCR.
  buffer.segments[5].scanned = true;
  probe.consumeResult(buffer.segments[5], 170, positive);

  assert.equal(probe.pendingNegativeSeq, null, "candidat disqualifié");
  assert.equal(probe.lastPositiveTime, 170);
});

test("un grand saut exige deux lectures positives avant d'étendre le segment", () => {
  const { buffer, probe, segmentStore } = armedProbe({ startTime: 100 });
  // La sonde est armée avec positiveCount = 1 et le playhead à 100s.
  const farAhead = 100 + CONFIG.bigJumpThresholdSeconds + 10;

  probe.consumeResult(buffer.segments[3], farAhead, positive);
  assert.equal(segmentStore.getAll().length, 1, "le 2e positif débloque l'extension");
  assert.equal(segmentStore.getAll()[0].end, farAhead);
});

test("la sonde se résout quand positif et négatif sont adjacents", () => {
  const { buffer, probe, segmentStore } = armedProbe();

  // Positif en 0, candidat négatif en 1, confirmé par le 2 : bornes adjacentes.
  for (const index of [1, 2]) buffer.segments[index].scanned = true;
  probe.consumeResult(buffer.segments[1], 140, negative);
  probe.consumeResult(buffer.segments[2], 150, negative);

  assert.equal(probe.resolved, true);
  assert.equal(segmentStore.getAll()[0].end, 140, "la fin retenue est le 1er négatif");
});

test("une sonde résolue ignore les frames restantes du lot", () => {
  const { buffer, probe } = armedProbe();

  for (const index of [1, 2]) buffer.segments[index].scanned = true;
  probe.consumeResult(buffer.segments[1], 140, negative);
  probe.consumeResult(buffer.segments[2], 150, negative);
  assert.equal(probe.resolved, true);

  const before = probe.lastPositiveTime;
  probe.consumeResult(buffer.segments[3], 200, positive);
  assert.equal(probe.lastPositiveTime, before, "plus aucun effet après résolution");
});
