/** Parsing d'un init segment fMP4 synthétique + lecture d'entêtes de boîtes. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadMp4Demux } from "./dom-stub.mjs";

const mp4 = loadMp4Demux();
const encoder = new TextEncoder();

function box(type, ...payloads) {
  const body = payloads.flatMap((part) => Array.from(part));
  const size = 8 + body.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(encoder.encode(type), 4);
  out.set(body, 8);
  return out;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}

/** Init segment minimal : ftyp + moov > trak > mdia > { mdhd, minf > stbl > stsd > avc1 > avcC }. */
function buildInitSegment() {
  const avcCPayload = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1]);
  const visualSampleEntry = new Uint8Array(78);
  visualSampleEntry.set(uint16(1920), 24);
  visualSampleEntry.set(uint16(1080), 26);

  const avc1 = box("avc1", visualSampleEntry, box("avcC", avcCPayload));
  const stsd = box("stsd", uint32(0), uint32(1), avc1);
  const mdhd = box("mdhd", uint32(0), uint32(0), uint32(0), uint32(30000));
  const moov = box("moov", box("trak", box("mdia", mdhd, box("minf", box("stbl", stsd)))));
  const ftyp = box("ftyp", encoder.encode("isom"), new Uint8Array(8));

  const init = new Uint8Array(ftyp.length + moov.length);
  init.set(ftyp, 0);
  init.set(moov, ftyp.length);
  return { init, avcCPayload, ftypLength: ftyp.length };
}

test("parseInitSegment prend le codec dans le MIME et le reste dans les boîtes", () => {
  const { init, avcCPayload } = buildInitSegment();
  const info = mp4.parseInitSegment(init.buffer, 'video/mp4; codecs="avc1.64001f"');

  assert.equal(info.codec, "avc1.64001f");
  assert.equal(info.codedWidth, 1920);
  assert.equal(info.codedHeight, 1080);
  assert.deepEqual(Array.from(info.description), Array.from(avcCPayload));
});

test("parseTimescale lit mdhd", () => {
  const { init } = buildInitSegment();
  assert.equal(mp4.parseTimescale(init.buffer), 30000);
});

test("sans codec dans le MIME, la configuration est refusée explicitement", () => {
  const { init } = buildInitSegment();
  assert.equal(mp4.parseInitSegment(init.buffer, "video/mp4"), null);
});

test("codecFromMime préserve la casse du tier AV1", () => {
  const codec = mp4.codecFromMime('video/mp4; codecs="av01.0.04M.08.0.110.05.01.06.0"');
  assert.equal(codec, "av01.0.04M.08.0.110.05.01.06.0");
});

test("codecFromMime renvoie null quand le paramètre est absent", () => {
  assert.equal(mp4.codecFromMime("video/mp4"), null);
  assert.equal(mp4.codecFromMime(""), null);
  assert.equal(mp4.codecFromMime(undefined), null);
});

test("readBoxHeader distingue « entête tronqué » de « boîte non délimitée »", () => {
  const { init, ftypLength } = buildInitSegment();

  assert.equal(mp4.readBoxHeader(new Uint8Array(4), 0), null, "entête incomplet");

  const ftyp = mp4.readBoxHeader(init, 0);
  assert.deepEqual(
    { type: ftyp.type, size: ftyp.size, headerSize: ftyp.headerSize, extendsToEnd: ftyp.extendsToEnd },
    { type: "ftyp", size: ftypLength, headerSize: 8, extendsToEnd: false }
  );

  const toEnd = new Uint8Array(8);
  toEnd.set(encoder.encode("mdat"), 4); // taille 32 bits = 0
  const header = mp4.readBoxHeader(toEnd, 0);
  assert.equal(header.extendsToEnd, true);
});

test("readBoxHeader lit la taille étendue 64 bits", () => {
  const extended = new Uint8Array(16);
  const view = new DataView(extended.buffer);
  view.setUint32(0, 1);
  extended.set(encoder.encode("mdat"), 4);
  view.setUint32(12, 4096);

  const header = mp4.readBoxHeader(extended, 0);
  assert.equal(header.type, "mdat");
  assert.equal(header.size, 4096);
  assert.equal(header.headerSize, 16);
});
