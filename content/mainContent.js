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

  /* ------------------------------------------------------------------ */
  /*  RoiComposer — l'image envoyée à l'OCR                              */
  /* ------------------------------------------------------------------ */

  /**
   * Compose l'image soumise à l'OCR : les 4 coins de la frame, cropés à la
   * résolution NATIVE de la source, upscalés dans une grille 2×2, puis
   * binarisés.
   *
   * Le texte de disclosure (« Publicité », « collaboration commerciale »…)
   * siège dans un coin et est minuscule à l'échelle de la frame : l'OCR plein
   * cadre ne rend que du bruit. Un seul canvas → un seul appel OCR.
   *
   * Deux points décident de la lisibilité, et donc de tout le taux de
   * détection :
   * - la source est lue telle quelle, sans canvas intermédiaire qui réduirait
   *   la frame avant de la ré-agrandir ;
   * - la cellule reprend le RATIO du crop. Une cellule au ratio libre étirait
   *   les glyphes de 66 % en vertical, ce qui fait chuter Tesseract.
   */
  class RoiComposer {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    isAvailable() {
      return Boolean(this.ctx);
    }

    /**
     * @param {ImageBitmap|HTMLVideoElement} source
     * @returns {boolean} false si la source n'a pas encore de dimensions.
     */
    compose(source) {
      const sourceWidth = source.videoWidth || source.width || 0;
      const sourceHeight = source.videoHeight || source.height || 0;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return false;
      }

      const cropWidth = Math.max(1, Math.round(sourceWidth * CONFIG.ocrCornerWidthFraction));
      const cropHeight = Math.max(1, Math.round(sourceHeight * CONFIG.ocrCornerHeightFraction));
      const cellWidth = Math.round(CONFIG.ocrCompositeWidth / 2);
      const cellHeight = Math.max(1, Math.round((cellWidth * cropHeight) / cropWidth));

      if (this.canvas.width !== cellWidth * 2 || this.canvas.height !== cellHeight * 2) {
        this.canvas.width = cellWidth * 2;
        this.canvas.height = cellHeight * 2;
      }

      const ctx = this.ctx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

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
      const image = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      const pixels = image.data;
      const threshold = CONFIG.ocrBinarizeThreshold;

      for (let i = 0; i < pixels.length; i += 4) {
        const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        const value = luminance >= threshold ? 0 : 255;
        pixels[i] = value;
        pixels[i + 1] = value;
        pixels[i + 2] = value;
      }

      this.ctx.putImageData(image, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  TesseractOcr — moteur lourd, hébergé en iframe d'extension         */
  /* ------------------------------------------------------------------ */

  /**
   * Tesseract tourne dans une iframe `chrome-extension://` : la CSP de YouTube
   * bloque son worker WASM, celle de l'extension l'autorise.
   *
   * Se désactive après `maxTesseractFailures` échecs consécutifs — au-delà,
   * insister ne ferait que bloquer la boucle de scan sur des appels perdus.
   */
  class TesseractOcr {
    constructor() {
      this.bridge = new SandboxBridge({
        channel: OCR_MESSAGE_CHANNEL,
        pagePath: "pages/ocr-sandbox.html",
        readyTimeoutMs: CONFIG.ocrReadyTimeoutMs,
        requestTimeoutMs: CONFIG.ocrRequestTimeoutMs
      });

      this.ready = null;
      this.errorCount = 0;
      this.disabled = false;
      this.lastError = null;
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<{ text: string } | { error: string }>} `error` porte le
     *   tag de diagnostic ("tesseract-disabled", "tesseract-error"…).
     */
    async recognize(canvas) {
      if (this.disabled) {
        return { error: "tesseract-disabled" };
      }

      const ready = await this.ensureReady();
      if (!ready) {
        return { error: "tesseract-unavailable" };
      }

      let bitmap = null;

      try {
        bitmap = await createImageBitmap(canvas);
        const result = await this.bridge.request(
          "recognize",
          { imageBitmap: bitmap },
          { transferList: [bitmap] }
        );
        bitmap = null;

        this.errorCount = 0;
        return { text: result.text ?? "" };
      } catch (error) {
        if (bitmap) {
          try { bitmap.close(); } catch { /* ignore */ }
        }
        this.noteFailure(error);
        return { error: "tesseract-error" };
      }
    }

    noteFailure(error) {
      this.errorCount += 1;
      const detail = formatError(error);

      // Les 3 premières erreurs sont loguées telles quelles pour ne jamais
      // manquer le vrai mode de défaillance ; ensuite on déduplique.
      if (this.errorCount <= 3 || this.lastError !== detail) {
        this.lastError = detail;
        logWarn("Impossible d'analyser une frame pour OCR (Tesseract)", {
          attempt: this.errorCount,
          error: detail
        });
      }

      if (this.errorCount >= CONFIG.maxTesseractFailures && !this.disabled) {
        this.disabled = true;
        logWarn(
          `Tesseract désactivé après ${CONFIG.maxTesseractFailures} échecs consécutifs — ` +
          "OCR via WebCodecs neutralisé, seule la détection DOM reste active."
        );
      }
    }

    async ensureReady() {
      if (this.ready) {
        return this.ready;
      }

      this.ready = (async () => {
        const connected = await this.bridge.ensureReady();
        if (!connected) {
          return false;
        }
        await this.bridge.request("init", {}, { timeoutMs: CONFIG.ocrInitTimeoutMs });
        logInfo("Tesseract prêt (sandbox iframe chrome-extension://).");
        return true;
      })().catch((error) => {
        logWarn("Échec d’initialisation Tesseract (iframe)", {
          error: formatError(error)
        });
        this.ready = null;
        this.bridge.destroy();
        return false;
      });

      return this.ready;
    }

    async terminate() {
      if (this.bridge.isConnected()) {
        try {
          await this.bridge.request("terminate", {});
        } catch {
          // best-effort
        }
      }

      this.bridge.destroy();
      this.ready = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  FrameClassifier — « cette frame contient-elle une disclosure ? »   */
  /* ------------------------------------------------------------------ */

  /**
   * Choisit le moteur OCR disponible et transforme une frame en verdict.
   *
   * Le choix est exclusif : `TextDetector` (natif, ~10ms) quand la plateforme
   * l'expose, Tesseract sinon. Sur les Chromium Linux courants `TextDetector`
   * est absent, c'est donc Tesseract qui travaille.
   */
  class FrameClassifier {
    constructor() {
      this.roi = new RoiComposer();

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

      this.tesseract = this.ocrBackend === "tesseract" ? new TesseractOcr() : null;
      this.lastOcrError = null;
    }

    isAvailable() {
      return Boolean(this.roi.isAvailable() && this.ocrBackend);
    }

    getBackendLabel() {
      return this.ocrBackend ?? "none";
    }

    // Exposés pour le heartbeat de diagnostic.
    get tesseractErrorCount() {
      return this.tesseract?.errorCount ?? 0;
    }

    get tesseractDisabled() {
      return this.tesseract?.disabled ?? false;
    }

    /**
     * Analyse une frame, qu'elle vienne du décodeur (ImageBitmap) ou du
     * lecteur principal (<video>) — `drawImage` accepte les deux.
     */
    async detect(source, sampleTime) {
      if (!this.isAvailable()) {
        return noDetection(sampleTime, "ocr-unavailable");
      }

      try {
        if (!this.roi.compose(source)) {
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
        const blocks = await this.textDetector.detect(this.roi.canvas);
        const extractedText = blocks
          .map((block) => block?.rawValue ?? "")
          .filter(Boolean)
          .join(" ");

        return this.classify(sampleTime, extractedText, "text-detector");
      } catch (error) {
        this.logOcrErrorOnce("Impossible d'analyser une frame pour OCR (TextDetector)", error);
        return noDetection(sampleTime, "text-detector-error");
      }
    }

    async detectWithTesseract(sampleTime) {
      const result = await this.tesseract.recognize(this.roi.canvas);
      if (result.error) {
        return noDetection(sampleTime, result.error);
      }

      return this.classify(sampleTime, result.text, "tesseract");
    }

    classify(sampleTime, extractedText, source) {
      const matchedKeywords = extractCommercialKeywords(extractedText);

      return {
        sampleTime,
        hasCommercialKeyword: matchedKeywords.length > 0,
        matchedKeywords,
        source,
        extractedText
      };
    }

    logOcrErrorOnce(message, error) {
      const detail = formatError(error);
      if (this.lastOcrError === detail) {
        return;
      }
      this.lastOcrError = detail;
      logWarn(message, { error: detail });
    }

    async terminate() {
      await this.tesseract?.terminate();
    }
  }


  /* ------------------------------------------------------------------ */
  /*  MseSegmentBuffer — segments vidéo interceptés dans MSE            */
  /* ------------------------------------------------------------------ */

  /**
   * File des segments vidéo bruts que YouTube pousse dans MSE.
   *
   * Reçoit les messages du monde MAIN, réassemble les unités moof+mdat fMP4
   * (YouTube en découpe une sur plusieurs `appendBuffer()`, et un mdat tronqué
   * fait renvoyer 0 sample au demuxer), et tient la file des segments à
   * scanner.
   *
   * Chaque segment porte un `seq` monotone : l'éviction décale les indices du
   * tableau, or la sonde a besoin d'identifiants stables.
   */
  class MseSegmentBuffer {
    constructor({ onInitSegment, onNewMediaSource }) {
      this.onInitSegment = onInitSegment;
      this.onNewMediaSource = onNewMediaSource;

      this.initSegment = null;
      this.container = "mp4";
      this.mime = "";

      this.segments = []; // [{ data, timestampOffset, seq, scanned }]
      this.segmentSeq = 0;

      // Tampon de réassemblage fMP4 et offset de la timeline courante.
      this.mp4Accum = null;
      this.mp4AccumTsOffset = null;

      this.totalReceived = 0;

      this.boundOnMessage = (event) => this.onMessage(event);
    }

    listen() {
      window.addEventListener("message", this.boundOnMessage);
      // Rejoue ce qui a été capturé avant que la session ne soit prête.
      window.postMessage({ channel: MSE_CHANNEL, type: "request-replay" }, "*");
    }

    stopListening() {
      window.removeEventListener("message", this.boundOnMessage);
    }

    clear() {
      this.initSegment = null;
      this.segments = [];
      this.mp4Accum = null;
    }

    get unscannedCount() {
      return this.segments.filter((entry) => !entry.scanned).length;
    }

    nextUnscanned() {
      return this.segments.find((entry) => !entry.scanned) ?? null;
    }

    indexOfSeq(seq) {
      if (seq === null || seq === undefined) return -1;
      return this.segments.findIndex((entry) => entry.seq === seq);
    }

    hasUnscannedBetween(lowIndex, highIndex) {
      for (let i = lowIndex + 1; i < highIndex; i++) {
        if (!this.segments[i].scanned) return true;
      }
      return false;
    }

    /* ---------------------------------------------------------------- */
    /*  Réception des messages du monde MAIN                             */
    /* ---------------------------------------------------------------- */

    onMessage(event) {
      const msg = event.data;
      if (!msg || msg.channel !== MSE_CHANNEL) return;

      switch (msg.type) {
        case "new-media-source":
          this.clear();
          logInfo("MseSegmentBuffer: nouveau MediaSource détecté, reset.");
          this.onNewMediaSource();
          return;

        case "init-segment":
          logInfo("MseSegmentBuffer: init segment capturé", {
            bytes: msg.data?.byteLength,
            mime: msg.mime,
            container: msg.container
          });
          this.initSegment = msg.data;
          this.container = msg.container || "mp4";
          this.mime = msg.mime || "";
          this.mp4Accum = null;
          this.onInitSegment();
          return;

        case "media-segment":
          if (!this.initSegment) return; // Un média sans init est inexploitable.
          this.totalReceived += 1;
          this.acceptMediaSegment(msg.data, msg.timestampOffset ?? 0);
          this.evictOldSegments();
          return;

        default:
          return;
      }
    }

    acceptMediaSegment(data, timestampOffset) {
      if (this.container === "webm") {
        // WebM : le parseur de clusters balaie à plat, un push par append suffit.
        this.enqueue(data, timestampOffset);
        return;
      }
      this.accumulateMp4Chunk(data, timestampOffset);
    }

    enqueue(data, timestampOffset) {
      this.segments.push({ data, timestampOffset, seq: this.segmentSeq++ });
    }

    /* ---------------------------------------------------------------- */
    /*  Réassemblage fMP4                                                */
    /* ---------------------------------------------------------------- */

    /**
     * Ajoute un chunk brut au tampon de réassemblage et en extrait toutes les
     * unités moof+mdat complètes.
     */
    accumulateMp4Chunk(chunkBuffer, timestampOffset) {
      const incoming = new Uint8Array(chunkBuffer);

      // Un changement de timestampOffset signale une discontinuité (un seek) :
      // on jette les octets partiels pour ne pas coudre deux timelines.
      if (this.mp4Accum && this.mp4Accum.length > 0 &&
          this.mp4AccumTsOffset !== timestampOffset) {
        this.mp4Accum = null;
      }
      this.mp4AccumTsOffset = timestampOffset;

      if (!this.mp4Accum || this.mp4Accum.length === 0) {
        this.mp4Accum = incoming.slice(); // copie propre, sur une frontière de boîte
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
        if (!header) break;                          // entête tronqué — attendre
        if (header.extendsToEnd) break;              // non délimitable — attendre
        if (header.size < header.headerSize) break;  // corrompu — on garde le reste
        if (pos + header.size > bytes.length) break; // boîte incomplète — attendre

        if (header.type === "moof") {
          sawMoof = true;
        } else if (header.type === "mdat" && sawMoof) {
          const unit = bytes.slice(unitStart, pos + header.size); // copie propre
          this.enqueue(unit.buffer, timestampOffset);
          unitStart = pos + header.size;
          sawMoof = false;
        }

        pos += header.size;
      }

      // On ne garde que la queue non consommée pour le prochain chunk.
      this.mp4Accum = unitStart > 0 ? bytes.slice(unitStart) : bytes;
      // Soupape : ne jamais laisser le tampon croître sans fin sur un désalignement.
      if (this.mp4Accum.length > CONFIG.maxMp4AccumBytes) this.mp4Accum = new Uint8Array(0);
    }

    /** Plafond en NOMBRE de segments, pas en retard temporel. */
    evictOldSegments() {
      if (this.segments.length > CONFIG.maxCapturedSegments) {
        this.segments = this.segments.slice(-CONFIG.maxCapturedSegments);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  DecoderSandbox — configuration et décodage des keyframes           */
  /* ------------------------------------------------------------------ */

  /**
   * Façade sur la sandbox WebCodecs : configuration à partir de l'init segment
   * courant, puis décodage des keyframes d'un segment média.
   *
   * Tient le compte des échecs de configuration par init segment : quand la
   * plateforme n'a réellement pas de décodeur pour le codec annoncé, on cesse
   * d'insister et on prévient l'appelant via `onUnsupportedCodec`.
   */
  class DecoderSandbox {
    constructor({ buffer, mainVideo, onUnsupportedCodec }) {
      this.buffer = buffer;
      this.mainVideo = mainVideo;
      this.onUnsupportedCodec = onUnsupportedCodec;

      this.bridge = new SandboxBridge({
        channel: DECODER_CHANNEL,
        pagePath: "pages/decoder-sandbox.html",
        readyTimeoutMs: CONFIG.decoderReadyTimeoutMs,
        requestTimeoutMs: CONFIG.decoderRequestTimeoutMs
      });

      this.configured = false;
      this.configureFailures = 0;
      this.failedInitSegment = null;
    }

    /** Un nouvel init segment invalide la configuration en cours. */
    invalidateConfiguration() {
      this.configured = false;
      this.configureFailures = 0;
      this.failedInitSegment = null;
    }

    destroy() {
      this.bridge.postWithoutReply("terminate");
      this.bridge.destroy();
      this.configured = false;
    }

    async ensureConfigured() {
      if (this.configured) return true;

      const initSegment = this.buffer.initSegment;
      if (!initSegment) return false;
      // Ne pas marteler configure quand cet init exact a déjà échoué trop
      // souvent (typiquement : pas de décodeur pour le codec annoncé).
      if (this.failedInitSegment === initSegment) return false;

      const connected = await this.bridge.ensureReady();
      if (!connected) return false;

      // Un nouvel init segment peut arriver pendant l'aller-retour (changement
      // de qualité, insertion de pub) : on ne doit pas marquer le décodeur
      // configuré pour des octets périmés.
      const container = this.buffer.container;
      const mime = this.buffer.mime;

      try {
        const initCopy = initSegment.slice(0);
        await this.bridge.request("configure", {
          initSegment: initCopy,
          container,
          mime,
          fallbackWidth: this.mainVideo?.videoWidth || 0,
          fallbackHeight: this.mainVideo?.videoHeight || 0
        }, { transferList: [initCopy] });

        if (this.buffer.initSegment !== initSegment) {
          // Un init plus frais est arrivé : laisser `configured` à false pour
          // que le prochain scan reconfigure avec les bons octets.
          return false;
        }

        this.configured = true;
        this.configureFailures = 0;
        logInfo("DecoderSandbox: decoder configuré.");
        return true;
      } catch (error) {
        this.configureFailures += 1;
        logWarn("DecoderSandbox: échec configuration decoder", {
          attempt: this.configureFailures,
          error: formatError(error)
        });

        if (this.configureFailures >= CONFIG.maxConfigureFailures &&
            this.buffer.initSegment === initSegment) {
          this.failedInitSegment = initSegment;
          logWarn(
            `DecoderSandbox: codec non supporté après ${CONFIG.maxConfigureFailures} tentatives, ` +
            "bascule en fallback OCR vidéo."
          );
          this.onUnsupportedCodec();
        }
        return false;
      }
    }

    /**
     * Démuxe un segment média et renvoie ses keyframes décodées.
     * Le buffer est TRANSFÉRÉ à la sandbox : zéro copie, mais neutré ici.
     */
    async scanSegment(entry, { minTime, sampleInterval }) {
      return this.bridge.request("scan-segment", {
        mediaSegment: entry.data,
        minTime,
        sampleInterval
      }, { transferList: [entry.data] });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  AdEndProbe — localisation dichotomique de la fin d'une pub         */
  /* ------------------------------------------------------------------ */

  /**
   * Une fois une pub détectée, cesser de balayer la file segment par segment
   * (13 analyses pour 68s) et aller localiser sa FIN au bord du buffer
   * (~5-6 analyses), puis bissecter.
   *
   * La sonde raisonne sur les INDICES de la file, pas sur le temps : le temps
   * d'un segment n'est connu qu'APRÈS décodage, donc le choix du prochain
   * segment à sonder ne peut être que positionnel. Elle apprend le temps a
   * posteriori, via le `timestamp` renvoyé par le décodeur.
   *
   * Deux garde-fous symétriques, tous deux mesurés (DEV-NOTES §2.6) :
   * - anti sur-saut : un saut supérieur à `bigJumpThresholdSeconds` exige deux
   *   lectures positives distinctes, sinon un faux positif isolé ferait sauter
   *   du contenu légitime ;
   * - anti fin prématurée : l'OCR rate environ une frame sur onze, donc un
   *   négatif isolé n'est qu'un CANDIDAT. Il faut deux segments CONSÉCUTIFS
   *   négatifs pour borner la pub, et tout positif postérieur invalide la borne.
   */
  class AdEndProbe {
    constructor({ buffer, segmentStore, mainVideo, sourceTag, startTime, firstSegment }) {
      this.buffer = buffer;
      this.segmentStore = segmentStore;
      this.mainVideo = mainVideo;
      this.sourceTag = sourceTag;

      this.startTime = startTime;
      this.lastPositiveSeq = firstSegment.seq;
      this.lastPositiveTime = startTime;
      this.firstNegativeSeq = null;
      this.firstNegativeTime = Infinity;
      this.pendingNegativeSeq = null;
      this.pendingNegativeTime = Infinity;

      this.positiveCount = 1;
      this.probes = 0;

      /** Passe à true quand la fin est encadrée ; l'appelant abandonne la sonde. */
      this.resolved = false;
    }

    /** Résumé une ligne pour le heartbeat. */
    describe() {
      const upperBound = Number.isFinite(this.firstNegativeTime)
        ? this.firstNegativeTime.toFixed(1)
        : "?";
      return `[${this.lastPositiveTime.toFixed(1)}..${upperBound}] ` +
        `${this.probes} sonde(s), ${this.positiveCount} positif(s)`;
    }

    /**
     * Choisit le prochain segment à sonder. Tant qu'aucun négatif n'est connu on
     * vise la FRONTIÈRE (le segment le plus avancé du buffer, ~40s devant) ;
     * dès qu'une borne haute existe on bissecte entre elle et le dernier positif.
     * Renvoie null quand il n'y a rien de neuf à sonder (buffer pas encore
     * étendu) ou quand la fin est déjà encadrée.
     */
    pickSegment() {
      const segments = this.buffer.segments;
      const positiveIndex = Math.max(0, this.buffer.indexOfSeq(this.lastPositiveSeq));
      const confirmedIndex = this.firstNegativeSeq === null
        ? -1
        : this.buffer.indexOfSeq(this.firstNegativeSeq);
      const pendingIndex = this.pendingNegativeSeq === null
        ? -1
        : this.buffer.indexOfSeq(this.pendingNegativeSeq);

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
      this.maybeResolve();
      return null;
    }

    consumeResult(entry, time, detection) {
      if (this.resolved || !Number.isFinite(time)) return;

      if (detection.hasCommercialKeyword) {
        if (time > this.lastPositiveTime) {
          this.lastPositiveSeq = entry.seq;
          this.lastPositiveTime = time;
        }
        this.positiveCount += 1;
        this.invalidateNegativeBoundsBefore(time);
        this.extendAdEnd(time);
      } else if (time > this.lastPositiveTime) {
        // La confirmation d'un négatif doit être POSITIONNELLE — deux segments
        // CONSÉCUTIFS. Deux négatifs quelconques ne suffisent pas : sur une pub
        // longue, des faux négatifs épars finiraient par se confirmer entre eux
        // alors qu'un positif les sépare.
        const index = this.buffer.indexOfSeq(entry.seq);
        const pendingIndex = this.pendingNegativeSeq === null
          ? -1
          : this.buffer.indexOfSeq(this.pendingNegativeSeq);

        if (pendingIndex >= 0 && index === pendingIndex + 1) {
          this.firstNegativeSeq = this.pendingNegativeSeq;
          this.firstNegativeTime = this.pendingNegativeTime;
          logInfo("Sonde: fin confirmée par 2 négatifs consécutifs", {
            time: this.pendingNegativeTime.toFixed(1)
          });
        } else if (pendingIndex < 0 || time < this.pendingNegativeTime) {
          this.pendingNegativeSeq = entry.seq;
          this.pendingNegativeTime = time;
          logInfo("Sonde: négatif candidat, confirmation requise", {
            time: time.toFixed(1)
          });
        }
      }

      this.maybeResolve();
    }

    /**
     * Un positif POSTÉRIEUR à une borne négative la disqualifie : c'était un
     * faux négatif OCR, la pub continue au-delà.
     */
    invalidateNegativeBoundsBefore(time) {
      if (this.pendingNegativeSeq !== null && this.pendingNegativeTime <= time) {
        logInfo("Sonde: négatif candidat invalidé par un positif postérieur", {
          negatif: this.pendingNegativeTime.toFixed(1),
          positif: time.toFixed(1)
        });
        this.pendingNegativeSeq = null;
        this.pendingNegativeTime = Infinity;
      }

      if (this.firstNegativeSeq !== null && this.firstNegativeTime <= time) {
        this.firstNegativeSeq = null;
        this.firstNegativeTime = Infinity;
      }
    }

    /**
     * Étend la fin du segment stocké jusqu'à un point vérifié « encore pub ».
     * Le garde-fou anti sur-saut vit ici (et non dans SkipController, qui saute
     * simplement à segment.end) : un grand saut exige 2 lectures positives.
     */
    extendAdEnd(endTime) {
      const currentTime = Number(this.mainVideo?.currentTime ?? 0);
      const jump = endTime - currentTime;

      if (jump > CONFIG.bigJumpThresholdSeconds &&
          this.positiveCount < CONFIG.probeMinPositivesForBigJump) {
        logInfo("Sonde: extension retenue, confirmation requise", {
          end: endTime.toFixed(1),
          jump: jump.toFixed(1) + "s",
          positiveCount: this.positiveCount
        });
        return;
      }

      const added = this.segmentStore.addSegment({
        start: Math.max(0, this.startTime - CONFIG.segmentStartPadSeconds),
        end: endTime,
        source: this.sourceTag,
        confidence: 0.85
      });

      if (added) {
        logInfo("Sonde: fin de pub étendue", {
          end: endTime.toFixed(1),
          jump: jump.toFixed(1) + "s",
          positiveCount: this.positiveCount
        });
      }
    }

    /**
     * La fin est localisée dès que le dernier positif et le premier négatif sont
     * des segments adjacents (~5s de granularité, imposée par le GOP).
     */
    maybeResolve() {
      if (this.firstNegativeSeq === null) return;

      const positiveIndex = this.buffer.indexOfSeq(this.lastPositiveSeq);
      const negativeIndex = this.buffer.indexOfSeq(this.firstNegativeSeq);
      if (positiveIndex < 0 || negativeIndex < 0) return;
      // Encadré soit par adjacence, soit parce qu'il ne reste rien à sonder
      // entre les deux bornes.
      if (negativeIndex - positiveIndex > 1 &&
          this.buffer.hasUnscannedBetween(positiveIndex, negativeIndex)) {
        return;
      }

      // Borne haute confirmée par une lecture NÉGATIVE : pas de garde-fou ici,
      // la bissection est intrinsèquement bornée par le premier négatif.
      this.segmentStore.addSegment({
        start: Math.max(0, this.startTime - CONFIG.segmentStartPadSeconds),
        end: this.firstNegativeTime,
        source: this.sourceTag,
        confidence: 0.9
      });

      // L'intérieur de la pub n'apprend plus rien : inutile de le rescanner.
      for (let i = positiveIndex; i < negativeIndex; i++) {
        this.buffer.segments[i].scanned = true;
      }

      logInfo("Sonde: fin de pub localisée", {
        start: this.startTime.toFixed(1),
        end: this.firstNegativeTime.toFixed(1),
        sondes: this.probes
      });

      this.resolved = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  AheadScanner — orchestration du look-ahead                         */
  /* ------------------------------------------------------------------ */

  /**
   * Chef d'orchestre du look-ahead : fait tourner la boucle de scan sur les
   * segments capturés, envoie les keyframes décodées à l'OCR, accumule les
   * détections en segments commerciaux et arme la sonde de fin de pub.
   *
   * Quand aucune donnée MSE n'arrive (lecteur non-MSE) ou que le codec n'est
   * pas décodable, bascule sur un repli qui OCRise le lecteur visible.
   */
  class AheadScanner {
    constructor({ mainVideo, frameClassifier, segmentStore }) {
      this.mainVideo = mainVideo;
      this.frameClassifier = frameClassifier;
      this.segmentStore = segmentStore;

      this.ocrSourceTag = "ahead-ocr";

      this.buffer = new MseSegmentBuffer({
        onInitSegment: () => this.onInitSegment(),
        onNewMediaSource: () => this.onNewMediaSource()
      });

      this.decoder = new DecoderSandbox({
        buffer: this.buffer,
        mainVideo,
        onUnsupportedCodec: () => this.switchToFallback()
      });

      // Sonde de fin de pub ; null = balayage séquentiel.
      this.probe = null;

      // Boucle de scan
      this.lastScannedTime = -Infinity;
      this.scanLoopStopped = true;
      this.scanLoopRunning = false;

      // Repli OCR sur la vidéo principale
      this.useFallback = false;
      this.fallbackTimeout = null;
      this.fallbackInterval = null;
      // Ré-entrance du seul chemin qui en a besoin : le repli est piloté par un
      // setInterval, la boucle de scan MSE est séquentielle par construction.
      this.fallbackBusy = false;

      // Compteurs de diagnostic
      this.totalScans = 0;
      this.totalFramesDecoded = 0;
      this.totalOcrMatches = 0;
      this.heartbeatInterval = null;
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

      this.buffer.listen();
      this.startScanLoop();

      // Sans donnée MSE au bout de quelques secondes, on replie sur l'OCR du
      // lecteur visible.
      this.fallbackTimeout = window.setTimeout(() => {
        if (!this.buffer.initSegment) {
          logWarn("Aucun segment MSE reçu — repli OCR sur la vidéo principale.");
          this.switchToFallback();
        }
      }, CONFIG.noMseDataTimeoutMs);

      this.heartbeatInterval = window.setInterval(
        () => this.logHeartbeat(),
        CONFIG.heartbeatMs
      );
    }

    stop() {
      this.buffer.stopListening();
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
      this.probe = null;
      this.buffer.clear();
      this.decoder.destroy();
    }

    /* ---------------------------------------------------------------- */
    /*  Réactions aux évènements du tampon MSE                           */
    /* ---------------------------------------------------------------- */

    onInitSegment() {
      // On reçoit de la donnée MSE : le repli n'a plus lieu d'être.
      if (this.fallbackTimeout !== null) {
        window.clearTimeout(this.fallbackTimeout);
        this.fallbackTimeout = null;
      }
      if (this.fallbackInterval !== null) {
        window.clearInterval(this.fallbackInterval);
        this.fallbackInterval = null;
      }

      this.useFallback = false;
      this.ocrSourceTag = "ahead-ocr";
      this.decoder.invalidateConfiguration();
      // Le repli avait pu arrêter la boucle de scan : on la relance.
      this.startScanLoop();
    }

    onNewMediaSource() {
      this.lastScannedTime = -Infinity;
      this.probe = null;
      this.decoder.invalidateConfiguration();
    }

    /* ---------------------------------------------------------------- */
    /*  Boucle de scan                                                   */
    /* ---------------------------------------------------------------- */

    /** (Re)démarre la boucle de scan ; sans effet si elle tourne déjà. */
    startScanLoop() {
      this.scanLoopStopped = false;
      void this.runScanLoop();
    }

    /**
     * Les scans s'enchaînent dos à dos tant qu'il reste du backlog. On n'attend
     * `analysisPollMs` que lorsqu'il n'y a rien à faire — c'est un intervalle
     * d'INACTIVITÉ, pas un plafond de débit (un setInterval quantisait le cycle
     * à 2 ticks, soit la moitié du débit perdue en attente alors que ~25s de
     * contenu attendaient en file).
     */
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

    /** @returns {Promise<boolean>} true si un segment a été traité. */
    async scanNext() {
      if (this.useFallback) return false; // pris en charge par le repli
      if (!this.buffer.initSegment || this.buffer.segments.length === 0) return false;

      try {
        const configured = await this.decoder.ensureConfigured();
        if (!configured) return false;

        // Hors sonde : balayage séquentiel (plus ancien segment non scanné).
        // En sonde : on vise le bord du buffer, puis on bissecte.
        const probe = this.probe;
        const segmentEntry = probe ? probe.pickSegment() : this.buffer.nextUnscanned();
        this.dropProbeIfResolved();
        if (!segmentEntry) return false;

        segmentEntry.scanned = true;
        this.totalScans += 1;
        if (probe) probe.probes += 1;

        // En sonde on vise une keyframe PRÉCISE, en avance sur tout ce qui a été
        // scanné : le filtre minTime l'écarterait.
        const minTime = probe
          ? -Infinity
          : this.lastScannedTime + CONFIG.frameSampleSeconds;

        const result = await this.decoder.scanSegment(segmentEntry, {
          minTime,
          sampleInterval: CONFIG.frameSampleSeconds
        });

        const frames = result.frames ?? [];
        this.totalFramesDecoded += frames.length;

        if (frames.length === 0) {
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

        for (const frame of frames) {
          await this.analyseFrame(frame, segmentEntry, probe);
        }

        return true;
      } catch (error) {
        logWarn("AheadScanner: échec scan-segment", {
          error: formatError(error)
        });
        return false;
      }
    }

    async analyseFrame(frame, segmentEntry, probe) {
      if (!frame.imageBitmap) return;

      try {
        const detection = await this.frameClassifier.detect(
          frame.imageBitmap,
          frame.timestamp
        );

        try { frame.imageBitmap.close(); } catch { /* ignore */ }

        if (probe) {
          probe.consumeResult(segmentEntry, frame.timestamp, detection);
          this.dropProbeIfResolved();
        } else {
          this.consumeDetection(detection, segmentEntry);
          this.lastScannedTime = frame.timestamp;
        }
        if (detection.hasCommercialKeyword) this.totalOcrMatches += 1;

        logInfo("AheadScanner: frame analysée", {
          time: frame.timestamp.toFixed(1),
          mode: probe ? "sonde" : "séquentiel",
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

    /** La sonde a encadré la fin : on reprend le balayage séquentiel après elle. */
    dropProbeIfResolved() {
      if (!this.probe?.resolved) return;
      this.lastScannedTime = this.probe.firstNegativeTime;
      this.probe = null;
    }

    /* ---------------------------------------------------------------- */
    /*  Repli : OCR sur la vidéo principale                              */
    /* ---------------------------------------------------------------- */

    /** Bascule sur l'OCR du lecteur visible (pas de MSE, ou codec indécodable). */
    switchToFallback() {
      this.useFallback = true;
      this.ocrSourceTag = "main-video-ocr";
      this.startFallbackPolling();
    }

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
    /*  Accumulation des détections                                      */
    /* ---------------------------------------------------------------- */

    /**
     * Commit PROACTIF : dès qu'un mot-clé commercial est vu (souvent en avance
     * grâce au look-ahead), on insère immédiatement un segment
     * `[t - marge, t + fenêtre]`. Les détections successives se fusionnent
     * (`mergeGapSeconds`) en un segment qui couvre toute la pub, et le
     * SkipController peut couper dès le DÉBUT — sans attendre la fin.
     */
    consumeDetection(detection, segmentEntry = null) {
      const t = Number(detection.sampleTime ?? 0);
      if (!Number.isFinite(t)) return;
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

      // Sans segment capturé (mode repli vidéo), il n'y a rien à sonder : on
      // reste en balayage séquentiel.
      if (!this.probe && segmentEntry && !this.useFallback) {
        this.probe = new AdEndProbe({
          buffer: this.buffer,
          segmentStore: this.segmentStore,
          mainVideo: this.mainVideo,
          sourceTag: this.ocrSourceTag,
          startTime: t,
          firstSegment: segmentEntry
        });
        logInfo("Sonde armée", { start: t.toFixed(1) });
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Diagnostic                                                       */
    /* ---------------------------------------------------------------- */

    /** Secondes de vidéo déjà bufferisées devant le playhead. */
    bufferedAhead(currentTime) {
      const buffered = this.mainVideo?.buffered;
      if (!buffered) return 0;

      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
          return buffered.end(i) - currentTime;
        }
      }
      return 0;
    }

    logHeartbeat() {
      const currentTime = Number(this.mainVideo?.currentTime ?? 0);

      logInfo("AheadScanner heartbeat", {
        currentTime: currentTime.toFixed(1),
        bufferedAhead: this.bufferedAhead(currentTime).toFixed(1) + "s",
        decoderConfigured: this.decoder.configured,
        useFallback: this.useFallback,
        capturedSegments: `${this.buffer.segments.length} (${this.buffer.unscannedCount} non scannés)`,
        mediaSegmentsReceived: this.buffer.totalReceived,
        scansRun: this.totalScans,
        framesDecoded: this.totalFramesDecoded,
        ocrMatches: this.totalOcrMatches,
        ocrBackend: this.frameClassifier?.getBackendLabel?.() ?? "?",
        tesseractErrors: this.frameClassifier?.tesseractErrorCount ?? 0,
        tesseractDisabled: this.frameClassifier?.tesseractDisabled ?? false,
        storeSize: this.segmentStore?.segments?.length ?? 0,
        lastScannedTime: Number.isFinite(this.lastScannedTime)
          ? this.lastScannedTime.toFixed(1)
          : "-",
        mode: this.probe ? "sonde" : "séquentiel",
        probe: this.probe ? this.probe.describe() : "-"
      });
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
