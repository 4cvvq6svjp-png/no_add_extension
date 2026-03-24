(() => {
  if (window.__NO_ADD_EXTENSION_LOADED__) {
    return;
  }
  window.__NO_ADD_EXTENSION_LOADED__ = true;

  const EXTENSION_TAG = "[NoAddExtension]";

  const CONFIG = {
    frameSampleSeconds: 5,
    minSegmentSeconds: 3,
    mergeGapSeconds: 2,
    noMatchGraceSeconds: 8,
    skipMarginSeconds: 0.4,
    skipCooldownMs: 900,
    analysisPollMs: 1200,
    ghostPlaybackRate: 3,
    ghostTargetLeadSeconds: 35,
    ghostMinLeadSeconds: 10,
    canvasWidth: 420,
    canvasHeight: 236,
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

  function isBlobUrl(value) {
    return typeof value === "string" && value.startsWith("blob:");
  }

  function isGoogleVideoPlaybackUrl(value) {
    if (typeof value !== "string" || !value) {
      return false;
    }

    return value.includes("googlevideo.com/videoplayback");
  }

  function describeSourceType(value) {
    if (!value) {
      return "none";
    }

    if (isBlobUrl(value)) {
      return "blob";
    }

    if (isGoogleVideoPlaybackUrl(value)) {
      return "googlevideo-signed";
    }

    try {
      return new URL(value).host || "unknown-host";
    } catch {
      return "unknown-format";
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
      this.canvas = document.createElement("canvas");
      this.canvas.width = CONFIG.canvasWidth;
      this.canvas.height = CONFIG.canvasHeight;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
      this.textDetector = null;
      if ("TextDetector" in window) {
        try {
          this.textDetector = new window.TextDetector();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logWarn("TextDetector présent mais non initialisable", { message });
        }
      }

      const hasTesseract = typeof self.Tesseract?.createWorker === "function";
      if (this.textDetector) {
        this.ocrBackend = "text-detector";
      } else if (hasTesseract) {
        this.ocrBackend = "tesseract";
      } else {
        this.ocrBackend = null;
      }

      this.tesseractWorker = null;
      this.tesseractInitPromise = null;
      this.lastOcrError = null;
    }

    isAvailable() {
      return Boolean(this.ctx && this.ocrBackend);
    }

    getBackendLabel() {
      return this.ocrBackend ?? "none";
    }

    async ensureTesseractWorker() {
      if (this.ocrBackend !== "tesseract") {
        return null;
      }

      if (this.tesseractWorker) {
        return this.tesseractWorker;
      }

      if (!this.tesseractInitPromise) {
        this.tesseractInitPromise = (async () => {
          const baseUrl = chrome.runtime.getURL("libs/tesseract/");
          const worker = await self.Tesseract.createWorker("fra", 1, {
            workerPath: `${baseUrl}worker.min.js`,
            corePath: `${baseUrl}tesseract-core-simd.wasm.js`,
            langPath: "https://tessdata.projectnaptha.com/4.0.0",
            gzip: true,
            logger: () => {}
          });

          await worker.setParameters({
            tessedit_pageseg_mode: String(self.Tesseract?.PSM?.SINGLE_BLOCK ?? "6")
          });

          this.tesseractWorker = worker;
          logInfo("Worker Tesseract prêt (fallback OCR).");
          return worker;
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logWarn("Échec d’initialisation Tesseract", { message });
          this.tesseractInitPromise = null;
          return null;
        });
      }

      return this.tesseractInitPromise;
    }

    async terminate() {
      if (!this.tesseractWorker) {
        this.tesseractInitPromise = null;
        return;
      }

      try {
        await this.tesseractWorker.terminate();
      } catch {
        // nettoyage best-effort
      }

      this.tesseractWorker = null;
      this.tesseractInitPromise = null;
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

    async detectWithTextDetector(sampleTime) {
      try {
        const blocks = await this.textDetector.detect(this.canvas);
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
      const worker = await this.ensureTesseractWorker();
      if (!worker) {
        return {
          sampleTime,
          hasCommercialKeyword: false,
          matchedKeywords: [],
          source: "tesseract-unavailable"
        };
      }

      try {
        const {
          data: { text }
        } = await worker.recognize(this.canvas);
        const extractedText = text ?? "";
        const matchedKeywords = extractCommercialKeywords(extractedText);

        return {
          sampleTime,
          hasCommercialKeyword: matchedKeywords.length > 0,
          matchedKeywords,
          source: "tesseract",
          extractedText
        };
      } catch (error) {
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

  class GhostAnalyzer {
    constructor({ mainVideo, frameClassifier, segmentStore }) {
      this.mainVideo = mainVideo;
      this.frameClassifier = frameClassifier;
      this.segmentStore = segmentStore;

      this.ghostVideo = null;
      this.ocrSourceTag = "ghost-ocr";
      this.analysisInterval = null;
      this.lastSampleTime = -Infinity;
      this.activeCommercialStart = null;
      this.lastPositiveSample = null;
      this.pendingTick = false;
    }

    async start() {
      if (!this.frameClassifier.isAvailable()) {
        logWarn(
          "Aucun moteur OCR (TextDetector + Tesseract), branche lecteur fantôme désactivée."
        );
        return;
      }

      logInfo("Moteur OCR (lecteur fantôme ou repli vidéo principale)", {
        backend: this.frameClassifier.getBackendLabel()
      });

      const ghost = await this.createGhostVideo();
      if (ghost) {
        this.ghostVideo = ghost;
        this.ocrSourceTag = "ghost-ocr";
      } else {
        this.ocrSourceTag = "main-video-ocr";
        logWarn(
          "Lecteur fantôme indisponible — OCR sur la vidéo principale (pas d’analyse en avance)."
        );
      }

      this.analysisInterval = window.setInterval(
        () => void this.tick(),
        CONFIG.analysisPollMs
      );
      void this.tick();
    }

    stop() {
      if (this.analysisInterval !== null) {
        window.clearInterval(this.analysisInterval);
        this.analysisInterval = null;
      }

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
      this.lastSampleTime = -Infinity;
      this.pendingTick = false;

      if (this.ghostVideo) {
        this.ghostVideo.pause();
        this.ghostVideo.srcObject = null;
        this.ghostVideo.src = "";
        this.ghostVideo.remove();
        this.ghostVideo = null;
      }
    }

    async createGhostVideo() {
      const ghost = document.createElement("video");
      ghost.muted = true;
      ghost.playsInline = true;
      ghost.preload = "auto";
      ghost.style.display = "none";
      document.body.appendChild(ghost);

      const viaStream = await this.tryGhostFromCaptureStream(ghost);
      if (viaStream) {
        return ghost;
      }

      const sourceSelection = this.selectGhostSource();
      if (!sourceSelection?.value) {
        logWarn(
          "Lecteur fantôme: aucune URL exploitable après échec captureStream.",
          {
            reason: sourceSelection?.reason ?? "unknown",
            candidates: sourceSelection?.candidates ?? []
          }
        );
        ghost.remove();
        return null;
      }

      const source = sourceSelection.value;
      ghost.src = source;

      logInfo("Source du lecteur fantôme (URL)", {
        reason: sourceSelection.reason,
        sourceType: describeSourceType(source),
        sourceLabel: sourceSelection.label
      });

      const loaded = await this.waitForGhostReady(ghost, 7000);
      if (!loaded) {
        ghost.remove();
        return null;
      }

      if (Number.isFinite(this.mainVideo.currentTime) && this.mainVideo.currentTime > 0) {
        const target = Math.min(
          this.mainVideo.currentTime + CONFIG.ghostTargetLeadSeconds,
          Math.max(0, (ghost.duration || Infinity) - 0.5)
        );

        if (Number.isFinite(target) && target > 0) {
          try {
            ghost.currentTime = target;
          } catch {
            // Certains flux empêchent le seek initial.
          }
        }
      }

      ghost.playbackRate = CONFIG.ghostPlaybackRate;

      try {
        await ghost.play();
      } catch {
        ghost.remove();
        return null;
      }

      return ghost;
    }

    async tryGhostFromCaptureStream(ghost) {
      if (typeof this.mainVideo.captureStream !== "function") {
        return false;
      }

      try {
        const stream = this.mainVideo.captureStream();
        if (!stream || typeof stream.getTracks !== "function") {
          return false;
        }

        ghost.srcObject = stream;

        const ready = await new Promise((resolve) => {
          const timeout = window.setTimeout(() => resolve(false), 5000);

          const finish = (ok) => {
            window.clearTimeout(timeout);
            ghost.removeEventListener("loadedmetadata", onMeta);
            ghost.removeEventListener("canplay", onPlay);
            ghost.removeEventListener("error", onError);
            resolve(ok);
          };

          const onMeta = () => finish(true);
          const onPlay = () => finish(true);
          const onError = () => finish(false);

          ghost.addEventListener("loadedmetadata", onMeta);
          ghost.addEventListener("canplay", onPlay);
          ghost.addEventListener("error", onError);

          ghost.play().catch(() => finish(false));
        });

        if (
          ready &&
          ghost.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          logInfo("Lecteur fantôme branché via captureStream() (même flux que la vidéo principale).");
          ghost.playbackRate = CONFIG.ghostPlaybackRate;
          return true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn("captureStream indisponible ou refusé pour le lecteur fantôme", {
          message
        });
      }

      ghost.srcObject = null;
      return false;
    }

    waitForGhostReady(ghost, timeoutMs) {
      return new Promise((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), timeoutMs);

        const onLoadedMetadata = () => {
          window.clearTimeout(timeout);
          ghost.removeEventListener("error", onError);
          ghost.removeEventListener("loadedmetadata", onLoadedMetadata);
          resolve(true);
        };

        const onError = () => {
          window.clearTimeout(timeout);
          ghost.removeEventListener("loadedmetadata", onLoadedMetadata);
          ghost.removeEventListener("error", onError);
          resolve(false);
        };

        ghost.addEventListener("loadedmetadata", onLoadedMetadata);
        ghost.addEventListener("error", onError);
      });
    }

    /**
     * Ordre : URL non-blob d’abord (les blobs YouTube échouent souvent sur un 2e <video>),
     * puis URL googlevideo, en dernier recours blob.
     */
    selectGhostSource() {
      const candidates = [
        { label: "attr:src", value: this.mainVideo.getAttribute("src") },
        { label: "video.src", value: this.mainVideo.src },
        { label: "video.currentSrc", value: this.mainVideo.currentSrc }
      ]
        .filter((entry) => typeof entry.value === "string" && entry.value.trim())
        .map((entry) => ({
          label: entry.label,
          value: entry.value.trim()
        }));

      const deduplicated = [];
      const seen = new Set();
      for (const entry of candidates) {
        if (seen.has(entry.value)) {
          continue;
        }
        seen.add(entry.value);
        deduplicated.push(entry);
      }

      const compactCandidates = deduplicated.map((entry) => ({
        label: entry.label,
        type: describeSourceType(entry.value)
      }));

      if (deduplicated.length === 0) {
        return {
          value: null,
          label: null,
          reason: "no-video-source",
          candidates: compactCandidates
        };
      }

      const nonBlobNonGoogle = deduplicated.find(
        (entry) => !isBlobUrl(entry.value) && !isGoogleVideoPlaybackUrl(entry.value)
      );
      if (nonBlobNonGoogle) {
        return {
          value: nonBlobNonGoogle.value,
          label: nonBlobNonGoogle.label,
          reason: "prefer-nonblob-nongoogle",
          candidates: compactCandidates
        };
      }

      const nonBlobGoogle = deduplicated.find(
        (entry) => !isBlobUrl(entry.value) && isGoogleVideoPlaybackUrl(entry.value)
      );
      if (nonBlobGoogle) {
        return {
          value: nonBlobGoogle.value,
          label: nonBlobGoogle.label,
          reason: "prefer-nonblob-googlevideo",
          candidates: compactCandidates
        };
      }

      const blobCandidate = deduplicated.find((entry) => isBlobUrl(entry.value));
      if (blobCandidate) {
        return {
          value: blobCandidate.value,
          label: blobCandidate.label,
          reason: "fallback-blob-last-resort",
          candidates: compactCandidates
        };
      }

      return {
        value: null,
        label: null,
        reason: "no-usable-candidate",
        candidates: compactCandidates
      };
    }

    async tick() {
      const analysisVideo = this.ghostVideo ?? this.mainVideo;
      if (
        this.pendingTick ||
        !analysisVideo ||
        analysisVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }

      this.pendingTick = true;

      try {
        this.keepGhostAhead();

        const sampleTime = Number(analysisVideo.currentTime ?? 0);
        if (sampleTime - this.lastSampleTime < CONFIG.frameSampleSeconds) {
          return;
        }

        this.lastSampleTime = sampleTime;
        const detection = await this.frameClassifier.detectFromVideo(
          analysisVideo,
          sampleTime
        );
        this.consumeDetection(detection);
      } finally {
        this.pendingTick = false;
      }
    }

    keepGhostAhead() {
      if (!this.ghostVideo) {
        return;
      }

      if (this.ghostVideo.srcObject) {
        if (this.ghostVideo.paused) {
          this.ghostVideo.play().catch(() => {});
        }
        return;
      }

      const mainTime = Number(this.mainVideo.currentTime ?? 0);
      const ghostTime = Number(this.ghostVideo.currentTime ?? 0);
      const lead = ghostTime - mainTime;

      if (lead < CONFIG.ghostMinLeadSeconds) {
        const target = Math.min(
          mainTime + CONFIG.ghostTargetLeadSeconds,
          Math.max(0, (this.ghostVideo.duration || Infinity) - 0.5)
        );

        if (Number.isFinite(target) && target > ghostTime + 1) {
          try {
            this.ghostVideo.currentTime = target;
          } catch {
            // Les flux MSE peuvent refuser certains seeks.
          }
        }
      }

      if (this.ghostVideo.paused) {
        this.ghostVideo.play().catch(() => {
          // Pas d'action bloquante dans la boucle d'analyse.
        });
      }
    }

    consumeDetection(detection) {
      const t = Number(detection.sampleTime ?? 0);
      if (!Number.isFinite(t)) {
        return;
      }

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
      if (gap < CONFIG.noMatchGraceSeconds) {
        return;
      }

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
      this.ghostAnalyzer = null;
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
      this.ghostAnalyzer = new GhostAnalyzer({
        mainVideo: video,
        frameClassifier,
        segmentStore: this.segmentStore
      });
      await this.ghostAnalyzer.start();

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
      if (this.ghostAnalyzer) {
        this.ghostAnalyzer.stop();
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
      this.ghostAnalyzer = null;
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
