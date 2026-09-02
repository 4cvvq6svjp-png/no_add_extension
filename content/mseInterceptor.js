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

  /** Segments kept so a content script that starts late can replay them. */
  const MAX_PENDING_SEGMENTS = 20;
  /** Cadence of the throughput log. */
  const STATS_LOG_INTERVAL_MS = 5000;

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /** ISO BMFF box type stored at byte offset 4. */
  function peekBoxType(buffer) {
    if (buffer.byteLength < 8) return null;
    const head = new Uint8Array(buffer, 0, 8);
    return String.fromCharCode(head[4], head[5], head[6], head[7]);
  }

  /** WebM/Matroska streams open with the EBML header magic 0x1A45DFA3. */
  function startsWithEbmlMagic(buffer) {
    if (buffer.byteLength < 4) return false;
    const head = new Uint8Array(buffer, 0, 4);
    return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }

  function isInitSegment(buffer) {
    const type = peekBoxType(buffer);
    return type === "ftyp" || type === "moov" || startsWithEbmlMagic(buffer);
  }

  function containerFromMime(mime) {
    return String(mime ?? "").startsWith("video/webm") ? "webm" : "mp4";
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
  /*  Replay buffer: last init + recent media segments for late listeners */
  /* ------------------------------------------------------------------ */

  let lastInitSegment = null; // { data, mime, container, timestampOffset }
  let pendingMediaSegments = [];
  // The content script asks for a replay once, when its session starts. After
  // that, holding on to full segments would pin megabytes for the whole video,
  // so we stop buffering until the next MediaSource (SPA navigation) starts a
  // new session that will replay again.
  let bufferingForReplay = true;

  // Stats for throttled cadence logging
  let mediaSegmentCount = 0;
  let mediaSegmentBytes = 0;
  let lastStatsLogAt = 0;

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
    for (const segment of pendingMediaSegments) {
      post("media-segment", {
        data: segment.data.slice(0),
        mime: segment.mime,
        timestampOffset: segment.timestampOffset
      });
    }

    pendingMediaSegments = [];
    bufferingForReplay = false;
  });

  /* ------------------------------------------------------------------ */
  /*  Track which SourceBuffers carry video                              */
  /* ------------------------------------------------------------------ */

  /** WeakMap<SourceBuffer, { isVideo: boolean, timestampOffset: number, mime: string }> */
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
    const meta = sbMeta.get(this);

    // Copy BEFORE handing to the browser. appendBuffer may take ownership of
    // a transferable buffer and detach it asynchronously, after which our
    // copy attempt would silently fail.
    let copy = null;
    if (meta?.isVideo) {
      try {
        copy = (data instanceof ArrayBuffer)
          ? data.slice(0)
          : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)).buffer;
      } catch {
        copy = null;
      }
    }

    origAppendBuffer.call(this, data);

    if (!copy) return;

    try {
      if (isInitSegment(copy)) {
        const container = containerFromMime(meta.mime);
        lastInitSegment = { data: copy, mime: meta.mime, timestampOffset: meta.timestampOffset, container };
        pendingMediaSegments = [];
        post("init-segment", {
          data: copy.slice(0),
          mime: meta.mime,
          container,
          timestampOffset: meta.timestampOffset
        });
        return;
      }

      if (bufferingForReplay) {
        pendingMediaSegments.push({ data: copy, mime: meta.mime, timestampOffset: meta.timestampOffset });
        if (pendingMediaSegments.length > MAX_PENDING_SEGMENTS) {
          pendingMediaSegments.shift();
        }
      }

      post("media-segment", {
        data: copy,
        mime: meta.mime,
        timestampOffset: meta.timestampOffset
      });

      mediaSegmentCount += 1;
      mediaSegmentBytes += copy.byteLength;
      const now = Date.now();
      if (now - lastStatsLogAt > STATS_LOG_INTERVAL_MS) {
        console.info(TAG, `media-segments: ${mediaSegmentCount} reçus, ${(mediaSegmentBytes / 1024).toFixed(0)} KB cumulés`);
        lastStatsLogAt = now;
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
      pendingMediaSegments = [];
      // A new video means a new content-script session, which will replay.
      bufferingForReplay = true;
      post("new-media-source", { blobUrl: url });
    }
    return url;
  };

  console.info(TAG, "MSE interceptor installed.");
})();
