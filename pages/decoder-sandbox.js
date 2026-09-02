/**
 * Decoder Sandbox — WebCodecs VideoDecoder running inside an extension iframe.
 *
 * Receives raw container data from the content script, demuxes it, decodes the
 * keyframes and sends back ImageBitmaps for OCR.
 *
 * Communication channel: "no-add-decoder"
 *
 *   configure     — init segment ArrayBuffer -> configure the VideoDecoder
 *   scan-segment  — media segment ArrayBuffer -> ImageBitmap per keyframe
 *   terminate     — release the decoder
 */
(() => {
  "use strict";

  const CHANNEL = "no-add-decoder";
  const TAG = "[NoAdd-Decoder]";
  const mp4 = window.__mp4demux;

  /** Safety net: a batch that produces no output must not hang the scanner. */
  const DECODE_BATCH_TIMEOUT_MS = 10000;
  /** Top-level box types listed when a media segment yields no sample. */
  const MAX_DIAGNOSTIC_BOXES = 6;

  let decoder = null;
  let canvas = null;
  let ctx = null;
  let codecInfo = null;

  /**
   * Pending decodes, keyed by the chunk timestamp in microseconds.
   *
   * Keying by timestamp rather than by arrival order means a frame the decoder
   * silently drops cannot shift every later frame onto the wrong request — the
   * bitmap always lands on the keyframe that asked for it.
   *
   * @type {Map<number, { resolve: (b: ImageBitmap | null) => void, reject: (e: Error) => void }>}
   */
  const decodeWaiters = new Map();

  function reply(payload, transfer) {
    window.parent.postMessage({ channel: CHANNEL, ...payload }, "*", transfer ?? []);
  }

  function formatError(error) {
    if (error instanceof Error) return error.message || error.name || "Error";
    return String(error);
  }

  /* ------------------------------------------------------------------ */
  /*  VideoDecoder lifecycle                                             */
  /* ------------------------------------------------------------------ */

  function ensureCanvas(width, height) {
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext("2d");
    }
  }

  function settleWaiter(timestampUs, bitmap, error) {
    // Fall back to the oldest pending request if the decoder reported a
    // timestamp we never asked for (container/codec rounding).
    const key = decodeWaiters.has(timestampUs)
      ? timestampUs
      : decodeWaiters.keys().next().value;
    if (key === undefined) return;

    const waiter = decodeWaiters.get(key);
    decodeWaiters.delete(key);
    if (error) waiter.reject(error);
    else waiter.resolve(bitmap);
  }

  function rejectAllWaiters(error) {
    for (const waiter of decodeWaiters.values()) {
      waiter.reject(error);
    }
    decodeWaiters.clear();
  }

  function destroyDecoder() {
    if (decoder) {
      try { decoder.close(); } catch { /* already closed */ }
      decoder = null;
    }
    codecInfo = null;
    rejectAllWaiters(new Error("decoder destroyed"));
  }

  function createDecoder() {
    destroyDecoder();

    decoder = new VideoDecoder({
      output(frame) {
        const timestampUs = frame.timestamp;
        try {
          ensureCanvas(frame.displayWidth, frame.displayHeight);
          ctx.drawImage(frame, 0, 0);
          frame.close();
          settleWaiter(timestampUs, canvas.transferToImageBitmap(), null);
        } catch (error) {
          frame.close();
          settleWaiter(timestampUs, null, error);
        }
      },
      error(error) {
        console.warn(TAG, "VideoDecoder error:", error);
        rejectAllWaiters(error);
      }
    });
  }

  /**
   * Decode a batch of keyframes with a single flush.
   *
   * Flushing once per frame drains the decoder pipeline every time and paid the
   * full latency per keyframe; the scan rate is what governs how much of an ad
   * the viewer sees, so the whole batch is queued before flushing.
   *
   * @returns {Promise<Array<{ timestamp: number, duration: number, imageBitmap: ImageBitmap | null }>>}
   */
  async function decodeKeyframes(keyframes) {
    if (keyframes.length === 0) return [];

    const waits = [];
    const timeout = setTimeout(
      () => rejectAllWaiters(new Error("decode timeout")),
      DECODE_BATCH_TIMEOUT_MS
    );

    try {
      for (const keyframe of keyframes) {
        const timestampUs = Math.round(keyframe.timestamp * 1_000_000);
        waits.push(new Promise((resolve, reject) => {
          decodeWaiters.set(timestampUs, { resolve, reject });
        }));

        decoder.decode(new EncodedVideoChunk({
          type: "key",
          timestamp: timestampUs,
          duration: keyframe.duration ? Math.round(keyframe.duration * 1_000_000) : undefined,
          data: keyframe.data
        }));
      }

      await decoder.flush();
      // flush() resolves once every output has been emitted, so anything still
      // pending here produced no frame at all.
      rejectAllWaiters(new Error("aucune frame produite"));
    } catch (error) {
      rejectAllWaiters(error);
    } finally {
      clearTimeout(timeout);
    }

    const settled = await Promise.allSettled(waits);
    return settled.map((result, index) => ({
      timestamp: keyframes[index].timestamp,
      duration: keyframes[index].duration,
      imageBitmap: result.status === "fulfilled" ? result.value : null,
      error: result.status === "rejected" ? formatError(result.reason) : null
    }));
  }

  /* ------------------------------------------------------------------ */
  /*  Demuxing                                                           */
  /* ------------------------------------------------------------------ */

  function demuxSamples(mediaBuffer) {
    if (codecInfo.container === "webm") {
      return mp4.parseWebMClusters(mediaBuffer, { timestampScale: codecInfo.timescale });
    }
    return mp4.parseMediaSegment(mediaBuffer, {
      timescale: codecInfo.timescale,
      defaultSampleDuration: 0,
      defaultSampleSize: 0,
      defaultSampleFlags: 0
    });
  }

  /** Keyframes past `minTime`, spaced by at least `sampleInterval` seconds. */
  function selectKeyframes(samples, minTime, sampleInterval) {
    const keyframes = [];
    let lastKeyframeTime = -Infinity;

    for (const sample of samples) {
      if (!sample.isKeyframe) continue;
      if (sample.timestamp <= minTime) continue;
      if (sample.timestamp <= lastKeyframeTime + sampleInterval) continue;
      keyframes.push(sample);
      lastKeyframeTime = sample.timestamp;
    }

    return keyframes;
  }

  /**
   * When a media segment yields zero samples, list its top-level box types so
   * we can tell pure indexing (styp/sidx) from a SABR-wrapped chunk or a
   * parser miss.
   */
  function describeTopBoxes(mediaBuffer) {
    const bytes = new Uint8Array(mediaBuffer);
    const seen = [];
    let pos = 0;

    while (seen.length < MAX_DIAGNOSTIC_BOXES) {
      const header = mp4.readBoxHeader(bytes, pos);
      if (!header) break;
      seen.push(`${header.type}(${header.size})`);
      if (header.extendsToEnd || header.size < header.headerSize) break;
      pos += header.size;
      if (pos > bytes.length) break;
    }

    return seen.join(", ") || "(none)";
  }

  /* ------------------------------------------------------------------ */
  /*  Handlers                                                           */
  /* ------------------------------------------------------------------ */

  const HANDLERS = {
    async configure(msg) {
      if (!mp4) throw new Error("mp4demux not loaded");
      if (!("VideoDecoder" in self)) throw new Error("WebCodecs VideoDecoder not available");

      const initBuffer = msg.initSegment;
      if (!(initBuffer instanceof ArrayBuffer)) throw new Error("initSegment must be ArrayBuffer");

      const container = msg.container || "mp4";
      const mime = msg.mime || "";

      let info;
      let timescale;

      if (container === "webm") {
        info = mp4.parseWebMInitSegment(initBuffer, mime);
        if (!info) throw new Error("Failed to parse WebM init segment");
        timescale = info.timestampScale; // stored as ns scale

        console.info(TAG, "WebM EBML parse result:", {
          codec: info.codec,
          codedWidth: info.codedWidth,
          codedHeight: info.codedHeight,
          timestampScale: info.timestampScale,
          bufferBytes: initBuffer.byteLength
        });

        // Fall back to the video element's dimensions when EBML misses them.
        if (info.codedWidth === 0 || info.codedHeight === 0) {
          const fallbackWidth = msg.fallbackWidth | 0;
          const fallbackHeight = msg.fallbackHeight | 0;
          if (fallbackWidth <= 0 || fallbackHeight <= 0) {
            throw new Error("WebM EBML parsing returned coded size (0, 0) and no fallback dimensions provided");
          }
          console.warn(TAG, `WebM: EBML returned 0x0, using video-element fallback ${fallbackWidth}x${fallbackHeight}`);
          info = { ...info, codedWidth: fallbackWidth, codedHeight: fallbackHeight };
        }
      } else {
        info = mp4.parseInitSegment(initBuffer, mime);
        if (!info) throw new Error(`Failed to parse init segment (mime: ${mime || "?"})`);
        timescale = mp4.parseTimescale(initBuffer);
      }

      const config = {
        codec: info.codec,
        codedWidth: info.codedWidth,
        codedHeight: info.codedHeight
      };
      if (info.description) {
        config.description = info.description;
      }

      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        throw new Error(`Codec not supported: ${info.codec}`);
      }

      createDecoder();
      decoder.configure(config);
      codecInfo = { ...info, timescale, container };

      console.info(
        TAG,
        "Decoder configured:", info.codec,
        `${info.codedWidth}x${info.codedHeight}`,
        container === "webm" ? `timestampScale=${timescale}` : `timescale=${timescale}`
      );

      return { codec: info.codec, width: info.codedWidth, height: info.codedHeight, timescale };
    },

    async "scan-segment"(msg) {
      if (!mp4) throw new Error("mp4demux not loaded");
      if (!decoder || decoder.state !== "configured") throw new Error("Decoder not configured");
      if (!codecInfo) throw new Error("No codec info");

      const mediaBuffer = msg.mediaSegment;
      if (!(mediaBuffer instanceof ArrayBuffer)) throw new Error("mediaSegment must be ArrayBuffer");

      const minTime = msg.minTime ?? -Infinity;
      const sampleInterval = msg.sampleInterval ?? 5;

      const samples = demuxSamples(mediaBuffer);
      const keyframes = selectKeyframes(samples, minTime, sampleInterval);
      const keyframesTotal = samples.reduce((count, s) => count + (s.isKeyframe ? 1 : 0), 0);
      const firstSampleTs = samples.length > 0 ? samples[0].timestamp : null;
      const lastSampleTs = samples.length > 0 ? samples[samples.length - 1].timestamp : null;
      const noSampleDiagnostic = samples.length === 0 && codecInfo.container === "mp4"
        ? { bufBytes: mediaBuffer.byteLength, topBoxes: describeTopBoxes(mediaBuffer) }
        : null;

      console.info(TAG, "scan-segment parse:", {
        samples: samples.length,
        keyframesTotal,
        keyframesKept: keyframes.length,
        minTime: Number.isFinite(minTime) ? minTime.toFixed(2) : minTime,
        tsRange: firstSampleTs !== null ? `${firstSampleTs.toFixed(2)}..${lastSampleTs.toFixed(2)}` : "(empty)",
        container: codecInfo.container,
        ...(noSampleDiagnostic ?? {})
      });

      const decoded = await decodeKeyframes(keyframes);
      const frames = decoded.filter((frame) => frame.imageBitmap !== null);
      const failures = decoded.filter((frame) => frame.imageBitmap === null);

      if (failures.length > 0) {
        console.warn(
          TAG,
          `scan-segment: ${failures.length}/${keyframes.length} keyframes failed to decode`,
          failures.map((f) => ({ ts: f.timestamp, err: f.error }))
        );
      }

      return {
        // Time span of the segment, independent of which keyframes survived
        // filtering. Reported for diagnostics on empty scans.
        tsRange: firstSampleTs !== null ? { start: firstSampleTs, end: lastSampleTs } : null,
        frames: frames.map((frame) => ({
          timestamp: frame.timestamp,
          duration: frame.duration,
          imageBitmap: frame.imageBitmap
        })),
        __transfer: frames.map((frame) => frame.imageBitmap)
      };
    },

    async terminate() {
      destroyDecoder();
      return {};
    }
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent) return;

    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    const handler = HANDLERS[msg.type];
    if (!handler) return;

    try {
      const { __transfer, ...payload } = await handler(msg);
      reply({ type: `${msg.type}-ok`, reqId: msg.reqId, ...payload }, __transfer);
    } catch (error) {
      reply({ type: `${msg.type}-err`, reqId: msg.reqId, error: formatError(error) });
    }
  });

  window.parent.postMessage({ channel: CHANNEL, type: "sandbox-ready" }, "*");
  console.info(TAG, "Decoder sandbox ready.");
})();
