(() => {
  if (window.__NO_ADD_EXTENSION_LOADED__) {
    return;
  }
  window.__NO_ADD_EXTENSION_LOADED__ = true;

  const EXTENSION_TAG = "[NoAddExtension]";
  const OCR_MESSAGE_CHANNEL = "no-add-extension-ocr";

  const CONFIG = {
    frameSampleSeconds: 5,
    minSegmentSeconds: 3,
    mergeGapSeconds: 2,
    noMatchGraceSeconds: 8,
    skipMarginSeconds: 0.4,
    skipCooldownMs: 900,
    analysisPollMs: 1200,
    canvasWidth: 420,
    canvasHeight: 236,
    ocrRoiTopFraction: 0.25,
    overlayPollMs: 750,
    initTimeoutMs: 20000
  };

  const COMMERCIAL_KEYWORDS = [
    "collaboration commerciale",
    "communication commerciale",
    "contenu sponsorise",
    "video sponsorisee",
    "sponsorise par",
    "sponsor",
    "partenariat remunere",
    "publicite"
  ];

  function logInfo(message, extra) {
    if (extra === undefined) {
      console.info(EXTENSION_TAG, message);
      return;
    }
    console.info(EXTENSION_TAG, message, extra);
  }

  function logWarn(message, extra) {
    if (extra === undefined) {
      console.warn(EXTENSION_TAG, message);
      return;
    }
    console.warn(EXTENSION_TAG, message, extra);
  }

  function normalizeText(text) {
    if (!text) {
      return "";
    }

    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function extractCommercialKeywords(rawText) {
    const normalized = normalizeText(rawText);

    if (!normalized) {
      return [];
    }

    return COMMERCIAL_KEYWORDS.filter((keyword) =>
      normalized.includes(normalizeText(keyword))
    );
  }

  function combineSources(previousSource, nextSource) {
    const labels = new Set();

    for (const label of `${previousSource}+${nextSource}`.split("+")) {
      const trimmed = label.trim();
      if (trimmed) {
        labels.add(trimmed);
      }
    }

    return Array.from(labels).join("+");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatErrorForLog(error) {
    if (error instanceof Error) {
      const base = error.message?.trim() || error.name || "Error";
      return error.stack ? `${base} (${error.stack.split("\n")[0]})` : base;
    }
    if (error === undefined || error === null) {
      return String(error);
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  async function waitForVideoElement(timeoutMs) {
    const startAt = Date.now();

    while (Date.now() - startAt < timeoutMs) {
      const video =
        document.querySelector("video.html5-main-video") ??
        document.querySelector("#movie_player video") ??
        document.querySelector("video");

      if (video instanceof HTMLVideoElement) {
        return video;
      }

      await sleep(250);
    }

    return null;
  }

  function getVideoIdFromCurrentUrl() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname !== "/watch") {
        return null;
      }

      return url.searchParams.get("v");
    } catch {
      return null;
    }
  }

  class SegmentStore {
    constructor({ mergeGapSeconds, minSegmentSeconds }) {
      this.mergeGapSeconds = mergeGapSeconds;
      this.minSegmentSeconds = minSegmentSeconds;
      this.segments = [];
    }

    addSegment(segment) {
      const safeStart = Math.max(0, Number(segment?.start ?? 0));
      const safeEnd = Math.max(safeStart, Number(segment?.end ?? safeStart));
      const duration = safeEnd - safeStart;

      if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
        return false;
      }

      if (duration < this.minSegmentSeconds) {
        return false;
      }

      const normalizedSegment = {
        start: safeStart,
        end: safeEnd,
        source: segment?.source ?? "unknown",
        confidence: Number(segment?.confidence ?? 0.5)
      };

      this.segments.push(normalizedSegment);
      this.segments.sort((a, b) => a.start - b.start);

      const merged = [];

      for (const current of this.segments) {
        const previous = merged[merged.length - 1];

        if (!previous) {
          merged.push({ ...current });
          continue;
        }

        const overlapOrNear = current.start <= previous.end + this.mergeGapSeconds;
        if (!overlapOrNear) {
          merged.push({ ...current });
          continue;
        }

        previous.end = Math.max(previous.end, current.end);
        previous.source = combineSources(previous.source, current.source);
        previous.confidence = Math.max(previous.confidence, current.confidence);
      }

      this.segments = merged;
      return true;
    }

    findSegmentForTime(time) {
      if (!Number.isFinite(time)) {
        return null;
      }

      for (const segment of this.segments) {
        if (time >= segment.start && time < segment.end) {
          return segment;
        }
      }

      return null;
    }

    clear() {
      this.segments = [];
    }

    getAll() {
      return this.segments.map((segment) => ({ ...segment }));
    }
  }

  class PlayerNotifier {
    constructor() {
      this.container = null;
      this.hideTimeout = null;
    }

    show(message, timeoutMs = 2500) {
      const player = document.querySelector("#movie_player");
      if (!player) {
        return;
      }

      if (!this.container) {
        this.container = document.createElement("div");
        this.container.setAttribute("data-no-add-toast", "true");
        this.container.style.position = "absolute";
        this.container.style.top = "14px";
        this.container.style.right = "14px";
        this.container.style.maxWidth = "300px";
        this.container.style.padding = "10px 12px";
        this.container.style.borderRadius = "10px";
        this.container.style.background = "rgba(15, 15, 15, 0.82)";
        this.container.style.color = "white";
        this.container.style.fontSize = "12px";
        this.container.style.lineHeight = "1.35";
        this.container.style.fontFamily = "Inter, Arial, sans-serif";
        this.container.style.backdropFilter = "blur(4px)";
        this.container.style.zIndex = "9999";
        this.container.style.opacity = "0";
        this.container.style.transition = "opacity 160ms ease";
        this.container.style.pointerEvents = "none";
        player.appendChild(this.container);
      }

      this.container.textContent = message;
      this.container.style.opacity = "1";

      if (this.hideTimeout !== null) {
        window.clearTimeout(this.hideTimeout);
      }

      this.hideTimeout = window.setTimeout(() => {
        if (this.container) {
          this.container.style.opacity = "0";
        }
      }, timeoutMs);
    }

    destroy() {
      if (this.hideTimeout !== null) {
        window.clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }

      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }

      this.container = null;
    }
  }

  class OverlayDetector {
    constructor({ video, onSegmentDetected }) {
      this.video = video;
      this.onSegmentDetected = onSegmentDetected;
      this.overlayActive = false;
      this.overlayStart = null;
      this.pollInterval = null;
      this.mutationObserver = null;
      this.lastCheckAt = 0;
    }

    start() {
      this.checkNow();
      this.pollInterval = window.setInterval(
        () => this.checkNow(),
        CONFIG.overlayPollMs
      );

      this.mutationObserver = new MutationObserver(() => {
        const now = Date.now();
        if (now - this.lastCheckAt < 150) {
          return;
        }
        this.checkNow();
      });

      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    stop() {
      if (this.pollInterval !== null) {
        window.clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }

      if (this.overlayActive && this.overlayStart !== null) {
        const endTime = Number(this.video?.currentTime ?? this.overlayStart);
        this.onSegmentDetected({
          start: this.overlayStart,
          end: endTime,
          source: "dom-overlay",
          confidence: 0.9
        });
      }

      this.overlayActive = false;
      this.overlayStart = null;
    }

    checkNow() {
      this.lastCheckAt = Date.now();
      const matches = this.getCurrentOverlayMatches();
      const visible = matches.length > 0;
      const currentTime = Number(this.video?.currentTime ?? 0);

      if (visible && !this.overlayActive) {
        this.overlayActive = true;
        this.overlayStart = currentTime;
        logInfo("Overlay commercial détecté", { currentTime, matches });
        return;
      }

      if (!visible && this.overlayActive && this.overlayStart !== null) {
        this.overlayActive = false;
        const start = this.overlayStart;
        const end = currentTime;
        this.overlayStart = null;
        logInfo("Overlay commercial terminé", { start, end });
        this.onSegmentDetected({
          start,
          end,
          source: "dom-overlay",
          confidence: 0.9
        });
      }
    }

    getCurrentOverlayMatches() {
      const player = document.querySelector("#movie_player");
      if (!player) {
        return [];
      }

      const textBlocks = [];
      const selectors = [
        ".ytp-paid-content-overlay",
        ".ytp-paid-content-overlay-text",
        ".ytp-chrome-top",
        ".ytp-title",
        ".ytp-title-text",
        ".ytp-impression-link"
      ];

      for (const selector of selectors) {
        const nodes = player.querySelectorAll(selector);
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          if (!node.innerText && !node.textContent) {
            continue;
          }
          textBlocks.push(node.innerText || node.textContent || "");
        }
      }

      if (textBlocks.length === 0) {
        textBlocks.push(player.innerText || "");
      }

      return extractCommercialKeywords(textBlocks.join(" "));
    }
  }

  class FrameClassifier {
    constructor() {
      // Full-frame canvas for drawing the source
      this.canvas = document.createElement("canvas");
      this.canvas.width = CONFIG.canvasWidth;
      this.canvas.height = CONFIG.canvasHeight;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });

      // ROI canvas: only the top portion where overlay text appears
      this.roiHeight = Math.round(CONFIG.canvasHeight * CONFIG.ocrRoiTopFraction);
      this.roiCanvas = document.createElement("canvas");
      this.roiCanvas.width = CONFIG.canvasWidth;
      this.roiCanvas.height = this.roiHeight;
      this.roiCtx = this.roiCanvas.getContext("2d", { willReadFrequently: false });
      this.textDetector = null;
      if ("TextDetector" in window) {
        try {
          this.textDetector = new window.TextDetector();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logWarn("TextDetector présent mais non initialisable", { message });
        }
      }

      const canUseTesseractIframe = Boolean(chrome?.runtime?.getURL);
      if (this.textDetector) {
        this.ocrBackend = "text-detector";
      } else if (canUseTesseractIframe) {
        this.ocrBackend = "tesseract";
      } else {
        this.ocrBackend = null;
      }

      this.ocrIframe = null;
      this.tesseractBridgePromise = null;
      this.lastOcrError = null;
    }

    isAvailable() {
      return Boolean(this.ctx && this.ocrBackend);
    }

    getBackendLabel() {
      return this.ocrBackend ?? "none";
    }

    /**
     * Copy the top portion of the full-frame canvas into the smaller ROI
     * canvas.  This dramatically reduces the pixel count sent to Tesseract
     * since the "collaboration commerciale" overlay always appears at the top.
     */
    prepareRoiCanvas() {
      this.roiCtx.drawImage(
        this.canvas,
        0, 0, this.canvas.width, this.roiHeight,   // source rect
        0, 0, this.roiCanvas.width, this.roiHeight  // dest rect
      );
    }

    async ensureOcrIframe() {
      if (this.ocrIframe?.isConnected) {
        return;
      }

      const readyPromise = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("sandbox-ready timeout")),
          25000
        );

        const onMsg = (event) => {
          const data = event.data;
          if (
            data?.channel !== OCR_MESSAGE_CHANNEL ||
            data?.type !== "sandbox-ready"
          ) {
            return;
          }
          window.removeEventListener("message", onMsg);
          window.clearTimeout(timeout);
          resolve();
        };

        window.addEventListener("message", onMsg);
      });

      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-no-add-ocr-sandbox", "true");
      iframe.src = chrome.runtime.getURL("pages/ocr-sandbox.html");
      iframe.style.cssText =
        "position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;";
      const root = document.documentElement ?? document.body;
      root.appendChild(iframe);

      await readyPromise;
      this.ocrIframe = iframe;
    }

    async iframeOcrRequest(type, payload, transferList) {
      const win = this.ocrIframe?.contentWindow;
      if (!win) {
        throw new Error("iframe OCR indisponible");
      }

      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`OCR iframe timeout (${type})`));
        }, type === "init" ? 120000 : 90000);

        const onMsg = (event) => {
          const data = event.data;
          if (
            data?.channel !== OCR_MESSAGE_CHANNEL ||
            data.reqId !== reqId
          ) {
            return;
          }

          cleanup();

          if (
            data.type === "init-ok" ||
            data.type === "recognize-ok" ||
            data.type === "terminate-ok"
          ) {
            resolve(data);
            return;
          }

          reject(new Error(data.error || data.type || "ocr-iframe-error"));
        };

        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMsg);
        };

        window.addEventListener("message", onMsg);
        win.postMessage(
          { channel: OCR_MESSAGE_CHANNEL, type, reqId, ...payload },
          "*",
          transferList ?? []
        );
      });
    }

    async ensureTesseractBridge() {
      if (this.ocrBackend !== "tesseract") {
        return null;
      }

      if (this.tesseractBridgePromise) {
        return this.tesseractBridgePromise;
      }

      this.tesseractBridgePromise = (async () => {
        await this.ensureOcrIframe();
        await this.iframeOcrRequest("init", {});
        logInfo("Tesseract prêt (sandbox iframe chrome-extension://).");
        return true;
      })().catch((error) => {
        const message = formatErrorForLog(error);
        logWarn("Échec d’initialisation Tesseract (iframe)", {
          message,
          error
        });
        this.tesseractBridgePromise = null;
        if (this.ocrIframe) {
          this.ocrIframe.remove();
          this.ocrIframe = null;
        }
        return null;
      });

      return this.tesseractBridgePromise;
    }

    async terminate() {
      if (this.ocrBackend === "tesseract" && this.ocrIframe?.contentWindow) {
        try {
          await this.iframeOcrRequest("terminate", {});
        } catch {
          // best-effort
        }
      }

      if (this.ocrIframe) {
        this.ocrIframe.remove();
        this.ocrIframe = null;
      }

      this.tesseractBridgePromise = null;
    }

    async detectFromVideo(video, sampleTime) {
      if (!this.ctx || !this.ocrBackend) {
        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "ocr-unavailable"
        };
      }

      try {
        this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastOcrError !== message) {
          this.lastOcrError = message;
          logWarn("Impossible de copier la frame vidéo sur le canvas", { message });
        }

        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "canvas-draw-error"
        };
      }

      if (this.ocrBackend === "text-detector") {
        return this.detectWithTextDetector(sampleTime);
      }

      return this.detectWithTesseract(sampleTime);
    }

    async detectFromBitmap(imageBitmap, sampleTime) {
      if (!this.ctx || !this.ocrBackend) {
        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "ocr-unavailable"
        };
      }

      try {
        this.ctx.drawImage(imageBitmap, 0, 0, this.canvas.width, this.canvas.height);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastOcrError !== message) {
          this.lastOcrError = message;
          logWarn("Impossible de dessiner le bitmap sur le canvas", { message });
        }

        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "bitmap-draw-error"
        };
      }

      if (this.ocrBackend === "text-detector") {
        return this.detectWithTextDetector(sampleTime);
      }

      return this.detectWithTesseract(sampleTime);
    }

    async detectWithTextDetector(sampleTime) {
      try {
        this.prepareRoiCanvas();
        const blocks = await this.textDetector.detect(this.roiCanvas);
        const extractedText = blocks
          .map((block) => block?.rawValue ?? "")
          .filter(Boolean)
          .join(" ");
        const matchedKeywords = extractCommercialKeywords(extractedText);

        return {
          sampleTime,
          hasCommercialKeyword: matchedKeywords.length > 0,
          matchedKeywords,
          source: "text-detector",
          extractedText
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastOcrError !== message) {
          this.lastOcrError = message;
          logWarn("Impossible d'analyser une frame pour OCR (TextDetector)", {
            message
          });
        }

        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "text-detector-error"
        };
      }
    }

    async detectWithTesseract(sampleTime) {
      // Fast path: if TextDetector is also available, use it as a quick
      // pre-filter (~10ms).  If it finds no text at all in the ROI, skip
      // the expensive Tesseract call entirely.
      if (this.textDetector) {
        try {
          this.prepareRoiCanvas();
          const blocks = await this.textDetector.detect(this.roiCanvas);
          if (!blocks || blocks.length === 0) {
            return {
              sampleTime,
              hasCommercialKeyword: false,
              matchedKeywords: [],
              source: "text-detector-prefilter-empty"
            };
          }

          // TextDetector found text — check if it already matches keywords
          const quickText = blocks
            .map((b) => b?.rawValue ?? "")
            .filter(Boolean)
            .join(" ");
          const quickMatch = extractCommercialKeywords(quickText);
          if (quickMatch.length > 0) {
            return {
              sampleTime,
              hasCommercialKeyword: true,
              matchedKeywords: quickMatch,
              source: "text-detector-prefilter",
              extractedText: quickText
            };
          }
          // Text found but no keyword match — fall through to Tesseract
          // for more accurate OCR (TextDetector can miss accented chars).
        } catch {
          // TextDetector failed, fall through to Tesseract.
        }
      }

      const bridge = await this.ensureTesseractBridge();
      if (!bridge) {
        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "tesseract-unavailable"
        };
      }

      let bitmap = null;

      try {
        // Use the smaller ROI canvas for Tesseract (top 25% of frame)
        this.prepareRoiCanvas();
        bitmap = await createImageBitmap(this.roiCanvas);
        const result = await this.iframeOcrRequest(
          "recognize",
          { imageBitmap: bitmap },
          [bitmap]
        );
        bitmap = null;

        const extractedText = result.text ?? "";
        const matchedKeywords = extractCommercialKeywords(extractedText);

        return {
          sampleTime,
          hasCommercialKeyword: matchedKeywords.length > 0,
          matchedKeywords,
          source: "tesseract",
          extractedText
        };
      } catch (error) {
        if (bitmap) {
          try {
            bitmap.close();
          } catch {
            // ignore
          }
        }

        const message = error instanceof Error ? error.message : String(error);
        if (this.lastOcrError !== message) {
          this.lastOcrError = message;
          logWarn("Impossible d'analyser une frame pour OCR (Tesseract)", {
            message
          });
        }

        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "tesseract-error"
        };
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  AheadScanner — MSE interception + WebCodecs decoder                */
  /*  Replaces GhostAnalyzer: no ghost <video>, instead we intercept     */
  /*  the raw fMP4 segments YouTube feeds into MSE, decode keyframes     */
  /*  via WebCodecs in an iframe sandbox, and OCR the resulting bitmaps. */
  /* ------------------------------------------------------------------ */

  const MSE_CHANNEL = "no-add-mse-intercept";
  const DECODER_CHANNEL = "no-add-decoder";

  class AheadScanner {
    constructor({ mainVideo, frameClassifier, segmentStore }) {
      this.mainVideo = mainVideo;
      this.frameClassifier = frameClassifier;
      this.segmentStore = segmentStore;

      this.ocrSourceTag = "ahead-ocr";
      this.activeCommercialStart = null;
      this.lastPositiveSample = null;

      // Captured MSE data
      this.initSegment = null;
      this.capturedSegments = []; // [{ data, timestampOffset }]
      this.maxBufferSeconds = 60;

      // Decoder iframe
      this.decoderIframe = null;
      this.decoderReady = false;
      this.decoderConfigured = false;
      this.decoderBridgePromise = null;

      // Scanning state
      this.lastScannedTime = -Infinity;
      this.pendingScan = false;
      this.scanInterval = null;
      this.fallbackInterval = null;
      this.useFallback = false;

      // Bound listener
      this.boundOnMseMessage = (event) => this.onMseMessage(event);
    }

    async start() {
      if (!this.frameClassifier.isAvailable()) {
        logWarn("Aucun moteur OCR disponible, AheadScanner désactivé.");
        return;
      }

      logInfo("AheadScanner démarré", {
        backend: this.frameClassifier.getBackendLabel()
      });

      // Listen for MSE intercepted data from MAIN world
      window.addEventListener("message", this.boundOnMseMessage);

      // Periodic scan for new segments to process
      this.scanInterval = window.setInterval(
        () => void this.scanNext(),
        CONFIG.analysisPollMs
      );

      // Fallback: if no MSE data arrives within 8s, fall back to main video OCR
      this.fallbackTimeout = window.setTimeout(() => {
        if (!this.initSegment) {
          logWarn("Aucun segment MSE reçu — repli OCR sur la vidéo principale.");
          this.useFallback = true;
          this.ocrSourceTag = "main-video-ocr";
          this.startFallbackPolling();
        }
      }, 8000);
    }

    stop() {
      window.removeEventListener("message", this.boundOnMseMessage);

      if (this.scanInterval !== null) {
        window.clearInterval(this.scanInterval);
        this.scanInterval = null;
      }

      if (this.fallbackTimeout !== null) {
        window.clearTimeout(this.fallbackTimeout);
        this.fallbackTimeout = null;
      }

      if (this.fallbackInterval !== null) {
        window.clearInterval(this.fallbackInterval);
        this.fallbackInterval = null;
      }

      // Flush pending commercial segment
      if (this.activeCommercialStart !== null) {
        const end = Number(this.lastPositiveSample ?? this.activeCommercialStart);
        this.segmentStore.addSegment({
          start: this.activeCommercialStart,
          end: end + CONFIG.frameSampleSeconds * 0.7,
          source: this.ocrSourceTag,
          confidence: 0.75
        });
      }

      this.activeCommercialStart = null;
      this.lastPositiveSample = null;
      this.lastScannedTime = -Infinity;
      this.pendingScan = false;
      this.initSegment = null;
      this.capturedSegments = [];

      // Destroy decoder iframe
      if (this.decoderIframe) {
        try {
          this.decoderIframe.contentWindow?.postMessage(
            { channel: DECODER_CHANNEL, type: "terminate", reqId: "teardown" },
            "*"
          );
        } catch { /* best-effort */ }
        this.decoderIframe.remove();
        this.decoderIframe = null;
      }

      this.decoderReady = false;
      this.decoderConfigured = false;
      this.decoderBridgePromise = null;
    }

    /* ---------------------------------------------------------------- */
    /*  MSE message handling (from MAIN world interceptor)               */
    /* ---------------------------------------------------------------- */

    onMseMessage(event) {
      const msg = event.data;
      if (!msg || msg.channel !== MSE_CHANNEL) return;

      if (msg.type === "new-media-source") {
        // New video — reset state
        this.initSegment = null;
        this.capturedSegments = [];
        this.lastScannedTime = -Infinity;
        this.decoderConfigured = false;
        logInfo("AheadScanner: nouveau MediaSource détecté, reset.");
        return;
      }

      if (msg.type === "init-segment") {
        this.initSegment = msg.data;
        this.decoderConfigured = false;
        this.useFallback = false;

        if (this.fallbackTimeout !== null) {
          window.clearTimeout(this.fallbackTimeout);
          this.fallbackTimeout = null;
        }
        if (this.fallbackInterval !== null) {
          window.clearInterval(this.fallbackInterval);
          this.fallbackInterval = null;
        }

        this.ocrSourceTag = "ahead-ocr";
        logInfo("AheadScanner: init segment capturé", {
          bytes: msg.data?.byteLength,
          mime: msg.mime
        });
        return;
      }

      if (msg.type === "media-segment") {
        if (!this.initSegment) return; // Ignore media without init

        this.capturedSegments.push({
          data: msg.data,
          timestampOffset: msg.timestampOffset ?? 0,
          receivedAt: Date.now()
        });

        // Evict old segments (behind main video position - 10s)
        this.evictOldSegments();
        return;
      }
    }

    evictOldSegments() {
      const maxSegments = 30;
      if (this.capturedSegments.length > maxSegments) {
        this.capturedSegments = this.capturedSegments.slice(-maxSegments);
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Decoder iframe lifecycle                                         */
    /* ---------------------------------------------------------------- */

    async ensureDecoderIframe() {
      if (this.decoderIframe?.isConnected && this.decoderReady) return;

      if (this.decoderBridgePromise) return this.decoderBridgePromise;

      this.decoderBridgePromise = (async () => {
        const readyPromise = new Promise((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("decoder-sandbox-ready timeout")),
            15000
          );

          const onMsg = (event) => {
            const data = event.data;
            if (data?.channel !== DECODER_CHANNEL || data?.type !== "sandbox-ready") return;
            window.removeEventListener("message", onMsg);
            window.clearTimeout(timeout);
            resolve();
          };
          window.addEventListener("message", onMsg);
        });

        const iframe = document.createElement("iframe");
        iframe.setAttribute("data-no-add-decoder-sandbox", "true");
        iframe.src = chrome.runtime.getURL("pages/decoder-sandbox.html");
        iframe.style.cssText =
          "position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;";
        (document.documentElement ?? document.body).appendChild(iframe);

        await readyPromise;
        this.decoderIframe = iframe;
        this.decoderReady = true;
        logInfo("AheadScanner: decoder sandbox prêt.");
      })().catch((error) => {
        logWarn("AheadScanner: échec initialisation decoder sandbox", {
          error: formatErrorForLog(error)
        });
        this.decoderBridgePromise = null;
        return null;
      });

      return this.decoderBridgePromise;
    }

    async decoderRequest(type, payload, transferList) {
      const win = this.decoderIframe?.contentWindow;
      if (!win) throw new Error("Decoder iframe indisponible");

      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Decoder timeout (${type})`));
        }, 30000);

        const onMsg = (event) => {
          const data = event.data;
          if (data?.channel !== DECODER_CHANNEL || data.reqId !== reqId) return;
          cleanup();

          if (data.type.endsWith("-ok")) {
            resolve(data);
          } else {
            reject(new Error(data.error || data.type || "decoder-error"));
          }
        };

        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMsg);
        };

        window.addEventListener("message", onMsg);
        win.postMessage(
          { channel: DECODER_CHANNEL, type, reqId, ...payload },
          "*",
          transferList ?? []
        );
      });
    }

    async ensureDecoderConfigured() {
      if (this.decoderConfigured) return true;
      if (!this.initSegment) return false;

      await this.ensureDecoderIframe();
      if (!this.decoderIframe) return false;

      try {
        await this.decoderRequest("configure", {
          initSegment: this.initSegment.slice(0)
        }, [this.initSegment.slice(0)]);
        this.decoderConfigured = true;
        logInfo("AheadScanner: decoder configuré.");
        return true;
      } catch (error) {
        logWarn("AheadScanner: échec configuration decoder", {
          error: formatErrorForLog(error)
        });
        return false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Scanning logic                                                   */
    /* ---------------------------------------------------------------- */

    async scanNext() {
      if (this.useFallback) return; // Handled by fallback polling
      if (this.pendingScan) return;
      if (!this.initSegment || this.capturedSegments.length === 0) return;

      this.pendingScan = true;

      try {
        const configured = await this.ensureDecoderConfigured();
        if (!configured) return;

        // Find the next unscanned segment
        const segmentEntry = this.capturedSegments.find((entry) => !entry.scanned);
        if (!segmentEntry) return;

        segmentEntry.scanned = true;

        // Send the raw media segment to the decoder sandbox which handles
        // both fMP4 parsing and keyframe decoding (mp4demux lives there).
        const result = await this.decoderRequest("scan-segment", {
          mediaSegment: segmentEntry.data,
          minTime: this.lastScannedTime + CONFIG.frameSampleSeconds,
          sampleInterval: CONFIG.frameSampleSeconds
        }, [segmentEntry.data]);

        if (!result.frames || result.frames.length === 0) return;

        for (const frame of result.frames) {
          if (!frame.imageBitmap) continue;

          try {
            const detection = await this.frameClassifier.detectFromBitmap(
              frame.imageBitmap,
              frame.timestamp
            );

            try { frame.imageBitmap.close(); } catch { /* ignore */ }

            this.consumeDetection(detection);
            this.lastScannedTime = frame.timestamp;

            logInfo("AheadScanner: frame analysée", {
              time: frame.timestamp.toFixed(1),
              keyword: detection.hasCommercialKeyword,
              lead: (frame.timestamp - this.mainVideo.currentTime).toFixed(1) + "s en avance"
            });
          } catch (error) {
            try { frame.imageBitmap.close(); } catch { /* ignore */ }
            logWarn("AheadScanner: échec OCR sur frame décodée", {
              time: frame.timestamp,
              error: formatErrorForLog(error)
            });
          }
        }
      } catch (error) {
        logWarn("AheadScanner: échec scan-segment", {
          error: formatErrorForLog(error)
        });
      } finally {
        this.pendingScan = false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Fallback: OCR on main video (no MSE data available)              */
    /* ---------------------------------------------------------------- */

    startFallbackPolling() {
      if (this.fallbackInterval !== null) return;

      this.fallbackInterval = window.setInterval(
        () => void this.fallbackTick(),
        CONFIG.analysisPollMs
      );
    }

    async fallbackTick() {
      if (this.pendingScan) return;

      const video = this.mainVideo;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      const sampleTime = Number(video.currentTime ?? 0);
      if (sampleTime - this.lastScannedTime < CONFIG.frameSampleSeconds) return;

      this.pendingScan = true;
      try {
        this.lastScannedTime = sampleTime;
        const detection = await this.frameClassifier.detectFromVideo(video, sampleTime);
        this.consumeDetection(detection);
      } finally {
        this.pendingScan = false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Detection accumulation (same logic as old GhostAnalyzer)         */
    /* ---------------------------------------------------------------- */

    consumeDetection(detection) {
      const t = Number(detection.sampleTime ?? 0);
      if (!Number.isFinite(t)) return;

      if (detection.hasCommercialKeyword) {
        if (this.activeCommercialStart === null) {
          this.activeCommercialStart = Math.max(
            0,
            t - CONFIG.frameSampleSeconds * 0.6
          );
        }
        this.lastPositiveSample = t;
        return;
      }

      if (this.activeCommercialStart === null || this.lastPositiveSample === null) {
        return;
      }

      const gap = t - this.lastPositiveSample;
      if (gap < CONFIG.noMatchGraceSeconds) return;

      const start = this.activeCommercialStart;
      const end = this.lastPositiveSample + CONFIG.frameSampleSeconds * 0.7;
      this.activeCommercialStart = null;
      this.lastPositiveSample = null;

      const added = this.segmentStore.addSegment({
        start,
        end,
        source: this.ocrSourceTag,
        confidence: 0.75
      });

      if (added) {
        logInfo("Segment OCR ajouté", { start, end, source: this.ocrSourceTag });
      }
    }
  }

  class SkipController {
    constructor({ video, segmentStore, notifier }) {
      this.video = video;
      this.segmentStore = segmentStore;
      this.notifier = notifier;
      this.interval = null;
      this.lastSkipAt = 0;
      this.boundTick = () => this.tick();
    }

    start() {
      this.video.addEventListener("timeupdate", this.boundTick);
      this.video.addEventListener("seeked", this.boundTick);
      this.interval = window.setInterval(this.boundTick, 220);
    }

    stop() {
      this.video.removeEventListener("timeupdate", this.boundTick);
      this.video.removeEventListener("seeked", this.boundTick);

      if (this.interval !== null) {
        window.clearInterval(this.interval);
        this.interval = null;
      }
    }

    tick() {
      const nowMs = Date.now();
      if (nowMs - this.lastSkipAt < CONFIG.skipCooldownMs) {
        return;
      }

      const currentTime = Number(this.video.currentTime ?? 0);
      const segment = this.segmentStore.findSegmentForTime(currentTime);
      if (!segment) {
        return;
      }

      const targetTime = Math.min(
        segment.end + CONFIG.skipMarginSeconds,
        Math.max(0, (this.video.duration || Infinity) - 0.1)
      );

      if (!Number.isFinite(targetTime) || targetTime <= currentTime + 0.1) {
        return;
      }

      this.lastSkipAt = nowMs;
      this.video.currentTime = targetTime;

      const duration = Math.max(0, segment.end - segment.start).toFixed(1);
      this.notifier.show(
        `Segment commercial sauté (${duration}s, source: ${segment.source}).`
      );
      logInfo("Skip appliqué", {
        from: currentTime,
        to: targetTime,
        source: segment.source
      });
    }
  }

  class NoAddYouTubeController {
    constructor() {
      this.currentVideoId = null;
      this.currentVideo = null;
      this.segmentStore = null;
      this.notifier = null;
      this.overlayDetector = null;
      this.aheadScanner = null;
      this.frameClassifier = null;
      this.skipController = null;
      this.urlWatcherInterval = null;
      this.lastKnownUrl = window.location.href;
      this.initialized = false;
    }

    start() {
      if (this.initialized) {
        return;
      }

      this.initialized = true;
      this.installNavigationWatchers();
      void this.refreshSessionFromUrl();
    }

    installNavigationWatchers() {
      const onNavigationEvent = () => {
        void this.refreshSessionFromUrl();
      };

      document.addEventListener("yt-navigate-finish", onNavigationEvent);
      window.addEventListener("popstate", onNavigationEvent);

      this.urlWatcherInterval = window.setInterval(() => {
        if (window.location.href === this.lastKnownUrl) {
          return;
        }

        this.lastKnownUrl = window.location.href;
        void this.refreshSessionFromUrl();
      }, 900);
    }

    async refreshSessionFromUrl() {
      const videoId = getVideoIdFromCurrentUrl();
      if (!videoId) {
        this.teardownSession();
        return;
      }

      if (videoId === this.currentVideoId && this.currentVideo?.isConnected) {
        return;
      }

      await this.setupSession(videoId);
    }

    async setupSession(videoId) {
      this.teardownSession();

      const video = await waitForVideoElement(CONFIG.initTimeoutMs);
      if (!video) {
        logWarn("Aucune balise <video> détectée dans le délai imparti.");
        return;
      }

      this.currentVideoId = videoId;
      this.currentVideo = video;
      this.segmentStore = new SegmentStore({
        mergeGapSeconds: CONFIG.mergeGapSeconds,
        minSegmentSeconds: CONFIG.minSegmentSeconds
      });
      this.notifier = new PlayerNotifier();

      this.overlayDetector = new OverlayDetector({
        video,
        onSegmentDetected: (segment) => {
          const added = this.segmentStore.addSegment(segment);
          if (added) {
            logInfo("Segment overlay ajouté", segment);
          }
        }
      });
      this.overlayDetector.start();

      const frameClassifier = new FrameClassifier();
      this.frameClassifier = frameClassifier;
      this.aheadScanner = new AheadScanner({
        mainVideo: video,
        frameClassifier,
        segmentStore: this.segmentStore
      });
      await this.aheadScanner.start();

      this.skipController = new SkipController({
        video,
        segmentStore: this.segmentStore,
        notifier: this.notifier
      });
      this.skipController.start();

      this.notifier.show("No Add Extension actif sur cette vidéo.");
      this.pingServiceWorker();
      logInfo("Session initialisée", { videoId });
    }

    teardownSession() {
      this.currentVideoId = null;
      this.currentVideo = null;

      if (this.skipController) {
        this.skipController.stop();
      }
      if (this.aheadScanner) {
        this.aheadScanner.stop();
      }
      if (this.frameClassifier) {
        void this.frameClassifier.terminate();
      }
      if (this.overlayDetector) {
        this.overlayDetector.stop();
      }
      if (this.notifier) {
        this.notifier.destroy();
      }
      if (this.segmentStore) {
        this.segmentStore.clear();
      }

      this.skipController = null;
      this.aheadScanner = null;
      this.frameClassifier = null;
      this.overlayDetector = null;
      this.notifier = null;
      this.segmentStore = null;
    }

    pingServiceWorker() {
      if (!chrome?.runtime?.sendMessage) {
        return;
      }

      chrome.runtime.sendMessage({ type: "runtime:ping" }, () => {
        const ignoredError = chrome.runtime.lastError;
        if (ignoredError) {
          // L'extension continue de fonctionner même sans réponse background.
        }
      });
    }
  }

  const controller = new NoAddYouTubeController();
  controller.start();
})();
