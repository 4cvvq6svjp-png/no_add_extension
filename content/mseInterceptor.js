/**
 * MSE Interceptor — MAIN world script
 *
 * Monkey-patches MediaSource / SourceBuffer so we can observe the raw video
 * segments YouTube feeds into MSE.  Only *video* segments are forwarded to
 * the ISOLATED-world content script via window.postMessage.
 *
 * This script MUST run at document_start in the MAIN world so that the
 * patches are in place before YouTube's player JS executes.
 */
(() => {
  "use strict";

  if (window.__NO_ADD_MSE_INTERCEPTOR__) return;
  window.__NO_ADD_MSE_INTERCEPTOR__ = true;

  const CHANNEL = "no-add-mse-intercept";
  const TAG = "[NoAdd-MSE]";

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /** Read the ISO BMFF box type at byte offset 4 of a buffer. */
  function peekBoxType(buffer) {
    if (buffer.byteLength < 8) return null;
    const view = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, 8);
    return String.fromCharCode(view[4], view[5], view[6], view[7]);
  }

  function isInitSegment(buffer) {
    const type = peekBoxType(buffer);
    if (type === "ftyp" || type === "moov") return true;
    // WebM/Matroska: starts with EBML header magic 0x1A 0x45 0xDF 0xA3
    if (buffer.byteLength >= 4) {
      const view = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, 4);
      if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) return true;
    }
    return false;
  }

  function containerType(mimeOrBuffer) {
    if (typeof mimeOrBuffer === "string") {
      return mimeOrBuffer.startsWith("video/webm") ? "webm" : "mp4";
    }
    return "mp4";
  }

  function isVideoMime(mime) {
    if (!mime) return false;
    const lower = mime.toLowerCase();
    return lower.startsWith("video/") || lower.includes("avc") || lower.includes("vp0") || lower.includes("av01");
  }

  function post(type, detail) {
    try {
      window.postMessage({ channel: CHANNEL, type, ...detail }, "*");
    } catch {
      // Structured-clone may fail on detached buffers — best-effort.
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Buffer: keep last init + recent media segments for late listeners  */
  /* ------------------------------------------------------------------ */

  let lastInitSegment = null; // { data, mime, timestampOffset }
  const pendingMediaSegments = []; // last N media segments before content script is ready
  const MAX_PENDING = 20;

  // Listen for "request-replay" from the ISOLATED world content script
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== "request-replay") return;

    if (lastInitSegment) {
      post("init-segment", {
        data: lastInitSegment.data.slice(0),
        mime: lastInitSegment.mime,
        container: lastInitSegment.container,
        timestampOffset: lastInitSegment.timestampOffset
      });
    }
    for (const seg of pendingMediaSegments) {
      post("media-segment", {
        data: seg.data.slice(0),
        mime: seg.mime,
        timestampOffset: seg.timestampOffset
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Track which SourceBuffers carry video                              */
  /* ------------------------------------------------------------------ */

  /** WeakMap<SourceBuffer, { isVideo: boolean, timestampOffset: number }> */
  const sbMeta = new WeakMap();

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function patchedAddSourceBuffer(mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    const video = isVideoMime(mimeType);
    sbMeta.set(sb, { isVideo: video, timestampOffset: 0, mime: mimeType });
    if (video) {
      console.info(TAG, "Video SourceBuffer registered", mimeType);
    }
    return sb;
  };

  /* ------------------------------------------------------------------ */
  /*  Track timestampOffset changes                                      */
  /* ------------------------------------------------------------------ */

  const tsOffsetDesc = Object.getOwnPropertyDescriptor(
    SourceBuffer.prototype,
    "timestampOffset"
  );

  if (tsOffsetDesc?.set) {
    Object.defineProperty(SourceBuffer.prototype, "timestampOffset", {
      get: tsOffsetDesc.get,
      set(value) {
        const meta = sbMeta.get(this);
        if (meta) meta.timestampOffset = value;
        return tsOffsetDesc.set.call(this, value);
      },
      configurable: true,
      enumerable: true
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Intercept appendBuffer                                             */
  /* ------------------------------------------------------------------ */

  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;

  SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data) {
    // Call original first so we never break playback.
    origAppendBuffer.call(this, data);

    const meta = sbMeta.get(this);
    if (!meta?.isVideo) return;

    try {
      // Copy the buffer — YouTube may detach or reuse it.
      const copy = (data instanceof ArrayBuffer)
        ? data.slice(0)
        : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)).buffer;

      if (isInitSegment(copy)) {
        const container = containerType(meta.mime);
        lastInitSegment = { data: copy, mime: meta.mime, timestampOffset: meta.timestampOffset, container };
        pendingMediaSegments.length = 0; // Reset on new init
        post("init-segment", {
          data: copy.slice(0),
          mime: meta.mime,
          container,
          timestampOffset: meta.timestampOffset
        });
      } else {
        pendingMediaSegments.push({ data: copy, mime: meta.mime, timestampOffset: meta.timestampOffset });
        if (pendingMediaSegments.length > MAX_PENDING) {
          pendingMediaSegments.shift();
        }
        post("media-segment", {
          data: copy,
          mime: meta.mime,
          timestampOffset: meta.timestampOffset
        });
      }
    } catch {
      // Never let interception errors affect playback.
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Detect new MediaSource (video change on SPA navigation)            */
  /* ------------------------------------------------------------------ */

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function patchedCreateObjectURL(obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      lastInitSegment = null;
      pendingMediaSegments.length = 0;
      post("new-media-source", { blobUrl: url });
    }
    return url;
  };

  console.info(TAG, "MSE interceptor installed.");
})();
