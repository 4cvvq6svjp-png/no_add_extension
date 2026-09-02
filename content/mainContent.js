(() => {
  if (window.__NO_ADD_EXTENSION_LOADED__) {
    return;
  }
  window.__NO_ADD_EXTENSION_LOADED__ = true;

  const EXTENSION_TAG = "[NoAddExtension]";
  const OCR_MESSAGE_CHANNEL = "no-add-extension-ocr";

  const CONFIG = {
    frameSampleSeconds: 4,
    minSegmentSeconds: 3,
    // Le texte de disclosure est présent PENDANT TOUTE la pub : une détection
    // signale un état continu « pub en cours ». On fusionne donc agressivement
    // les détections espacées pour couvrir l'intégralité du segment.
    mergeGapSeconds: 20,
    skipMarginSeconds: 0.4,
    skipCooldownMs: 900,
    analysisPollMs: 1200,
    // OCR ciblé : le texte de disclosure (« Publicité »…) est petit et niché
    // dans un coin. On crope SERRÉ chaque coin (petite fraction) et on l'upscale
    // fortement dans une grande cellule → le texte devient assez gros pour que
    // Tesseract le lise de façon fiable sur (presque) chaque frame, en 1 passe.
    // La hauteur du composite est DÉRIVÉE du ratio du crop (voir RoiComposer) :
    // une cellule au ratio libre étirait les glyphes et faisait chuter l'OCR.
    ocrCornerWidthFraction: 0.30,
    ocrCornerHeightFraction: 0.18,
    ocrCompositeWidth: 1600,
    // Binarisation : le texte de disclosure est quasi-blanc. On ne garde que
    // les pixels très clairs (texte) → noir sur blanc, lisible par Tesseract.
    ocrBinarizeThreshold: 190,
    // Commit proactif d'un segment autour de chaque détection (look-ahead) :
    // marge avant + fenêtre en avant, fusionnées au fil des détections.
    segmentStartPadSeconds: 8,
    // Projection AVEUGLE en avant sur une détection. Volontairement courte (~1
    // GOP) : c'est la sonde qui établit la vraie fin de pub. Une valeur large
    // faisait dépasser la fin réelle d'autant sur la dernière frame positive.
    segmentForwardSeconds: 5,
    // Garde-fou anti sur-saut : au-delà de ce saut, la sonde exige 2 lectures
    // OCR positives distinctes avant d'étendre le segment. Pendant une vraie
    // pub le texte est permanent (confirmation immédiate) ; un faux positif
    // isolé ne peut donc pas faire sauter du contenu légitime.
    bigJumpThresholdSeconds: 20,
    probeMinPositivesForBigJump: 2,
    overlayPollMs: 750,
    initTimeoutMs: 20000,

    /* --- Cadences et délais ------------------------------------------ */
    heartbeatMs: 5000,
    noMseDataTimeoutMs: 8000,
    skipPollMs: 220,
    skipDiagnosticThrottleMs: 10000,
    urlWatchPollMs: 900,
    overlayMutationThrottleMs: 150,
    notifierTimeoutMs: 2500,

    /* --- Plafonds et seuils d'abandon --------------------------------- */
    maxCapturedSegments: 30,
    maxMp4AccumBytes: 8_000_000,
    maxConfigureFailures: 3,
    maxTesseractFailures: 5,

    /* --- Timeouts des sandboxes --------------------------------------- */
    decoderReadyTimeoutMs: 15000,
    decoderRequestTimeoutMs: 30000,
    ocrReadyTimeoutMs: 25000,
    ocrInitTimeoutMs: 120000,
    ocrRequestTimeoutMs: 90000
  };

  const MSE_CHANNEL = "no-add-mse-intercept";
  const DECODER_CHANNEL = "no-add-decoder";

  // Chargé juste avant ce script par le manifeste : le réassemblage fMP4 lit
  // les entêtes de boîtes avec le même code que le demuxer de la sandbox.
  const mp4demux = globalThis.__mp4demux;

  function logInfo(message, extra) {
    console.info(EXTENSION_TAG, message, ...(extra === undefined ? [] : [extra]));
  }

  function logWarn(message, extra) {
    console.warn(EXTENSION_TAG, message, ...(extra === undefined ? [] : [extra]));
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

  /**
   * Mots-clés de disclosure, déjà normalisés (comparaison par sous-chaîne).
   * « sponsor » couvre donc « contenu sponsorisé », « vidéo sponsorisée » et
   * « sponsorisé par » — les lister séparément n'ajoutait aucune détection.
   */
  const COMMERCIAL_KEYWORDS = [
    "collaboration commerciale",
    "communication commerciale",
    "partenariat remunere",
    "publicite",
    "sponsor"
  ].map(normalizeText);

  function extractCommercialKeywords(rawText) {
    const normalized = normalizeText(rawText);

    if (!normalized) {
      return [];
    }

    return COMMERCIAL_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  }

  function combineSources(previousSource, nextSource) {
    const labels = new Set();

    for (const source of [previousSource, nextSource]) {
      for (const label of String(source).split("+")) {
        const trimmed = label.trim();
        if (trimmed) {
          labels.add(trimmed);
        }
      }
    }

    return Array.from(labels).join("+");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatError(error) {
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

    show(message, timeoutMs = CONFIG.notifierTimeoutMs) {
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
        if (now - this.lastCheckAt < CONFIG.overlayMutationThrottleMs) {
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

      // Pas de dernier segment émis ici : le seul appelant (teardownSession)
      // vide le store juste après, ce segment était donc toujours perdu.
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

    /**
     * Seul l'overlay de divulgation de YouTube est lu.
     *
     * La liste incluait aussi le titre de la vidéo et le chrome du lecteur,
     * avec repli sur `player.innerText` : un titre — ou l'UI d'une pub YouTube
     * pré-roll — contenant « sponsor » suffisait à ouvrir un faux segment, et
     * surtout à figer `overlayActive`, ce qui empêchait ensuite tout vrai
     * overlay d'en ouvrir un. Le repli forçait en plus un calcul de layout
     * complet du lecteur toutes les 750 ms.
     */
    getCurrentOverlayMatches() {
      const player = document.querySelector("#movie_player");
      if (!player) {
        return [];
      }

      const nodes = player.querySelectorAll(
        ".ytp-paid-content-overlay, .ytp-paid-content-overlay-text"
      );

      const textBlocks = [];
      for (const node of nodes) {
        const text = node.innerText || node.textContent || "";
        if (text) {
          textBlocks.push(text);
        }
      }

      return extractCommercialKeywords(textBlocks.join(" "));
    }
  }

  /**
   * Pont vers une sandbox iframe chrome-extension:// (OCR ou décodeur).
   *
   * Les deux sandboxes parlent le même protocole — création d'une iframe
   * invisible, handshake `sandbox-ready`, puis requêtes corrélées par `reqId`
   * avec timeout. Ce pont était écrit deux fois et les deux copies avaient
   * commencé à diverger ; il n'existe plus qu'ici.
   */
  class SandboxBridge {
    constructor({ channel, pagePath, readyTimeoutMs, requestTimeoutMs }) {
      this.channel = channel;
      this.pagePath = pagePath;
      this.readyTimeoutMs = readyTimeoutMs;
      this.requestTimeoutMs = requestTimeoutMs;
      this.iframe = null;
      this.pendingReady = null;
    }

    isConnected() {
      return Boolean(this.iframe?.contentWindow);
    }

    /** Crée l'iframe si besoin et attend son `sandbox-ready`. Idempotent. */
    async ensureReady() {
      if (this.iframe?.isConnected) {
        return true;
      }
      if (this.pendingReady) {
        return this.pendingReady;
      }

      this.pendingReady = this.createSandbox().finally(() => {
        this.pendingReady = null;
      });

      return this.pendingReady;
    }

    async createSandbox() {
      // L'écoute doit être armée AVANT l'insertion : la sandbox poste son
      // `sandbox-ready` dès qu'elle a chargé.
      const ready = this.waitForReadySignal();

      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-no-add-sandbox", this.channel);
      iframe.src = chrome.runtime.getURL(this.pagePath);
      iframe.style.cssText =
        "position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;";
      (document.documentElement ?? document.body).appendChild(iframe);

      try {
        await ready;
        this.iframe = iframe;
        logInfo(`Sandbox ${this.channel} prête.`);
        return true;
      } catch (error) {
        iframe.remove();
        logWarn(`Sandbox ${this.channel} : échec d'initialisation`, {
          error: formatError(error)
        });
        return false;
      }
    }

    waitForReadySignal() {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        };

        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`${this.channel}: sandbox-ready timeout`));
        }, this.readyTimeoutMs);

        const onMessage = (event) => {
          const data = event.data;
          if (data?.channel !== this.channel || data?.type !== "sandbox-ready") {
            return;
          }
          cleanup();
          resolve();
        };

        window.addEventListener("message", onMessage);
      });
    }

    /** Envoie une requête et résout sur la réponse `<type>-ok` correspondante. */
    async request(type, payload, { transferList = [], timeoutMs } = {}) {
      const sandboxWindow = this.iframe?.contentWindow;
      if (!sandboxWindow) {
        throw new Error(`Sandbox ${this.channel} indisponible`);
      }

      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        };

        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Sandbox timeout (${this.channel}/${type})`));
        }, timeoutMs ?? this.requestTimeoutMs);

        const onMessage = (event) => {
          const data = event.data;
          if (data?.channel !== this.channel || data.reqId !== reqId) {
            return;
          }

          cleanup();

          if (typeof data.type === "string" && data.type.endsWith("-ok")) {
            resolve(data);
          } else {
            reject(new Error(data.error || data.type || `${this.channel}-error`));
          }
        };

        window.addEventListener("message", onMessage);
        sandboxWindow.postMessage(
          { channel: this.channel, type, reqId, ...payload },
          "*",
          transferList
        );
      });
    }

    /** Notifie la sandbox sans attendre de réponse (teardown). */
    postWithoutReply(type) {
      try {
        this.iframe?.contentWindow?.postMessage(
          { channel: this.channel, type, reqId: "teardown" },
          "*"
        );
      } catch {
        // best-effort
      }
    }

    destroy() {
      if (this.iframe) {
        this.iframe.remove();
        this.iframe = null;
      }
      this.pendingReady = null;
    }
  }

  /** Résultat d'analyse sans mot-clé trouvé (ou analyse impossible). */
  function noDetection(sampleTime, source) {
    return {
      sampleTime,
      hasCommercialKeyword: false,
      matchedKeywords: [],
      source
    };
  }

  class FrameClassifier {
    constructor() {
      // Composite 2×2 des 4 coins de la frame, là où le texte de disclosure
      // apparaît. Un seul canvas → un seul appel OCR.
      this.roiCanvas = document.createElement("canvas");
      this.roiCtx = this.roiCanvas.getContext("2d", { willReadFrequently: true });

      this.textDetector = null;
      if ("TextDetector" in window) {
        try {
          this.textDetector = new window.TextDetector();
        } catch (error) {
          logWarn("TextDetector présent mais non initialisable", {
            error: formatError(error)
          });
        }
      }

      if (this.textDetector) {
        this.ocrBackend = "text-detector";
      } else if (chrome?.runtime?.getURL) {
        this.ocrBackend = "tesseract";
      } else {
        this.ocrBackend = null;
      }

      this.tesseractBridge = new SandboxBridge({
        channel: OCR_MESSAGE_CHANNEL,
        pagePath: "pages/ocr-sandbox.html",
        readyTimeoutMs: CONFIG.ocrReadyTimeoutMs,
        requestTimeoutMs: CONFIG.ocrRequestTimeoutMs
      });
      this.tesseractReady = null;

      this.lastOcrError = null;
      this.tesseractErrorCount = 0;
      this.tesseractDisabled = false;
    }

    isAvailable() {
      return Boolean(this.roiCtx && this.ocrBackend);
    }

    getBackendLabel() {
      return this.ocrBackend ?? "none";
    }

    /* ---------------------------------------------------------------- */
    /*  Préparation de l'image envoyée à l'OCR                           */
    /* ---------------------------------------------------------------- */

    /**
     * Compose les 4 coins de la source dans un canvas 2×2, chacun croppé à la
     * résolution NATIVE de la source puis upscalé dans sa cellule.
     *
     * Le texte de disclosure (« Publicité », « collaboration commerciale »…)
     * siège dans un coin et est minuscule à l'échelle de la frame : l'OCR
     * plein cadre ne rend que du bruit.
     *
     * Deux points qui décident de la lisibilité :
     * - on lit la source telle quelle (pas de canvas intermédiaire qui
     *   réduirait la frame avant de la ré-agrandir) ;
     * - la cellule reprend le RATIO du crop, sinon les glyphes sont étirés.
     *
     * @param {ImageBitmap|HTMLVideoElement} source
     * @returns {boolean} false si la source n'a pas encore de dimensions.
     */
    composeCorners(source) {
      const sourceWidth = source.videoWidth || source.width || 0;
      const sourceHeight = source.videoHeight || source.height || 0;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return false;
      }

      const cropWidth = Math.max(1, Math.round(sourceWidth * CONFIG.ocrCornerWidthFraction));
      const cropHeight = Math.max(1, Math.round(sourceHeight * CONFIG.ocrCornerHeightFraction));
      const cellWidth = Math.round(CONFIG.ocrCompositeWidth / 2);
      const cellHeight = Math.max(1, Math.round((cellWidth * cropHeight) / cropWidth));

      if (this.roiCanvas.width !== cellWidth * 2 || this.roiCanvas.height !== cellHeight * 2) {
        this.roiCanvas.width = cellWidth * 2;
        this.roiCanvas.height = cellHeight * 2;
      }

      const ctx = this.roiCtx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, this.roiCanvas.width, this.roiCanvas.height);

      const cropLeft = sourceWidth - cropWidth;
      const cropTop = sourceHeight - cropHeight;

      // src (coin de la frame) → dst (cellule de la grille), upscalé.
      ctx.drawImage(source, 0,        0,       cropWidth, cropHeight, 0,         0,          cellWidth, cellHeight);
      ctx.drawImage(source, cropLeft, 0,       cropWidth, cropHeight, cellWidth, 0,          cellWidth, cellHeight);
      ctx.drawImage(source, 0,        cropTop, cropWidth, cropHeight, 0,         cellHeight, cellWidth, cellHeight);
      ctx.drawImage(source, cropLeft, cropTop, cropWidth, cropHeight, cellWidth, cellHeight, cellWidth, cellHeight);

      this.binarize();
      return true;
    }

    /**
     * Ne garder que les pixels quasi-blancs (le texte) → noir sur fond blanc.
     * Isole la disclosure fine du bruit de l'image.
     */
    binarize() {
      const image = this.roiCtx.getImageData(0, 0, this.roiCanvas.width, this.roiCanvas.height);
      const pixels = image.data;
      const threshold = CONFIG.ocrBinarizeThreshold;

      for (let i = 0; i < pixels.length; i += 4) {
        const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        const value = luminance >= threshold ? 0 : 255;
        pixels[i] = value;
        pixels[i + 1] = value;
        pixels[i + 2] = value;
      }

      this.roiCtx.putImageData(image, 0, 0);
    }

    /* ---------------------------------------------------------------- */
    /*  Analyse                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * Analyse une frame, qu'elle vienne du décodeur (ImageBitmap) ou du
     * lecteur principal (<video>) — `drawImage` accepte les deux.
     */
    async detect(source, sampleTime) {
      if (!this.isAvailable()) {
        return noDetection(sampleTime, "ocr-unavailable");
      }

      try {
        if (!this.composeCorners(source)) {
          return noDetection(sampleTime, "source-not-ready");
        }
      } catch (error) {
        this.logOcrErrorOnce("Impossible de composer la ROI OCR", error);
        return noDetection(sampleTime, "roi-draw-error");
      }

      if (this.ocrBackend === "text-detector") {
        return this.detectWithTextDetector(sampleTime);
      }

      return this.detectWithTesseract(sampleTime);
    }

    async detectWithTextDetector(sampleTime) {
      try {
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
        this.logOcrErrorOnce("Impossible d'analyser une frame pour OCR (TextDetector)", error);
        return noDetection(sampleTime, "text-detector-error");
      }
    }

    async detectWithTesseract(sampleTime) {
      if (this.tesseractDisabled) {
        return noDetection(sampleTime, "tesseract-disabled");
      }

      const ready = await this.ensureTesseractReady();
      if (!ready) {
        return noDetection(sampleTime, "tesseract-unavailable");
      }

      let bitmap = null;

      try {
        bitmap = await createImageBitmap(this.roiCanvas);
        const result = await this.tesseractBridge.request(
          "recognize",
          { imageBitmap: bitmap },
          { transferList: [bitmap] }
        );
        bitmap = null;

        this.tesseractErrorCount = 0;

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
          try { bitmap.close(); } catch { /* ignore */ }
        }
        return this.onTesseractFailure(sampleTime, error);
      }
    }

    onTesseractFailure(sampleTime, error) {
      this.tesseractErrorCount += 1;
      const detail = formatError(error);

      // Les 3 premières erreurs sont loguées telles quelles pour ne jamais
      // manquer le vrai mode de défaillance ; ensuite on déduplique.
      if (this.tesseractErrorCount <= 3 || this.lastOcrError !== detail) {
        this.lastOcrError = detail;
        logWarn("Impossible d'analyser une frame pour OCR (Tesseract)", {
          attempt: this.tesseractErrorCount,
          error: detail
        });
      }

      if (this.tesseractErrorCount >= CONFIG.maxTesseractFailures && !this.tesseractDisabled) {
        this.tesseractDisabled = true;
        logWarn(
          `Tesseract désactivé après ${CONFIG.maxTesseractFailures} échecs consécutifs — ` +
          "OCR via WebCodecs neutralisé, seule la détection DOM reste active."
        );
      }

      return noDetection(sampleTime, "tesseract-error");
    }

    logOcrErrorOnce(message, error) {
      const detail = formatError(error);
      if (this.lastOcrError === detail) {
        return;
      }
      this.lastOcrError = detail;
      logWarn(message, { error: detail });
    }

    /* ---------------------------------------------------------------- */
    /*  Cycle de vie de la sandbox Tesseract                             */
    /* ---------------------------------------------------------------- */

    async ensureTesseractReady() {
      if (this.ocrBackend !== "tesseract") {
        return false;
      }
      if (this.tesseractReady) {
        return this.tesseractReady;
      }

      this.tesseractReady = (async () => {
        const connected = await this.tesseractBridge.ensureReady();
        if (!connected) {
          return false;
        }
        await this.tesseractBridge.request("init", {}, { timeoutMs: CONFIG.ocrInitTimeoutMs });
        logInfo("Tesseract prêt (sandbox iframe chrome-extension://).");
        return true;
      })().catch((error) => {
        logWarn("Échec d’initialisation Tesseract (iframe)", {
          error: formatError(error)
        });
        this.tesseractReady = null;
        this.tesseractBridge.destroy();
        return false;
      });

      return this.tesseractReady;
    }

    async terminate() {
      if (this.ocrBackend === "tesseract" && this.tesseractBridge.isConnected()) {
        try {
          await this.tesseractBridge.request("terminate", {});
        } catch {
          // best-effort
        }
      }

      this.tesseractBridge.destroy();
      this.tesseractReady = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  AheadScanner — MSE interception + WebCodecs decoder                */
  /*  On intercepte les segments fMP4 bruts que YouTube pousse dans MSE, */
  /*  on décode les keyframes via WebCodecs dans une iframe sandbox, et  */
  /*  on OCRise les bitmaps obtenues — sans second lecteur vidéo.        */
  /* ------------------------------------------------------------------ */

  class AheadScanner {
    constructor({ mainVideo, frameClassifier, segmentStore }) {
      this.mainVideo = mainVideo;
      this.frameClassifier = frameClassifier;
      this.segmentStore = segmentStore;

      this.ocrSourceTag = "ahead-ocr";

      // Captured MSE data
      this.initSegment = null;
      this.initSegmentContainer = "mp4";
      this.initSegmentMime = "";
      this.capturedSegments = []; // [{ data, timestampOffset, seq, scanned }]
      // Identifiant monotone par segment capturé : evictOldSegments décale les
      // indices du tableau, la sonde raisonne donc sur des seq stables.
      this.segmentSeq = 0;
      // Réassemblage fMP4 : YouTube peut découper un moof+mdat sur plusieurs
      // appendBuffer(), on ne met en file que des unités complètes.
      this.mp4Accum = null;
      this.mp4AccumTsOffset = null;

      // Decoder sandbox
      this.decoderBridge = new SandboxBridge({
        channel: DECODER_CHANNEL,
        pagePath: "pages/decoder-sandbox.html",
        readyTimeoutMs: CONFIG.decoderReadyTimeoutMs,
        requestTimeoutMs: CONFIG.decoderRequestTimeoutMs
      });
      this.decoderConfigured = false;

      // Scanning state
      this.lastScannedTime = -Infinity;
      // Ré-entrance du seul chemin qui en a besoin : le repli est piloté par un
      // setInterval, la boucle de scan MSE est séquentielle par construction.
      this.fallbackBusy = false;
      this.scanLoopStopped = true;
      this.scanLoopRunning = false;
      this.fallbackTimeout = null;
      this.fallbackInterval = null;
      this.useFallback = false;

      // Sonde de fin de pub : une fois une pub détectée, on cesse le balayage
      // séquentiel pour aller localiser sa FIN au bord du buffer, puis on
      // bissecte. null = mode séquentiel.
      this.probeState = null;

      // Track failed configure attempts per init segment to avoid log spam
      // when the codec is genuinely unsupported by the platform (e.g. no AV1).
      this.configureFailures = 0;
      this.configureFailedInit = null;

      // Diagnostic counters
      this.totalMediaSegmentsReceived = 0;
      this.totalScans = 0;
      this.totalFramesDecoded = 0;
      this.totalOcrMatches = 0;
      this.heartbeatInterval = null;

      // Bound listener
      this.boundOnMseMessage = (event) => this.onMseMessage(event);
    }

    async start() {
      if (!this.frameClassifier.isAvailable()) {
        logWarn("Aucun moteur OCR disponible, AheadScanner désactivé.");
        return;
      }

      if (!mp4demux) {
        logWarn("mp4demux non chargé — le réassemblage fMP4 est indisponible.");
      }

      logInfo("AheadScanner démarré", {
        backend: this.frameClassifier.getBackendLabel()
      });

      // Listen for MSE intercepted data from MAIN world
      window.addEventListener("message", this.boundOnMseMessage);

      // Request any segments already captured before we were ready (timing gap)
      window.postMessage({ channel: MSE_CHANNEL, type: "request-replay" }, "*");

      // Boucle de scan continue : les scans s'enchaînent dos à dos tant qu'il
      // reste du backlog. On n'attend `analysisPollMs` que lorsqu'il n'y a rien
      // à faire — c'est un intervalle d'INACTIVITÉ, pas un plafond de débit
      // (un setInterval quantisait le cycle à 2 ticks, soit la moitié du débit
      // perdue en attente alors que ~25s de contenu attendaient en file).
      this.startScanLoop();

      // Fallback: if no MSE data arrives within 8s, fall back to main video OCR
      this.fallbackTimeout = window.setTimeout(() => {
        if (!this.initSegment) {
          logWarn("Aucun segment MSE reçu — repli OCR sur la vidéo principale.");
          this.useFallback = true;
          this.ocrSourceTag = "main-video-ocr";
          this.startFallbackPolling();
        }
      }, CONFIG.noMseDataTimeoutMs);

      // Diagnostic heartbeat: snapshot of pipeline state every 5s.
      this.heartbeatInterval = window.setInterval(() => this.logHeartbeat(), CONFIG.heartbeatMs);
    }

    /** (Re)démarre la boucle de scan ; sans effet si elle tourne déjà. */
    startScanLoop() {
      this.scanLoopStopped = false;
      void this.runScanLoop();
    }

    async runScanLoop() {
      if (this.scanLoopRunning) return; // jamais deux boucles sur une instance
      this.scanLoopRunning = true;

      try {
        while (!this.scanLoopStopped) {
          let didWork = false;

          try {
            didWork = await this.scanNext();
          } catch (error) {
            logWarn("AheadScanner: boucle de scan interrompue", {
              error: formatError(error)
            });
          }

          if (!didWork) {
            await sleep(CONFIG.analysisPollMs);
          }
        }
      } finally {
        this.scanLoopRunning = false;
      }
    }

    logHeartbeat() {
      const unscanned = this.capturedSegments.filter((e) => !e.scanned).length;
      const currentTime = Number(this.mainVideo?.currentTime ?? 0);
      const buffered = this.mainVideo?.buffered;
      let bufferedAhead = 0;
      if (buffered && buffered.length > 0) {
        for (let i = 0; i < buffered.length; i++) {
          if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
            bufferedAhead = buffered.end(i) - currentTime;
            break;
          }
        }
      }
      logInfo("AheadScanner heartbeat", {
        currentTime: currentTime.toFixed(1),
        bufferedAhead: bufferedAhead.toFixed(1) + "s",
        decoderConfigured: this.decoderConfigured,
        useFallback: this.useFallback,
        capturedSegments: `${this.capturedSegments.length} (${unscanned} non scannés)`,
        mediaSegmentsReceived: this.totalMediaSegmentsReceived,
        scansRun: this.totalScans,
        framesDecoded: this.totalFramesDecoded,
        ocrMatches: this.totalOcrMatches,
        ocrBackend: this.frameClassifier?.getBackendLabel?.() ?? "?",
        tesseractErrors: this.frameClassifier?.tesseractErrorCount ?? 0,
        tesseractDisabled: this.frameClassifier?.tesseractDisabled ?? false,
        storeSize: this.segmentStore?.segments?.length ?? 0,
        lastScannedTime: Number.isFinite(this.lastScannedTime) ? this.lastScannedTime.toFixed(1) : "-",
        mode: this.probeState ? "sonde" : "séquentiel",
        probe: this.probeState
          ? `[${this.probeState.lastPositiveTime.toFixed(1)}..${
              Number.isFinite(this.probeState.firstNegativeTime)
                ? this.probeState.firstNegativeTime.toFixed(1)
                : "?"
            }] ${this.probeState.probes} sonde(s), ${this.probeState.positiveCount} positif(s)`
          : "-"
      });
    }

    stop() {
      window.removeEventListener("message", this.boundOnMseMessage);

      this.scanLoopStopped = true;

      if (this.fallbackTimeout !== null) {
        window.clearTimeout(this.fallbackTimeout);
        this.fallbackTimeout = null;
      }

      if (this.fallbackInterval !== null) {
        window.clearInterval(this.fallbackInterval);
        this.fallbackInterval = null;
      }

      if (this.heartbeatInterval !== null) {
        window.clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      this.lastScannedTime = -Infinity;
      this.fallbackBusy = false;
      this.probeState = null;
      this.initSegment = null;
      this.capturedSegments = [];

      this.decoderBridge.postWithoutReply("terminate");
      this.decoderBridge.destroy();
      this.decoderConfigured = false;
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
        this.mp4Accum = null;
        this.lastScannedTime = -Infinity;
        this.probeState = null;
        this.decoderConfigured = false;
        logInfo("AheadScanner: nouveau MediaSource détecté, reset.");
        return;
      }

      if (msg.type === "init-segment") {
        // Cancel fallback timeout — we have MSE data
        if (this.fallbackTimeout !== null) {
          window.clearTimeout(this.fallbackTimeout);
          this.fallbackTimeout = null;
        }

        logInfo("AheadScanner: init segment capturé", {
          bytes: msg.data?.byteLength,
          mime: msg.mime,
          container: msg.container
        });

        this.initSegment = msg.data;
        this.initSegmentContainer = msg.container || "mp4";
        this.initSegmentMime = msg.mime || "";
        this.mp4Accum = null;
        this.decoderConfigured = false;
        this.useFallback = false;
        this.configureFailures = 0;
        this.configureFailedInit = null;

        if (this.fallbackInterval !== null) {
          window.clearInterval(this.fallbackInterval);
          this.fallbackInterval = null;
        }

        this.ocrSourceTag = "ahead-ocr";
        // Le repli avait pu arrêter la boucle de scan : on la relance.
        this.startScanLoop();
        return;
      }

      if (msg.type === "media-segment") {
        if (!this.initSegment) return; // Ignore media without init

        this.totalMediaSegmentsReceived += 1;

        const isWebm = (this.initSegmentContainer ?? "mp4") === "webm";
        if (isWebm) {
          // WebM: the cluster parser flat-scans, so a per-append push is fine.
          this.capturedSegments.push({
            data: msg.data,
            timestampOffset: msg.timestampOffset ?? 0,
            seq: this.segmentSeq++
          });
        } else {
          // fMP4: YouTube may split one media segment (moof+mdat) across several
          // appendBuffer() calls. Reassemble the byte stream and only enqueue
          // COMPLETE moof+mdat units, otherwise parseMediaSegment sees a
          // truncated mdat and returns 0 samples.
          this.accumulateMp4Chunk(msg.data, msg.timestampOffset ?? 0);
        }

        // Plafond en NOMBRE de segments, pas en retard temporel.
        this.evictOldSegments();
        return;
      }
    }

    /**
     * Append a raw appendBuffer() chunk to the fMP4 reassembly buffer and
     * extract every complete moof+mdat unit into capturedSegments.
     */
    accumulateMp4Chunk(chunkBuffer, timestampOffset) {
      const incoming = new Uint8Array(chunkBuffer);

      // A timestampOffset change signals a discontinuity (e.g. a seek): drop any
      // dangling partial bytes so we don't merge across timelines.
      if (this.mp4Accum && this.mp4Accum.length > 0 &&
          this.mp4AccumTsOffset !== timestampOffset) {
        this.mp4Accum = null;
      }
      this.mp4AccumTsOffset = timestampOffset;

      if (!this.mp4Accum || this.mp4Accum.length === 0) {
        this.mp4Accum = incoming.slice(); // own copy (starts at a box boundary)
      } else {
        const merged = new Uint8Array(this.mp4Accum.length + incoming.length);
        merged.set(this.mp4Accum, 0);
        merged.set(incoming, this.mp4Accum.length);
        this.mp4Accum = merged;
      }

      this.extractMp4Segments(timestampOffset);
    }

    /**
     * Parcourt le tampon de réassemblage et met en file les unités moof+mdat
     * complètes.
     *
     * La politique de fin diffère de celle du demuxer : ici une boîte
     * incomplète signifie « attendre la suite », pas « flux malformé ». D'où
     * l'usage direct de readBoxHeader plutôt que d'iterateBoxes.
     */
    extractMp4Segments(timestampOffset) {
      const bytes = this.mp4Accum;
      let pos = 0;
      let unitStart = 0;
      let sawMoof = false;

      while (pos < bytes.length) {
        const header = mp4demux.readBoxHeader(bytes, pos);
        if (!header) break;                       // entête tronqué — attendre
        if (header.extendsToEnd) break;           // non délimitable — attendre
        if (header.size < header.headerSize) break; // corrompu — on garde le reste
        if (pos + header.size > bytes.length) break; // boîte incomplète — attendre

        if (header.type === "moof") {
          sawMoof = true;
        } else if (header.type === "mdat" && sawMoof) {
          const unit = bytes.slice(unitStart, pos + header.size); // copie propre
          this.capturedSegments.push({
            data: unit.buffer,
            timestampOffset,
            seq: this.segmentSeq++
          });
          unitStart = pos + header.size;
          sawMoof = false;
        }

        pos += header.size;
      }

      // Keep only the unconsumed tail for the next chunk.
      this.mp4Accum = unitStart > 0 ? bytes.slice(unitStart) : bytes;
      // Safety valve: never let the buffer grow unbounded on persistent misalign.
      if (this.mp4Accum.length > CONFIG.maxMp4AccumBytes) this.mp4Accum = new Uint8Array(0);
    }

    evictOldSegments() {
      const maxSegments = CONFIG.maxCapturedSegments;
      if (this.capturedSegments.length > maxSegments) {
        this.capturedSegments = this.capturedSegments.slice(-maxSegments);
      }
    }

    async ensureDecoderConfigured() {
      if (this.decoderConfigured) return true;
      if (!this.initSegment) return false;
      // Stop hammering configure when this exact init has already failed too
      // many times (typically: the platform genuinely lacks a decoder for the
      // codec advertised by YouTube).
      if (this.configureFailedInit === this.initSegment) return false;

      const connected = await this.decoderBridge.ensureReady();
      if (!connected) return false;

      // Snapshot init metadata; a new init-segment can arrive during the await
      // (quality switch, ad insertion) and we must not mark the decoder as
      // configured for stale bytes.
      const initSnapshot = this.initSegment;
      const containerSnapshot = this.initSegmentContainer;
      const mimeSnapshot = this.initSegmentMime;

      try {
        const initCopy = initSnapshot.slice(0);
        const fallbackWidth  = this.mainVideo?.videoWidth  || 0;
        const fallbackHeight = this.mainVideo?.videoHeight || 0;
        await this.decoderBridge.request("configure", {
          initSegment: initCopy,
          container: containerSnapshot,
          mime: mimeSnapshot,
          fallbackWidth,
          fallbackHeight
        }, { transferList: [initCopy] });

        if (this.initSegment !== initSnapshot) {
          // A newer init arrived during configure — leave decoderConfigured
          // false so the next scanNext re-runs configure with the fresh data.
          return false;
        }

        this.decoderConfigured = true;
        this.configureFailures = 0;
        logInfo("AheadScanner: decoder configuré.");
        return true;
      } catch (error) {
        this.configureFailures += 1;
        logWarn("AheadScanner: échec configuration decoder", {
          attempt: this.configureFailures,
          error: formatError(error)
        });

        if (this.configureFailures >= CONFIG.maxConfigureFailures &&
            this.initSegment === initSnapshot) {
          // Platform can't decode this codec — stop retrying and let the DOM
          // overlay detector + main-video OCR fallback take over.
          this.configureFailedInit = initSnapshot;
          this.useFallback = true;
          this.ocrSourceTag = "main-video-ocr";
          this.startFallbackPolling();
          logWarn(
            `AheadScanner: codec non supporté après ${CONFIG.maxConfigureFailures} tentatives, ` +
            "bascule en fallback OCR vidéo."
          );
        }
        return false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Scanning logic                                                   */
    /* ---------------------------------------------------------------- */

    async scanNext() {
      if (this.useFallback) return false; // Handled by fallback polling
      if (!this.initSegment || this.capturedSegments.length === 0) return false;

      try {
        const configured = await this.ensureDecoderConfigured();
        if (!configured) return false;

        // Hors sonde : balayage séquentiel (plus ancien segment non scanné).
        // En sonde : on vise le bord du buffer, puis on bissecte.
        const probing = this.probeState !== null;
        const segmentEntry = probing
          ? this.pickProbeSegment()
          : this.capturedSegments.find((entry) => !entry.scanned);
        if (!segmentEntry) return false;

        segmentEntry.scanned = true;
        this.totalScans += 1;
        if (probing) this.probeState.probes += 1;

        // En sonde on vise une keyframe PRÉCISE, en avance sur tout ce qui a été
        // scanné : le filtre minTime l'écarterait.
        const minTime = probing
          ? -Infinity
          : this.lastScannedTime + CONFIG.frameSampleSeconds;
        // La sandbox décodeur fait le démuxage ET le décodage des keyframes :
        // le buffer y est TRANSFÉRÉ (zéro copie, mais neutré ici).
        const result = await this.decoderBridge.request("scan-segment", {
          mediaSegment: segmentEntry.data,
          minTime,
          sampleInterval: CONFIG.frameSampleSeconds
        }, { transferList: [segmentEntry.data] });

        const frameCount = result.frames?.length ?? 0;
        this.totalFramesDecoded += frameCount;
        if (frameCount === 0) {
          // Sans keyframe décodée, ce segment n'apprend rien à la sonde ; on le
          // laisse marqué scanné pour que la bissection passe au suivant.
          logInfo("AheadScanner: scan-segment OK mais aucune keyframe utile", {
            minTime: Number.isFinite(minTime) ? minTime.toFixed(1) : "-",
            tsRange: result.tsRange
              ? `${result.tsRange.start.toFixed(1)}..${result.tsRange.end.toFixed(1)}`
              : "-",
            bufferBytes: segmentEntry.data?.byteLength ?? 0
          });
          return true;
        }

        for (const frame of result.frames) {
          if (!frame.imageBitmap) continue;

          try {
            const detection = await this.frameClassifier.detect(
              frame.imageBitmap,
              frame.timestamp
            );

            try { frame.imageBitmap.close(); } catch { /* ignore */ }

            if (probing) {
              this.consumeProbeResult(segmentEntry, frame.timestamp, detection);
            } else {
              this.consumeDetection(detection, segmentEntry);
              this.lastScannedTime = frame.timestamp;
            }
            if (detection.hasCommercialKeyword) this.totalOcrMatches += 1;

            logInfo("AheadScanner: frame analysée", {
              time: frame.timestamp.toFixed(1),
              mode: probing ? "sonde" : "séquentiel",
              keyword: detection.hasCommercialKeyword,
              matched: detection.matchedKeywords,
              ocrSource: detection.source,
              textPreview: (detection.extractedText ?? "").slice(0, 80),
              lead: (frame.timestamp - this.mainVideo.currentTime).toFixed(1) + "s en avance"
            });
          } catch (error) {
            try { frame.imageBitmap.close(); } catch { /* ignore */ }
            logWarn("AheadScanner: échec OCR sur frame décodée", {
              time: frame.timestamp,
              error: formatError(error)
            });
          }
        }

        return true;
      } catch (error) {
        logWarn("AheadScanner: échec scan-segment", {
          error: formatError(error)
        });
        return false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Sonde de fin de pub                                              */
    /* ---------------------------------------------------------------- */

    indexOfSeq(seq) {
      if (seq === null || seq === undefined) return -1;
      return this.capturedSegments.findIndex((entry) => entry.seq === seq);
    }

    /**
     * Choisit le prochain segment à sonder. Tant qu'aucun négatif n'est connu on
     * vise la FRONTIÈRE (le segment le plus avancé du buffer, ~40s devant) ;
     * dès qu'une borne haute existe on bissecte entre elle et le dernier positif.
     * Renvoie null quand il n'y a rien de neuf à sonder (buffer pas encore
     * étendu) ou quand la fin est déjà encadrée.
     */
    pickProbeSegment() {
      const segments = this.capturedSegments;
      const state = this.probeState;
      const positiveIndex = Math.max(0, this.indexOfSeq(state.lastPositiveSeq));
      const confirmedIndex = state.firstNegativeSeq === null
        ? -1
        : this.indexOfSeq(state.firstNegativeSeq);
      const pendingIndex = state.pendingNegativeSeq === null
        ? -1
        : this.indexOfSeq(state.pendingNegativeSeq);

      // Un candidat non encore confirmé sert quand même de borne haute
      // PROVISOIRE : bissecter dessous est toujours plus informatif qu'attendre
      // sa confirmation (ça resserre la fin, et ça peut le disqualifier).
      const boundIndex = confirmedIndex >= 0 ? confirmedIndex : pendingIndex;

      if (boundIndex < 0) {
        // Frontière : le segment le plus avancé du buffer.
        for (let i = segments.length - 1; i > positiveIndex; i--) {
          if (!segments[i].scanned) return segments[i];
        }
        return null;
      }

      // Bissection : viser le milieu, mais accepter le plus proche voisin non
      // scanné — l'intervalle peut déjà contenir des segments traités.
      const middle = Math.floor((positiveIndex + boundIndex) / 2);
      for (let i = middle; i > positiveIndex; i--) {
        if (!segments[i].scanned) return segments[i];
      }
      for (let i = middle + 1; i < boundIndex; i++) {
        if (!segments[i].scanned) return segments[i];
      }

      // Intervalle épuisé. Si la borne n'est que candidate, la trancher via son
      // successeur immédiat : c'est ce qui distingue « fin de pub » d'une frame
      // ratée par l'OCR.
      if (confirmedIndex < 0 && pendingIndex >= 0) {
        for (let i = pendingIndex + 1; i < segments.length; i++) {
          if (!segments[i].scanned) return segments[i];
        }
        return null; // buffer pas encore étendu au-delà du candidat
      }

      // Fin encadrée au mieux.
      this.maybeResolveProbe();
      return null;
    }

    hasUnscannedBetween(lowIndex, highIndex) {
      for (let i = lowIndex + 1; i < highIndex; i++) {
        if (!this.capturedSegments[i].scanned) return true;
      }
      return false;
    }

    consumeProbeResult(entry, time, detection) {
      const state = this.probeState;
      if (!state || !Number.isFinite(time)) return;

      if (detection.hasCommercialKeyword) {
        if (time > state.lastPositiveTime) {
          state.lastPositiveSeq = entry.seq;
          state.lastPositiveTime = time;
        }
        state.positiveCount += 1;
        this.invalidateNegativeBoundsBefore(time);
        this.extendAdEnd(time);
      } else if (time > state.lastPositiveTime) {
        // Symétrique du garde-fou anti sur-saut. L'OCR rate ~1 frame sur 11 sur
        // la vidéo de référence : un négatif ISOLÉ ne borne donc pas la pub.
        // La confirmation doit être POSITIONNELLE — deux segments CONSÉCUTIFS
        // négatifs. Deux négatifs quelconques ne suffisent pas : sur une pub
        // longue, des faux négatifs épars finissent par se confirmer entre eux
        // alors qu'un positif les sépare.
        const index = this.indexOfSeq(entry.seq);
        const pendingIndex = state.pendingNegativeSeq === null
          ? -1
          : this.indexOfSeq(state.pendingNegativeSeq);

        if (pendingIndex >= 0 && index === pendingIndex + 1) {
          state.firstNegativeSeq = state.pendingNegativeSeq;
          state.firstNegativeTime = state.pendingNegativeTime;
          logInfo("Sonde: fin confirmée par 2 négatifs consécutifs", {
            time: state.pendingNegativeTime.toFixed(1)
          });
        } else if (pendingIndex < 0 || time < state.pendingNegativeTime) {
          state.pendingNegativeSeq = entry.seq;
          state.pendingNegativeTime = time;
          logInfo("Sonde: négatif candidat, confirmation requise", {
            time: time.toFixed(1)
          });
        }
      }

      this.maybeResolveProbe();
    }

    /**
     * Un positif POSTÉRIEUR à une borne négative la disqualifie : c'était un
     * faux négatif OCR, la pub continue au-delà.
     */
    invalidateNegativeBoundsBefore(time) {
      const state = this.probeState;

      if (state.pendingNegativeSeq !== null && state.pendingNegativeTime <= time) {
        logInfo("Sonde: négatif candidat invalidé par un positif postérieur", {
          negatif: state.pendingNegativeTime.toFixed(1),
          positif: time.toFixed(1)
        });
        state.pendingNegativeSeq = null;
        state.pendingNegativeTime = Infinity;
      }

      if (state.firstNegativeSeq !== null && state.firstNegativeTime <= time) {
        state.firstNegativeSeq = null;
        state.firstNegativeTime = Infinity;
      }
    }

    /**
     * Étend la fin du segment stocké jusqu'à un point vérifié « encore pub ».
     * Le garde-fou anti sur-saut vit ici (et non dans SkipController, qui saute
     * simplement à segment.end) : un grand saut exige 2 lectures positives.
     */
    extendAdEnd(endTime) {
      const state = this.probeState;
      const currentTime = Number(this.mainVideo?.currentTime ?? 0);
      const jump = endTime - currentTime;

      if (jump > CONFIG.bigJumpThresholdSeconds &&
          state.positiveCount < CONFIG.probeMinPositivesForBigJump) {
        logInfo("Sonde: extension retenue, confirmation requise", {
          end: endTime.toFixed(1),
          jump: jump.toFixed(1) + "s",
          positiveCount: state.positiveCount
        });
        return;
      }

      const added = this.segmentStore.addSegment({
        start: Math.max(0, state.startTime - CONFIG.segmentStartPadSeconds),
        end: endTime,
        source: this.ocrSourceTag,
        confidence: 0.85
      });

      if (added) {
        logInfo("Sonde: fin de pub étendue", {
          end: endTime.toFixed(1),
          jump: jump.toFixed(1) + "s",
          positiveCount: state.positiveCount
        });
      }
    }

    /**
     * La fin est localisée dès que le dernier positif et le premier négatif sont
     * des segments adjacents (~5s de granularité, imposée par le GOP).
     */
    maybeResolveProbe() {
      const state = this.probeState;
      if (!state || state.firstNegativeSeq === null) return;

      const positiveIndex = this.indexOfSeq(state.lastPositiveSeq);
      const negativeIndex = this.indexOfSeq(state.firstNegativeSeq);
      if (positiveIndex < 0 || negativeIndex < 0) return;
      // Encadré soit par adjacence, soit parce qu'il ne reste rien à sonder
      // entre les deux bornes.
      if (negativeIndex - positiveIndex > 1 &&
          this.hasUnscannedBetween(positiveIndex, negativeIndex)) {
        return;
      }

      // Borne haute confirmée par une lecture NÉGATIVE : pas de garde-fou ici,
      // la bissection est intrinsèquement bornée par le premier négatif.
      this.segmentStore.addSegment({
        start: Math.max(0, state.startTime - CONFIG.segmentStartPadSeconds),
        end: state.firstNegativeTime,
        source: this.ocrSourceTag,
        confidence: 0.9
      });

      // L'intérieur de la pub n'apprend plus rien : inutile de le rescanner.
      for (let i = positiveIndex; i < negativeIndex; i++) {
        this.capturedSegments[i].scanned = true;
      }
      this.lastScannedTime = state.firstNegativeTime;

      logInfo("Sonde: fin de pub localisée", {
        start: state.startTime.toFixed(1),
        end: state.firstNegativeTime.toFixed(1),
        sondes: state.probes
      });

      this.probeState = null;
    }

    /* ---------------------------------------------------------------- */
    /*  Fallback: OCR on main video (no MSE data available)              */
    /* ---------------------------------------------------------------- */

    startFallbackPolling() {
      if (this.fallbackInterval !== null) return;

      // Le repli remplace le scan MSE : sans cet arrêt, la boucle continuait de
      // se réveiller toutes les analysisPollMs pour ressortir aussitôt.
      this.scanLoopStopped = true;

      this.fallbackInterval = window.setInterval(
        () => void this.fallbackTick(),
        CONFIG.analysisPollMs
      );
    }

    async fallbackTick() {
      if (this.fallbackBusy) return;

      const video = this.mainVideo;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      const sampleTime = Number(video.currentTime ?? 0);
      if (sampleTime - this.lastScannedTime < CONFIG.frameSampleSeconds) return;

      this.fallbackBusy = true;
      try {
        this.lastScannedTime = sampleTime;
        const detection = await this.frameClassifier.detect(video, sampleTime);
        this.consumeDetection(detection);
      } finally {
        this.fallbackBusy = false;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Detection accumulation (same logic as old GhostAnalyzer)         */
    /* ---------------------------------------------------------------- */

    consumeDetection(detection, segmentEntry = null) {
      const t = Number(detection.sampleTime ?? 0);
      if (!Number.isFinite(t)) return;

      // Seules les détections positives comptent. Commit PROACTIF : dès qu'un
      // mot-clé commercial est vu (souvent en avance via le look-ahead), on
      // insère immédiatement un segment [t-marge, t+fenêtre]. Les détections
      // successives se fusionnent (mergeGapSeconds) en un segment qui couvre
      // toute la pub, et le SkipController peut couper dès le DÉBUT — sans
      // attendre la fin + une période de grâce comme auparavant.
      if (!detection.hasCommercialKeyword) return;

      const start = Math.max(0, t - CONFIG.segmentStartPadSeconds);
      const end = t + CONFIG.segmentForwardSeconds;

      const added = this.segmentStore.addSegment({
        start,
        end,
        source: this.ocrSourceTag,
        confidence: 0.75
      });

      if (added) {
        logInfo("Segment OCR ajouté/étendu", { start, end, source: this.ocrSourceTag });
      }

      // Arme la sonde : à partir d'ici, cesser de balayer la pub segment par
      // segment (13 analyses pour 68s) et aller localiser sa FIN au bord du
      // buffer (~5-6 analyses). Sans segment capturé (mode fallback vidéo), il
      // n'y a rien à sonder : on reste en séquentiel.
      if (!this.probeState && segmentEntry && !this.useFallback) {
        this.probeState = {
          startTime: t,
          lastPositiveSeq: segmentEntry.seq,
          lastPositiveTime: t,
          firstNegativeSeq: null,
          firstNegativeTime: Infinity,
          pendingNegativeSeq: null,
          pendingNegativeTime: Infinity,
          positiveCount: 1,
          probes: 0
        };
        logInfo("Sonde armée", { start: t.toFixed(1) });
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
      this.lastDiagnosticLogAt = 0;
      this.boundTick = () => this.tick();
    }

    start() {
      this.video.addEventListener("timeupdate", this.boundTick);
      this.video.addEventListener("seeked", this.boundTick);
      this.interval = window.setInterval(this.boundTick, CONFIG.skipPollMs);
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
        // Throttled diagnostic: if we have stored segments but none match the
        // current time, log the gap once every 10s so we can tell whether
        // detections are ahead/behind playback or simply miss the range.
        const store = this.segmentStore.segments;
        if (store && store.length > 0 &&
            nowMs - this.lastDiagnosticLogAt > CONFIG.skipDiagnosticThrottleMs) {
          this.lastDiagnosticLogAt = nowMs;
          const summary = store.slice(0, 3).map((s) =>
            `[${s.start.toFixed(1)}..${s.end.toFixed(1)} ${s.source}]`
          ).join(" ");
          logInfo("SkipController: aucun segment ne couvre currentTime", {
            currentTime: currentTime.toFixed(1),
            storeSize: store.length,
            firstSegments: summary
          });
        }
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
      }, CONFIG.urlWatchPollMs);
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
  }

  const controller = new NoAddYouTubeController();
  controller.start();
})();
