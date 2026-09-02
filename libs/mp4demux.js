/**
 * Minimal fMP4 (ISO BMFF) and WebM (EBML) demuxer.
 *
 * Only the subset of boxes used by YouTube's DASH streams is handled:
 *   Init  : ftyp, moov > trak > mdia > minf > stbl > stsd > (avc1|vp09|av01)
 *   Media : moof > traf > (tfhd + tfdt + trun) + mdat
 *
 * The WebCodecs *codec string* is read from the SourceBuffer MIME type rather
 * than rebuilt from codec-configuration bits: the MIME already carries a valid
 * string (e.g. `av01.0.04M.08.0.110.05.01.06.0`) and rebuilding it by hand was
 * a recurring source of "codec not supported" failures. Binary parsing is kept
 * only for what the MIME cannot provide: coded dimensions, timescale, and the
 * raw codec-configuration bytes WebCodecs needs as `description`.
 *
 * Loaded both in the decoder iframe and in the content script (isolated world),
 * so the ISO BMFF box reader is shared instead of reimplemented per context.
 */
(() => {
  "use strict";

  /* ================================================================== */
  /*  Low-level box reader                                               */
  /* ================================================================== */

  /**
   * Read the ISO BMFF box header at `pos`.
   *
   * Returns null when the header itself is not fully present, so a caller
   * reassembling a byte stream can tell "not yet" from "malformed".
   * A 32-bit size of 0 means "this box runs to the end of the stream": the
   * size cannot be known from the header alone, so it is reported through
   * `extendsToEnd` and each caller applies its own policy.
   *
   * @param {Uint8Array} bytes
   * @param {number} pos
   * @returns {{ type: string, size: number, headerSize: number, extendsToEnd: boolean } | null}
   */
  function readBoxHeader(bytes, pos) {
    if (pos + 8 > bytes.length) return null;

    const rawSize =
      ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);

    if (rawSize === 1) {
      // 64-bit extended size, stored right after the header.
      if (pos + 16 > bytes.length) return null;
      const high =
        ((bytes[pos + 8] << 24) | (bytes[pos + 9] << 16) | (bytes[pos + 10] << 8) | bytes[pos + 11]) >>> 0;
      const low =
        ((bytes[pos + 12] << 24) | (bytes[pos + 13] << 16) | (bytes[pos + 14] << 8) | bytes[pos + 15]) >>> 0;
      return { type, size: high * 2 ** 32 + low, headerSize: 16, extendsToEnd: false };
    }

    if (rawSize === 0) {
      return { type, size: 0, headerSize: 8, extendsToEnd: true };
    }

    return { type, size: rawSize, headerSize: 8, extendsToEnd: false };
  }

  /**
   * Iterate over the boxes of a DataView.
   * Yields { type, offset, size, dataOffset, dataSize }.
   */
  function* iterateBoxes(view, baseOffset = 0) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let pos = 0;

    while (pos < bytes.length) {
      const header = readBoxHeader(bytes, pos);
      if (!header) break;

      const size = header.extendsToEnd ? bytes.length - pos : header.size;
      if (size < header.headerSize || pos + size > bytes.length) break;

      yield {
        type: header.type,
        offset: baseOffset + pos,
        size,
        dataOffset: pos + header.headerSize,
        dataSize: size - header.headerSize
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

  /** Copy a box's payload bytes out of its parent view. */
  function copyBoxData(parentView, box) {
    return new Uint8Array(
      parentView.buffer,
      parentView.byteOffset + box.dataOffset,
      box.dataSize
    ).slice();
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
  /*  Codec string                                                       */
  /* ================================================================== */

  /**
   * Extract the `codecs` parameter of a MIME type.
   * `video/mp4; codecs="av01.0.04M.08.0.110.05.01.06.0"` -> that string.
   *
   * Case is preserved: AV1 encodes its tier as an uppercase `M`/`H`.
   */
  function codecFromMime(mime) {
    if (!mime) return null;
    const match = String(mime).match(/codecs\s*=\s*"?([^";,]+)/i);
    if (!match) return null;
    const codec = match[1].trim();
    return codec.length > 0 ? codec : null;
  }

  /** Codec-configuration boxes WebCodecs accepts as `description`. */
  const CODEC_CONFIG_BOX_TYPES = new Set(["avcC", "hvcC", "vpcC", "av1C"]);

  /* ================================================================== */
  /*  Init segment parsing                                               */
  /* ================================================================== */

  /**
   * Parse an fMP4 init segment (ftyp + moov).
   *
   * @param {ArrayBuffer} buffer
   * @param {string} mimeString SourceBuffer MIME, source of the codec string.
   * @returns {{ codec: string, codedWidth: number, codedHeight: number, description: Uint8Array | null } | null}
   */
  function parseInitSegment(buffer, mimeString) {
    const codec = codecFromMime(mimeString);
    if (!codec) return null;

    const root = new DataView(buffer);
    const stsd = drillDown(root, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
    if (!stsd) return null;

    // stsd: version(1) + flags(3) + entryCount(4) = 8 bytes header
    if (stsd.byteLength < 16) return null;
    if (stsd.getUint32(4) === 0) return null;

    // The first sample entry starts right after that header, whatever its type
    // (avc1, avc3, vp09, av01, hvc1...).
    const entryView = new DataView(stsd.buffer, stsd.byteOffset + 8, stsd.byteLength - 8);
    const sampleEntry = iterateBoxes(entryView).next().value ?? null;
    if (!sampleEntry) return null;

    const entryData = childView(entryView, sampleEntry);

    // Visual sample entry: 78 bytes of fixed fields (width at 24, height at 26)
    // before the codec-specific configuration boxes.
    if (entryData.byteLength < 78) return null;

    const codedWidth = entryData.getUint16(24);
    const codedHeight = entryData.getUint16(26);

    const configView = new DataView(
      entryData.buffer,
      entryData.byteOffset + 78,
      entryData.byteLength - 78
    );

    let description = null;
    for (const box of iterateBoxes(configView)) {
      if (CODEC_CONFIG_BOX_TYPES.has(box.type)) {
        description = copyBoxData(configView, box);
        break;
      }
    }

    return { codec, codedWidth, codedHeight, description };
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

    const hasDuration = Boolean(trunFlags & 0x000100);
    const hasSize     = Boolean(trunFlags & 0x000200);
    const hasFlags    = Boolean(trunFlags & 0x000400);
    const hasCTO      = Boolean(trunFlags & 0x000800);

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

      // Box offsets are absolute in `buffer`: the root DataView spans it whole.
      if (currentDataOffset >= 0 && currentDataOffset + size <= buffer.byteLength) {
        samples.push({
          data: buffer.slice(currentDataOffset, currentDataOffset + size),
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
  /*  WebM / Matroska / EBML parser                                     */
  /* ================================================================== */

  /**
   * Read an EBML variable-length ID at `pos` in a Uint8Array.
   * Returns { id, nextPos } or null on error.
   */
  function ebmlReadId(u8, pos) {
    if (pos >= u8.length) return null;
    const first = u8[pos];
    if (first === 0) return null;
    let width;
    if      (first & 0x80) { width = 1; }
    else if (first & 0x40) { width = 2; }
    else if (first & 0x20) { width = 3; }
    else if (first & 0x10) { width = 4; }
    else                   { return null; }
    if (pos + width > u8.length) return null;
    let id = 0;
    for (let i = 0; i < width; i++) id = (id * 256) + u8[pos + i];
    return { id, nextPos: pos + width };
  }

  /**
   * Read an EBML variable-length data size at `pos` in a Uint8Array.
   * Returns { size, nextPos } or null. size === -1 means "unknown/infinite".
   */
  function ebmlReadSize(u8, pos) {
    if (pos >= u8.length) return null;
    const first = u8[pos];
    if (first === 0) return null;
    let width;
    let mask;
    if      (first & 0x80) { width = 1; mask = 0x7F; }
    else if (first & 0x40) { width = 2; mask = 0x3F; }
    else if (first & 0x20) { width = 3; mask = 0x1F; }
    else if (first & 0x10) { width = 4; mask = 0x0F; }
    else if (first & 0x08) { width = 5; mask = 0x07; }
    else if (first & 0x04) { width = 6; mask = 0x03; }
    else if (first & 0x02) { width = 7; mask = 0x01; }
    else if (first & 0x01) { width = 8; mask = 0x00; }
    else                   { return null; }
    if (pos + width > u8.length) return null;

    // All-ones = unknown size
    let allOnes = (u8[pos] & mask) === mask;
    for (let i = 1; allOnes && i < width; i++) {
      if (u8[pos + i] !== 0xFF) allOnes = false;
    }
    if (allOnes) return { size: -1, nextPos: pos + width };

    let size = u8[pos] & mask;
    for (let i = 1; i < width; i++) size = size * 256 + u8[pos + i];
    return { size, nextPos: pos + width };
  }

  /**
   * Read an unsigned integer from u8[pos..pos+len].
   */
  function ebmlReadUint(u8, pos, len) {
    let val = 0;
    for (let i = 0; i < len; i++) val = val * 256 + u8[pos + i];
    return val;
  }

  /**
   * Iterate top-level EBML elements within u8[start..end].
   * Yields { id, dataPos, size }. Tolerates unknown-size (-1) elements by
   * treating them as "extends to parent end" — the size yielded is normalized
   * to a concrete byte count, and iteration ends after such an element since
   * its boundary is unknowable without reaching the end of the parent.
   */
  function* iterateEbml(u8, start, end) {
    let pos = start;
    while (pos < end) {
      const idResult = ebmlReadId(u8, pos);
      if (!idResult) break;
      const sizeResult = ebmlReadSize(u8, idResult.nextPos);
      if (!sizeResult) break;

      const dataPos = sizeResult.nextPos;
      const rawSize = sizeResult.size;
      const size = rawSize === -1 ? (end - dataPos) : rawSize;

      yield { id: idResult.id, dataPos, size };

      if (rawSize === -1) break;
      pos = dataPos + size;
    }
  }

  /**
   * Find the first EBML element with a given ID inside [start, end).
   * Walks element headers, descending past unknown-size containers without
   * stopping. This is robust against streamed/unknown-size YouTube WebM init
   * segments, where the size-driven hierarchy is unreliable.
   */
  function findEbml(u8, targetId, start, end) {
    let pos = start;
    while (pos < end) {
      const idResult = ebmlReadId(u8, pos);
      if (!idResult) { pos += 1; continue; }
      const sizeResult = ebmlReadSize(u8, idResult.nextPos);
      if (!sizeResult) { pos = idResult.nextPos; continue; }

      const dataPos = sizeResult.nextPos;
      const rawSize = sizeResult.size;

      if (idResult.id === targetId) {
        const size = rawSize === -1 ? (end - dataPos) : rawSize;
        return { dataPos, size };
      }

      // Unknown-size element: step past header only and keep scanning so we
      // can still find IDs that live inside it (e.g. Tracks inside Segment).
      pos = rawSize === -1 ? dataPos : (dataPos + rawSize);
    }
    return null;
  }

  // Common EBML element IDs (Matroska spec)
  const EBML_ID = {
    EBML:          0x1A45DFA3,
    Segment:       0x18538067,
    Tracks:        0x1654AE6B,
    TrackEntry:    0xAE,
    TrackType:     0x83,
    Video:         0xE0,
    PixelWidth:    0xB0,
    PixelHeight:   0xBA,
    Info:          0x1549A966,
    TimestampScale:0x2AD7B1,
    Cluster:       0x1F43B675,
    Timestamp:     0xE7,   // inside Cluster
    SimpleBlock:   0xA3,
  };

  /**
   * WebCodecs codec string for a WebM SourceBuffer.
   * The EBML CodecID (`V_VP9`) is not a valid WebCodecs identifier, and a bare
   * `vp9` needs expanding into a full `vp09.PP.LL.DD` string.
   */
  function webmCodecFromMime(mimeString) {
    const codec = codecFromMime(mimeString)?.toLowerCase();
    if (!codec) return "vp8";
    if (codec.startsWith("vp9") && !codec.startsWith("vp09")) return "vp09.00.41.08";
    return codec;
  }

  /**
   * Parse a WebM init segment (EBML header + Segment + Tracks).
   * Returns { codec, codedWidth, codedHeight, description: null, timestampScale, container: "webm" }
   *
   * Dimensions and timestamp scale are located by flat-scanning the buffer
   * for known IDs. This is intentional: YouTube delivers a streaming
   * `Segment` with size = -1, so a strictly hierarchical walk cannot reliably
   * descend into it. Flat scan is safe because EBML IDs are unique enough
   * for the small set we care about.
   */
  function parseWebMInitSegment(buffer, mimeString) {
    const u8 = new Uint8Array(buffer);
    const codec = webmCodecFromMime(mimeString);

    let timestampScale = 1000000;
    const info = findEbml(u8, EBML_ID.Info, 0, u8.length);
    if (info) {
      const tsEl = findEbml(u8, EBML_ID.TimestampScale, info.dataPos, info.dataPos + info.size);
      if (tsEl && tsEl.size > 0 && tsEl.size <= 8) {
        timestampScale = ebmlReadUint(u8, tsEl.dataPos, tsEl.size);
      }
    }

    let codedWidth = 0;
    let codedHeight = 0;
    const tracks = findEbml(u8, EBML_ID.Tracks, 0, u8.length);
    if (tracks) {
      const tracksEnd = tracks.dataPos + tracks.size;
      let pos = tracks.dataPos;
      while (pos < tracksEnd) {
        const te = findEbml(u8, EBML_ID.TrackEntry, pos, tracksEnd);
        if (!te) break;
        const teEnd = te.dataPos + te.size;

        const ttEl = findEbml(u8, EBML_ID.TrackType, te.dataPos, teEnd);
        const trackType = (ttEl && ttEl.size > 0 && ttEl.size <= 4)
          ? ebmlReadUint(u8, ttEl.dataPos, ttEl.size) : 0;

        if (trackType === 1) {
          const v = findEbml(u8, EBML_ID.Video, te.dataPos, teEnd);
          if (v) {
            const vEnd = v.dataPos + v.size;
            const w = findEbml(u8, EBML_ID.PixelWidth, v.dataPos, vEnd);
            const h = findEbml(u8, EBML_ID.PixelHeight, v.dataPos, vEnd);
            if (w && w.size <= 4) codedWidth  = ebmlReadUint(u8, w.dataPos, w.size);
            if (h && h.size <= 4) codedHeight = ebmlReadUint(u8, h.dataPos, h.size);
          }
          break;
        }
        pos = teEnd;
      }
    }

    return { codec, codedWidth, codedHeight, description: null, timestampScale, container: "webm" };
  }

  /**
   * Parse WebM Cluster elements from a media segment (or the tail of an init segment).
   * Returns an array of { data, timestamp, duration, isKeyframe }.
   * timestamp is in seconds.
   *
   * @param {ArrayBuffer} buffer
   * @param {{ timestampScale: number }} initInfo
   */
  function parseWebMClusters(buffer, initInfo = {}) {
    const u8 = new Uint8Array(buffer);
    const timestampScale = initInfo.timestampScale || 1000000; // ns per unit
    const samples = [];

    // YouTube WebM segments often start directly with a Cluster; when the EBML
    // header is present, skip it and the Segment header to reach the clusters.
    let searchStart = 0;
    const firstIdResult = ebmlReadId(u8, 0);
    if (firstIdResult && firstIdResult.id === EBML_ID.EBML) {
      const firstSizeResult = ebmlReadSize(u8, firstIdResult.nextPos);
      if (firstSizeResult) {
        searchStart = firstSizeResult.nextPos + firstSizeResult.size;
        const segIdResult = ebmlReadId(u8, searchStart);
        if (segIdResult && segIdResult.id === EBML_ID.Segment) {
          const segSizeResult = ebmlReadSize(u8, segIdResult.nextPos);
          if (segSizeResult) searchStart = segSizeResult.nextPos;
        }
      }
    }

    for (const el of iterateEbml(u8, searchStart, u8.length)) {
      if (el.id !== EBML_ID.Cluster) continue;

      const clusterEnd = el.size === -1 ? u8.length : el.dataPos + el.size;
      let clusterTimestamp = 0;

      // First pass: read Cluster Timestamp
      for (const ce of iterateEbml(u8, el.dataPos, clusterEnd)) {
        if (ce.id === EBML_ID.Timestamp && ce.size <= 8) {
          clusterTimestamp = ebmlReadUint(u8, ce.dataPos, ce.size);
          break;
        }
      }

      // Second pass: read SimpleBlocks
      for (const ce of iterateEbml(u8, el.dataPos, clusterEnd)) {
        if (ce.id !== EBML_ID.SimpleBlock) continue;
        if (ce.size < 4) continue;

        // SimpleBlock layout:
        //   track number: VINT
        //   int16: relative timecode (big-endian)
        //   flags: 1 byte
        //   frame data: rest

        const sbPos = ce.dataPos;
        const sbEnd = ce.dataPos + ce.size;

        const trackResult = ebmlReadSize(u8, sbPos); // track# encoded as VINT (same encoding as size)
        if (!trackResult) continue;

        const relTimecodePos = trackResult.nextPos;
        if (relTimecodePos + 3 > sbEnd) continue;

        // signed int16 relative timecode
        const relTimecode = (u8[relTimecodePos] << 8 | u8[relTimecodePos + 1]) << 16 >> 16;
        const flags = u8[relTimecodePos + 2];
        const isKeyframe = Boolean(flags & 0x80);
        const frameDataPos = relTimecodePos + 3;
        const frameSize = sbEnd - frameDataPos;
        if (frameSize <= 0) continue;

        // timestamp in seconds: (clusterTimestamp + relTimecode) * timestampScale / 1e9
        const absoluteTimecode = clusterTimestamp + relTimecode;
        const timestampSeconds = (absoluteTimecode * timestampScale) / 1_000_000_000;

        samples.push({
          data: buffer.slice(frameDataPos, frameDataPos + frameSize),
          timestamp: timestampSeconds,
          duration: 0, // WebM SimpleBlock doesn't carry duration per-frame
          isKeyframe
        });
      }
    }

    return samples;
  }

  /* ================================================================== */
  /*  Exports                                                            */
  /* ================================================================== */

  globalThis.__mp4demux = {
    readBoxHeader,
    codecFromMime,
    parseInitSegment,
    parseMediaSegment,
    parseTimescale,
    parseWebMInitSegment,
    parseWebMClusters
  };
})();
