/**
 * Lecture du texte dans une frame.
 *
 * Compose l'image soumise à l'OCR, la soumet au moteur disponible, et rend un
 * verdict « cette frame contient-elle une disclosure ? ».
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const {
    CONFIG, OCR_MESSAGE_CHANNEL, SandboxBridge, logInfo, logWarn,
    formatError, extractCommercialKeywords, noDetection
  } = NoAdd;

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

  NoAdd.RoiComposer = RoiComposer;
  NoAdd.TesseractOcr = TesseractOcr;
  NoAdd.FrameClassifier = FrameClassifier;
})();
