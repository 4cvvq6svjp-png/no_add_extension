/**
 * Façade sur la sandbox WebCodecs.
 *
 * Configure le décodeur à partir de l'init segment courant, puis lui fait
 * décoder les keyframes d'un segment média.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const {
    CONFIG, DECODER_CHANNEL, SandboxBridge, logInfo, logWarn, formatError
  } = NoAdd;

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

  NoAdd.DecoderSandbox = DecoderSandbox;
})();
