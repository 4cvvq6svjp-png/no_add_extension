/**
 * File des segments vidéo interceptés.
 *
 * Reçoit les octets que le monde MAIN copie au passage, recoud les unités
 * fMP4 et tient la file des segments à scanner.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { CONFIG, MSE_CHANNEL, logInfo } = NoAdd;

  // Posé par libs/mp4demux.js, chargé avant ce script par le manifeste.
  const mp4demux = globalThis.__mp4demux;

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

  NoAdd.MseSegmentBuffer = MseSegmentBuffer;
})();
