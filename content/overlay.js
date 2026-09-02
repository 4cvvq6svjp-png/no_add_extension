/**
 * Détection par le DOM de YouTube.
 *
 * Repli réactif : lit l'overlay de divulgation que YouTube affiche lui-même.
 * Il ne voit la pub qu'une fois à l'écran — c'est un filet, pas le mécanisme
 * principal.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { CONFIG, logInfo, extractCommercialKeywords } = NoAdd;

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

  NoAdd.OverlayDetector = OverlayDetector;
})();
