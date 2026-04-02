/**
 * Minimal fMP4 (ISO BMFF) demuxer for extracting codec configuration from
 * init segments and encoded frame data from media segments.
 *
 * Only the subset of boxes used by YouTube's DASH streams is handled:
 *   Init  : ftyp, moov > trak > mdia > minf > stbl > stsd > (avc1|vp09|av01)
 *   Media : moof > traf > (tfhd + tfdt + trun) + mdat
 *
 * Designed to be loaded in any JS context (content script, iframe, worker).
 */
(() => {
  "use strict";

  /* ================================================================== */
  /*  Low-level box reader                                               */
  /* ================================================================== */

  /**
   * Iterate over top-level boxes in a DataView.
   * Yields { type, offset, size, dataOffset, dataSize }.
   */
  function* iterateBoxes(view, baseOffset = 0) {
    let pos = 0;
    while (pos + 8 <= view.byteLength) {
      let size = view.getUint32(pos);
      const type = String.fromCharCode(
        view.getUint8(pos + 4),
        view.getUint8(pos + 5),
        view.getUint8(pos + 6),
        view.getUint8(pos + 7)
      );

      let headerSize = 8;
      if (size === 1) {
        // 64-bit extended size
        if (pos + 16 > view.byteLength) break;
        size = Number(view.getBigUint64(pos + 8));
        headerSize = 16;
      } else if (size === 0) {
        // Box extends to end of buffer
        size = view.byteLength - pos;
      }

      if (size < headerSize || pos + size > view.byteLength) break;

      yield {
        type,
        offset: baseOffset + pos,
        size,
        dataOffset: pos + headerSize,
        dataSize: size - headerSize
      };

      pos += size;
    }
  }

  /** Find a specific box type among children. */
  function findBox(view, type) {
    for (const box of iterateBoxes(view)) {
      if (box.type === type) return box;
    }
    return null;
  }

  /** Get a child DataView scoped to a box's payload. */
  function childView(parentView, box) {
    return new DataView(
      parentView.buffer,
      parentView.byteOffset + box.dataOffset,
      box.dataSize
    );
  }

  /** Walk a path of nested box types and return the innermost DataView. */
  function drillDown(view, path) {
    let current = view;
    for (const type of path) {
      const box = findBox(current, type);
      if (!box) return null;
      current = childView(current, box);
    }
    return current;
  }

  /* ================================================================== */
  /*  Init segment parsing                                               */
  /* ================================================================== */

  /**
   * Parse an fMP4 init segment (ftyp + moov).
   *
   * @param {ArrayBuffer} buffer
   * @returns {{ codec: string, codedWidth: number, codedHeight: number, description: Uint8Array } | null}
   */
  function parseInitSegment(buffer) {
    const root = new DataView(buffer);
    const stsd = drillDown(root, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
    if (!stsd) return null;

    // stsd: version(1) + flags(3) + entryCount(4) = 8 bytes header
    if (stsd.byteLength < 16) return null;

    const entryCount = stsd.getUint32(4);
    if (entryCount === 0) return null;

    // First sample entry starts at offset 8
    const entryView = new DataView(stsd.buffer, stsd.byteOffset + 8, stsd.byteLength - 8);
    const entryBox = findBox(entryView, null); // any box type
    // Actually iterate to get the first box regardless of type
    let sampleEntry = null;
    for (const box of iterateBoxes(entryView)) {
      sampleEntry = box;
      break;
    }
    if (!sampleEntry) return null;

    const entryType = sampleEntry.type; // avc1, avc3, vp09, av01, etc.
    const entryData = childView(entryView, sampleEntry);

    // Visual sample entry: 6 reserved + 2 dataRefIdx + ... + 2 width + 2 height
    // Minimum 78 bytes for visual sample entry before codec-specific boxes
    if (entryData.byteLength < 78) return null;

    const codedWidth = entryData.getUint16(24);
    const codedHeight = entryData.getUint16(26);

    // Codec-specific config box starts after the 78-byte visual sample entry header
    const configView = new DataView(
      entryData.buffer,
      entryData.byteOffset + 78,
      entryData.byteLength - 78
    );

    let codec = null;
    let description = null;

    if (entryType === "avc1" || entryType === "avc3") {
      const result = parseAvcC(configView, entryType);
      if (result) {
        codec = result.codec;
        description = result.description;
      }
    } else if (entryType === "vp09") {
      const result = parseVpcC(configView);
      if (result) {
        codec = result.codec;
        description = result.description;
      }
    } else if (entryType === "av01") {
      const result = parseAv1C(configView);
      if (result) {
        codec = result.codec;
        description = result.description;
      }
    }

    if (!codec) return null;

    return { codec, codedWidth, codedHeight, description };
  }

  /** Parse avcC box -> codec string + raw description bytes. */
  function parseAvcC(view, entryType) {
    const box = findBox(view, "avcC");
    if (!box || box.dataSize < 4) return null;

    const data = childView(view, box);
    // avcC: configVersion(1) + profile(1) + profileCompat(1) + level(1)
    const profile = data.getUint8(1);
    const compat = data.getUint8(2);
    const level = data.getUint8(3);

    const codec = `${entryType}.${hex(profile)}${hex(compat)}${hex(level)}`;

    const description = new Uint8Array(
      view.buffer,
      view.byteOffset + box.dataOffset,
      box.dataSize
    ).slice();

    return { codec, description };
  }

  /** Parse vpcC box -> codec string. */
  function parseVpcC(view) {
    const box = findBox(view, "vpcC");
    if (!box || box.dataSize < 8) return null;

    const data = childView(view, box);
    // vpcC version 1: version(1) + flags(3) + profile(1) + level(1) + bitDepth:4|chromaSub:3|videoFullRange:1 + ...
    const version = data.getUint8(0);
    let profile, level, bitDepth;

    if (version === 1) {
      profile = data.getUint8(4);
      level = data.getUint8(5);
      bitDepth = (data.getUint8(6) >> 4) & 0x0f;
    } else {
      profile = data.getUint8(4);
      level = data.getUint8(5);
      bitDepth = (data.getUint8(6) >> 4) & 0x0f;
    }

    const codec = `vp09.${pad2(profile)}.${pad2(level)}.${pad2(bitDepth)}`;

    const description = new Uint8Array(
      view.buffer,
      view.byteOffset + box.dataOffset,
      box.dataSize
    ).slice();

    return { codec, description };
  }

  /** Parse av1C box -> codec string. */
  function parseAv1C(view) {
    const box = findBox(view, "av1C");
    if (!box || box.dataSize < 4) return null;

    const data = childView(view, box);
    // av1C: marker:1|version:7 | seqProfile:3|seqLevelIdx0:5 | seqTier0:1|highBitdepth:1|twelveBit:1|monochrome:1|chromaSubX:1|chromaSubY:1|chromaSamplePos:2
    const byte1 = data.getUint8(1);
    const byte2 = data.getUint8(2);

    const seqProfile = (byte1 >> 5) & 0x07;
    const seqLevelIdx0 = byte1 & 0x1f;
    const seqTier0 = (byte2 >> 7) & 0x01;
    const highBitdepth = (byte2 >> 6) & 0x01;
    const twelveBit = (byte2 >> 5) & 0x01;
    const bitDepth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
    const monochrome = (byte2 >> 4) & 0x01;
    const chromaSubX = (byte2 >> 3) & 0x01;
    const chromaSubY = (byte2 >> 2) & 0x01;

    let chromaSub;
    if (monochrome) {
      chromaSub = "000";
    } else if (chromaSubX && chromaSubY) {
      chromaSub = "110";
    } else if (chromaSubX) {
      chromaSub = "100";
    } else {
      chromaSub = "111";
    }

    const tier = seqTier0 === 0 ? "M" : "H";
    const codec = `av01.${seqProfile}.${pad2(seqLevelIdx0)}${tier}.${pad2(bitDepth)}.${chromaSub}`;

    const description = new Uint8Array(
      view.buffer,
      view.byteOffset + box.dataOffset,
      box.dataSize
    ).slice();

    return { codec, description };
  }

  /* ================================================================== */
  /*  Media segment parsing                                              */
  /* ================================================================== */

  /**
   * Parse an fMP4 media segment (moof + mdat).
   *
   * @param {ArrayBuffer} buffer
   * @param {{ defaultSampleDuration?: number, defaultSampleSize?: number, defaultSampleFlags?: number, timescale?: number }} initInfo
   * @returns {Array<{ data: ArrayBuffer, timestamp: number, duration: number, isKeyframe: boolean }>}
   */
  function parseMediaSegment(buffer, initInfo = {}) {
    const root = new DataView(buffer);
    const timescale = initInfo.timescale || 90000; // YouTube default for video

    // Find moof and mdat
    let moofBox = null;
    let mdatBox = null;
    for (const box of iterateBoxes(root)) {
      if (box.type === "moof") moofBox = box;
      else if (box.type === "mdat") mdatBox = box;
    }
    if (!moofBox || !mdatBox) return [];

    const moofView = childView(root, moofBox);

    // Find traf inside moof
    const trafBox = findBox(moofView, "traf");
    if (!trafBox) return [];
    const trafView = childView(moofView, trafBox);

    // Parse tfhd (track fragment header)
    const tfhdBox = findBox(trafView, "tfhd");
    let defaultDuration = initInfo.defaultSampleDuration || 0;
    let defaultSize = initInfo.defaultSampleSize || 0;
    let defaultFlags = initInfo.defaultSampleFlags || 0;

    if (tfhdBox) {
      const tfhd = childView(trafView, tfhdBox);
      // version(1) + flags(3) + trackId(4)
      const flags = (tfhd.getUint8(1) << 16) | (tfhd.getUint8(2) << 8) | tfhd.getUint8(3);
      let offset = 8; // skip version+flags+trackId
      if (flags & 0x000001) offset += 8; // base-data-offset
      if (flags & 0x000002) offset += 4; // sample-description-index
      if (flags & 0x000008) {
        defaultDuration = tfhd.getUint32(offset);
        offset += 4;
      }
      if (flags & 0x000010) {
        defaultSize = tfhd.getUint32(offset);
        offset += 4;
      }
      if (flags & 0x000020) {
        defaultFlags = tfhd.getUint32(offset);
      }
    }

    // Parse tfdt (track fragment decode time) — optional but common
    let baseDecodeTime = 0;
    const tfdtBox = findBox(trafView, "tfdt");
    if (tfdtBox) {
      const tfdt = childView(trafView, tfdtBox);
      const version = tfdt.getUint8(0);
      if (version === 1) {
        baseDecodeTime = Number(tfdt.getBigUint64(4));
      } else {
        baseDecodeTime = tfdt.getUint32(4);
      }
    }

    // Parse trun (track fragment run)
    const trunBox = findBox(trafView, "trun");
    if (!trunBox) return [];
    const trun = childView(trafView, trunBox);

    const trunVersion = trun.getUint8(0);
    const trunFlags = (trun.getUint8(1) << 16) | (trun.getUint8(2) << 8) | trun.getUint8(3);
    const sampleCount = trun.getUint32(4);

    let pos = 8;
    let dataOffsetFromMoof = 0;
    if (trunFlags & 0x000001) {
      dataOffsetFromMoof = trun.getInt32(pos);
      pos += 4;
    }
    if (trunFlags & 0x000004) {
      pos += 4; // first-sample-flags (we read per-sample flags below)
    }

    const hasDuration    = Boolean(trunFlags & 0x000100);
    const hasSize        = Boolean(trunFlags & 0x000200);
    const hasFlags       = Boolean(trunFlags & 0x000400);
    const hasCTO         = Boolean(trunFlags & 0x000800);

    // First sample flags override
    const firstSampleFlags = (trunFlags & 0x000004) ? trun.getUint32(8) : null;

    const samples = [];
    let currentDecodeTime = baseDecodeTime;
    let currentDataOffset = moofBox.offset + dataOffsetFromMoof;

    // mdat payload starts after the mdat box header
    const mdatDataStart = mdatBox.offset + 8; // assuming standard 8-byte header
    // If dataOffset points inside mdat, use it; otherwise use mdat start
    if (currentDataOffset < mdatDataStart) {
      currentDataOffset = mdatDataStart;
    }

    for (let i = 0; i < sampleCount; i++) {
      const duration = hasDuration ? trun.getUint32(pos) : defaultDuration;
      if (hasDuration) pos += 4;

      const size = hasSize ? trun.getUint32(pos) : defaultSize;
      if (hasSize) pos += 4;

      let sampleFlags;
      if (i === 0 && firstSampleFlags !== null) {
        sampleFlags = firstSampleFlags;
        if (hasFlags) pos += 4; // skip per-sample flags for first sample
      } else {
        sampleFlags = hasFlags ? trun.getUint32(pos) : defaultFlags;
        if (hasFlags) pos += 4;
      }

      let compositionOffset = 0;
      if (hasCTO) {
        compositionOffset = trunVersion === 0 ? trun.getUint32(pos) : trun.getInt32(pos);
        pos += 4;
      }

      // sample_depends_on in bits 25-24 of flags: 2 = does not depend (keyframe)
      // Also check bit 16 (sample_is_non_sync_sample): 0 = sync sample
      const dependsOn = (sampleFlags >> 24) & 0x03;
      const isNonSync = (sampleFlags >> 16) & 0x01;
      const isKeyframe = dependsOn === 2 || (dependsOn === 0 && isNonSync === 0);

      const presentationTime = (currentDecodeTime + compositionOffset) / timescale;
      const durationSeconds = duration / timescale;

      // Extract sample data from buffer
      const sampleStart = currentDataOffset - (root.byteOffset ?? 0);
      if (sampleStart >= 0 && sampleStart + size <= buffer.byteLength) {
        samples.push({
          data: buffer.slice(sampleStart, sampleStart + size),
          timestamp: presentationTime,
          duration: durationSeconds,
          isKeyframe
        });
      }

      currentDecodeTime += duration;
      currentDataOffset += size;
    }

    return samples;
  }

  /* ================================================================== */
  /*  Timescale extraction                                               */
  /* ================================================================== */

  /**
   * Extract the video track timescale from an init segment.
   * Path: moov > trak > mdia > mdhd
   */
  function parseTimescale(buffer) {
    const root = new DataView(buffer);
    const mdhd = drillDown(root, ["moov", "trak", "mdia", "mdhd"]);
    if (!mdhd) return 90000; // default

    const version = mdhd.getUint8(0);
    if (version === 1) {
      // 8 creationTime + 8 modificationTime + 4 timescale
      return mdhd.byteLength >= 24 ? mdhd.getUint32(20) : 90000;
    }
    // version 0: 4 creationTime + 4 modificationTime + 4 timescale
    return mdhd.byteLength >= 16 ? mdhd.getUint32(12) : 90000;
  }

  /* ================================================================== */
  /*  Formatting helpers                                                 */
  /* ================================================================== */

  function hex(n) {
    return n.toString(16).padStart(2, "0");
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /* ================================================================== */
  /*  Exports                                                            */
  /* ================================================================== */

  // Make available globally for use in iframe sandboxes or content scripts.
  const mp4demux = { parseInitSegment, parseMediaSegment, parseTimescale };

  if (typeof globalThis !== "undefined") {
    globalThis.__mp4demux = mp4demux;
  }
  if (typeof window !== "undefined") {
    window.__mp4demux = mp4demux;
  }
})();
