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

  function reply(payload) {
    window.parent.postMessage({ channel: CHANNEL, ...payload }, "*");
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

        const info = mp4.parseInitSegment(initBuffer);
        if (!info) throw new Error("Failed to parse init segment");

        const timescale = mp4.parseTimescale(initBuffer);

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
        codecInfo = { ...info, timescale };

        console.info(TAG, "Decoder configured:", info.codec, `${info.codedWidth}x${info.codedHeight}`, `timescale=${timescale}`);

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

  // Fix reply to support transferable
  const origReply = reply;
  reply = function (payload, transfer) {
    window.parent.postMessage({ channel: CHANNEL, ...payload }, "*", transfer ?? []);
  };

  // Signal readiness
  window.parent.postMessage({ channel: CHANNEL, type: "sandbox-ready" }, "*");
  console.info(TAG, "Decoder sandbox ready.");
})();
