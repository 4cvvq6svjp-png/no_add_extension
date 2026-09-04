/**
 * Orchestration du look-ahead.
 *
 * Fait tourner la boucle de scan, envoie les keyframes à l'OCR, accumule les
 * détections et arme la sonde. Bascule sur un repli quand MSE est muet.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const {
    CONFIG, MseSegmentBuffer, DecoderSandbox, AdEndProbe, logInfo,
    logWarn, formatError, sleep
  } = NoAdd;

  // Posé par libs/mp4demux.js, chargé avant ce script par le manifeste.
  const mp4demux = globalThis.__mp4demux;

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
        // Depuis la suppression de la détection par overlay DOM, l'OCR est le
        // seul mécanisme de détection : sans lui, l'extension ne fait rien.
        logWarn("Aucun moteur OCR disponible — l'extension est inactive sur cette plateforme.");
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
        // Un segment consommé est marqué scanné, donc perdu pour de bon. Tant
        // que l'OCR ne peut pas l'analyser — démarrage en cours, ou délai
        // d'attente après un échec — on n'en prend aucun : on décoderait pour
        // jeter, et le contenu ne serait jamais rattrapé.
        const ocrReady = await this.frameClassifier.ensureReady();
        if (!ocrReady) return false;

        const configured = await this.decoder.ensureConfigured();
        if (!configured) return false;

        // Hors sonde : balayage séquentiel (plus ancien segment non scanné).
        // En sonde : on vise le bord du buffer, puis on bissecte.
        const probe = this.probe;
        const segmentEntry = probe ? probe.pickSegment() : this.buffer.nextUnscanned();
        this.dropProbeIfFinished();
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
          this.dropProbeIfFinished();
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

    /**
     * La sonde a fini — fin localisée, ou abandonnée faute de borne fiable.
     * Dans les deux cas elle indique où le balayage séquentiel doit reprendre.
     */
    dropProbeIfFinished() {
      if (!this.probe?.finished) return;
      if (Number.isFinite(this.probe.resumeTime)) {
        this.lastScannedTime = this.probe.resumeTime;
      }
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

      // Même raison qu'en mode MSE : sans OCR prêt, avancer lastScannedTime
      // ferait sauter cette fenêtre de temps sans l'avoir analysée.
      if (!await this.frameClassifier.ensureReady()) return;

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

  NoAdd.AheadScanner = AheadScanner;
})();
