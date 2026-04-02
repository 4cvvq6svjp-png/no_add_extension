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
    return type === "ftyp" || type === "moov";
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
        post("init-segment", {
          data: copy,
          mime: meta.mime,
          timestampOffset: meta.timestampOffset
        });
      } else {
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
      post("new-media-source", { blobUrl: url });
    }
    return url;
  };

  console.info(TAG, "MSE interceptor installed.");
})();
