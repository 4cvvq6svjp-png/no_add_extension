/**
 * Decoder Sandbox — WebCodecs VideoDecoder running inside an extension iframe.
 *
 * Receives encoded video frames from the content script, decodes them via
 * VideoDecoder, draws the resulting VideoFrame to a canvas, and sends back
 * an ImageBitmap.
 *
 * Communication channel: "no-add-decoder"
 *
 * Message types:
 *   configure   — init segment ArrayBuffer → configure the VideoDecoder
 *   decode      — encoded chunk ArrayBuffer + timestamp + isKeyframe → ImageBitmap
 *   reset       — reset decoder state (video change)
 *   terminate   — clean up
 */
(() => {
  "use strict";

  const CHANNEL = "no-add-decoder";
  const TAG = "[NoAdd-Decoder]";
  const mp4 = window.__mp4demux;

  let decoder = null;
  let canvas = null;
  let ctx = null;
  let pendingDecode = null; // { resolve, reject, timeout }
  let codecInfo = null;

  function reply(payload, transfer) {
    window.parent.postMessage({ channel: CHANNEL, ...payload }, "*", transfer ?? []);
  }

  function formatErr(error) {
    if (error instanceof Error) return error.message || error.name || "Error";
    return String(error);
  }

  /* ------------------------------------------------------------------ */
  /*  Canvas                                                             */
  /* ------------------------------------------------------------------ */

  function ensureCanvas(width, height) {
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext("2d");
    }
  }

  /* ------------------------------------------------------------------ */
  /*  VideoDecoder lifecycle                                             */
  /* ------------------------------------------------------------------ */

  function destroyDecoder() {
    if (decoder) {
      try { decoder.close(); } catch { /* already closed */ }
      decoder = null;
    }
    codecInfo = null;
    resolvePending(null, new Error("decoder destroyed"));
  }

  function resolvePending(bitmap, error) {
    if (!pendingDecode) return;
    const p = pendingDecode;
    pendingDecode = null;
    clearTimeout(p.timeout);
    if (error) p.reject(error);
    else p.resolve(bitmap);
  }

  function createDecoder() {
    destroyDecoder();

    decoder = new VideoDecoder({
      output(frame) {
        try {
          ensureCanvas(frame.displayWidth, frame.displayHeight);
          ctx.drawImage(frame, 0, 0);
          frame.close();

          const bitmap = canvas.transferToImageBitmap();
          resolvePending(bitmap, null);
        } catch (err) {
          frame.close();
          resolvePending(null, err);
        }
      },
      error(err) {
        console.warn(TAG, "VideoDecoder error:", err);
        resolvePending(null, err);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Message handler                                                    */
  /* ------------------------------------------------------------------ */

  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent) return;

    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    const reqId = msg.reqId;

    /* ----- configure ----- */
    if (msg.type === "configure") {
      try {
        if (!mp4) throw new Error("mp4demux not loaded");
        if (!("VideoDecoder" in self)) throw new Error("WebCodecs VideoDecoder not available");

        const initBuffer = msg.initSegment;
        if (!(initBuffer instanceof ArrayBuffer)) throw new Error("initSegment must be ArrayBuffer");

        const container = msg.container || "mp4";
        const mime = msg.mime || "";

        let info, timescale;
        if (container === "webm") {
          info = mp4.parseWebMInitSegment(initBuffer, mime);
          if (!info) throw new Error("Failed to parse WebM init segment");
          timescale = info.timestampScale; // stored as ns scale
          // Log what the EBML parser found (for debugging)
          console.info(TAG, "WebM EBML parse result:", {
            codec: info.codec, codedWidth: info.codedWidth, codedHeight: info.codedHeight,
            timestampScale: info.timestampScale, bufferBytes: initBuffer.byteLength
          });
          // Fallback to video-element dimensions when EBML parsing misses them
          if (info.codedWidth === 0 || info.codedHeight === 0) {
            const fw = msg.fallbackWidth | 0;
            const fh = msg.fallbackHeight | 0;
            if (fw > 0 && fh > 0) {
              console.warn(TAG, `WebM: EBML returned 0x0, using video-element fallback ${fw}x${fh}`);
              info = { ...info, codedWidth: fw, codedHeight: fh };
            } else {
              throw new Error("WebM EBML parsing returned coded size (0, 0) and no fallback dimensions provided");
            }
          }
        } else {
          info = mp4.parseInitSegment(initBuffer);
          if (!info) throw new Error("Failed to parse init segment");
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

        console.info(TAG, "Decoder configured:", info.codec, `${info.codedWidth}x${info.codedHeight}`, container === "webm" ? `timestampScale=${timescale}` : `timescale=${timescale}`);

        reply({ type: "configure-ok", reqId, codec: info.codec, width: info.codedWidth, height: info.codedHeight, timescale });
      } catch (err) {
        reply({ type: "configure-err", reqId, error: formatErr(err) });
      }
      return;
    }

    /* ----- decode ----- */
    if (msg.type === "decode") {
      try {
        if (!decoder || decoder.state !== "configured") {
          throw new Error("Decoder not configured");
        }

        const chunkData = msg.data;
        if (!(chunkData instanceof ArrayBuffer)) throw new Error("data must be ArrayBuffer");

        const chunk = new EncodedVideoChunk({
          type: msg.isKeyframe ? "key" : "delta",
          timestamp: Math.round(msg.timestamp * 1_000_000), // seconds -> microseconds
          duration: msg.duration ? Math.round(msg.duration * 1_000_000) : undefined,
          data: chunkData
        });

        // Set up a promise to wait for the decoded frame
        const bitmapPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolvePending(null, new Error("decode timeout"));
          }, 10000);

          pendingDecode = { resolve, reject, timeout };
        });

        decoder.decode(chunk);
        await decoder.flush();

        const bitmap = await bitmapPromise;

        if (bitmap) {
          reply({ type: "decode-ok", reqId, imageBitmap: bitmap }, [bitmap]);
        } else {
          reply({ type: "decode-err", reqId, error: "No frame produced" });
        }
      } catch (err) {
        reply({ type: "decode-err", reqId, error: formatErr(err) });
      }
      return;
    }

    /* ----- scan-segment: parse media segment + decode keyframes ----- */
    if (msg.type === "scan-segment") {
      try {
        if (!mp4) throw new Error("mp4demux not loaded");
        if (!decoder || decoder.state !== "configured") {
          throw new Error("Decoder not configured");
        }
        if (!codecInfo) throw new Error("No codec info");

        const mediaBuffer = msg.mediaSegment;
        if (!(mediaBuffer instanceof ArrayBuffer)) throw new Error("mediaSegment must be ArrayBuffer");

        let samples;
        if (codecInfo.container === "webm") {
          samples = mp4.parseWebMClusters(mediaBuffer, { timestampScale: codecInfo.timescale });
        } else {
          samples = mp4.parseMediaSegment(mediaBuffer, {
            timescale: codecInfo.timescale,
            defaultSampleDuration: 0,
            defaultSampleSize: 0,
            defaultSampleFlags: 0
          });
        }

        const minTime = msg.minTime ?? -Infinity;
        const sampleInterval = msg.sampleInterval ?? 5;

        // Filter to keyframes beyond minTime, spaced by sampleInterval
        const keyframes = [];
        let lastKfTime = -Infinity;
        for (const s of samples) {
          if (s.isKeyframe && s.timestamp > minTime && s.timestamp > lastKfTime + sampleInterval) {
            keyframes.push(s);
            lastKfTime = s.timestamp;
          }
        }

        // Decode each keyframe and collect bitmaps
        const results = [];
        for (const kf of keyframes) {
          try {
            const chunk = new EncodedVideoChunk({
              type: "key",
              timestamp: Math.round(kf.timestamp * 1_000_000),
              duration: kf.duration ? Math.round(kf.duration * 1_000_000) : undefined,
              data: kf.data
            });

            const bitmapPromise = new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolvePending(null, new Error("decode timeout"));
              }, 10000);
              pendingDecode = { resolve, reject, timeout };
            });

            decoder.decode(chunk);
            await decoder.flush();

            const bitmap = await bitmapPromise;
            if (bitmap) {
              results.push({ timestamp: kf.timestamp, duration: kf.duration, imageBitmap: bitmap });
            }
          } catch {
            // Skip failed frames, continue with the rest
          }
        }

        // Transfer all bitmaps back
        const transferList = results.map((r) => r.imageBitmap);
        reply({
          type: "scan-segment-ok",
          reqId,
          frames: results.map((r) => ({
            timestamp: r.timestamp,
            duration: r.duration,
            imageBitmap: r.imageBitmap
          }))
        }, transferList);
      } catch (err) {
        reply({ type: "scan-segment-err", reqId, error: formatErr(err) });
      }
      return;
    }

    /* ----- reset ----- */
    if (msg.type === "reset") {
      destroyDecoder();
      reply({ type: "reset-ok", reqId });
      return;
    }

    /* ----- terminate ----- */
    if (msg.type === "terminate") {
      destroyDecoder();
      reply({ type: "terminate-ok", reqId });
    }
  });

  // Signal readiness
  window.parent.postMessage({ channel: CHANNEL, type: "sandbox-ready" }, "*");
  console.info(TAG, "Decoder sandbox ready.");
})();
