/**
 * Sonde de fin de pub.
 *
 * Une fois une pub détectée, va localiser sa FIN au bord du buffer puis
 * bissecte, au lieu de la traverser segment par segment.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { CONFIG, logInfo } = NoAdd;

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

  NoAdd.AdEndProbe = AdEndProbe;
})();
