/**
 * Amorçage et cycle de vie d'une session.
 *
 * Dernier script chargé : il assemble les composants publiés par les modules
 * précédents, suit les navigations SPA de YouTube, et démonte tout à chaque
 * changement de vidéo.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const {
    CONFIG, SegmentStore, PlayerNotifier, OverlayDetector, FrameClassifier,
    AheadScanner, SkipController, logInfo, logWarn, waitForVideoElement,
    getVideoIdFromCurrentUrl
  } = NoAdd;

  if (window.__NO_ADD_EXTENSION_LOADED__) {
    return;
  }
  window.__NO_ADD_EXTENSION_LOADED__ = true;

  /**
   * Arrête et démonte un jeu de composants de session.
   *
   * Utilisé aussi bien pour la session courante que pour une session dont le
   * montage a été doublé par une navigation plus récente.
   */
  function stopSessionComponents(components) {
    components.skipController?.stop();
    components.aheadScanner?.stop();
    if (components.frameClassifier) {
      void components.frameClassifier.terminate();
    }
    components.overlayDetector?.stop();
    components.notifier?.destroy();
    components.segmentStore?.clear();
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
      // Incrémenté à chaque démarrage de session. Toute reprise après un
      // `await` vérifie qu'elle est encore la session courante : trois sources
      // déclenchent une navigation (yt-navigate-finish, popstate, watcher
      // d'URL) et peuvent se chevaucher.
      this.sessionToken = 0;
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
      const token = ++this.sessionToken;
      this.teardownSession();

      const video = await waitForVideoElement(CONFIG.initTimeoutMs);
      if (token !== this.sessionToken) {
        // Une navigation plus récente a pris la main pendant l'attente (jusqu'à
        // initTimeoutMs). Sans ce contrôle, les deux sessions construisaient
        // chacune leur scanner et la première n'était jamais arrêtée.
        return;
      }

      if (!video) {
        logWarn("Aucune balise <video> détectée dans le délai imparti.");
        return;
      }

      // Les composants sont montés en local : ils ne deviennent la session
      // courante qu'une fois le jeton revalidé, jamais à moitié publiés.
      const segmentStore = new SegmentStore({
        mergeGapSeconds: CONFIG.mergeGapSeconds,
        minSegmentSeconds: CONFIG.minSegmentSeconds
      });
      const notifier = new PlayerNotifier();
      const overlayDetector = new OverlayDetector({
        video,
        onSegmentDetected: (segment) => {
          const added = segmentStore.addSegment(segment);
          if (added) {
            logInfo("Segment overlay ajouté", segment);
          }
        }
      });
      const frameClassifier = new FrameClassifier();
      const aheadScanner = new AheadScanner({
        mainVideo: video,
        frameClassifier,
        segmentStore
      });
      const skipController = new SkipController({ video, segmentStore, notifier });

      overlayDetector.start();
      await aheadScanner.start();

      if (token !== this.sessionToken) {
        // Remplacée pendant le démarrage : on démonte au lieu de publier, sinon
        // ces composants tourneraient sans que rien ne les référence.
        stopSessionComponents({
          skipController, aheadScanner, frameClassifier,
          overlayDetector, notifier, segmentStore
        });
        return;
      }

      this.currentVideoId = videoId;
      this.currentVideo = video;
      this.segmentStore = segmentStore;
      this.notifier = notifier;
      this.overlayDetector = overlayDetector;
      this.frameClassifier = frameClassifier;
      this.aheadScanner = aheadScanner;
      this.skipController = skipController;

      skipController.start();
      notifier.show("No Add Extension actif sur cette vidéo.");
      logInfo("Session initialisée", { videoId });
    }

    teardownSession() {
      this.currentVideoId = null;
      this.currentVideo = null;

      stopSessionComponents({
        skipController: this.skipController,
        aheadScanner: this.aheadScanner,
        frameClassifier: this.frameClassifier,
        overlayDetector: this.overlayDetector,
        notifier: this.notifier,
        segmentStore: this.segmentStore
      });

      this.skipController = null;
      this.aheadScanner = null;
      this.frameClassifier = null;
      this.overlayDetector = null;
      this.notifier = null;
      this.segmentStore = null;
    }
  }

  NoAdd.NoAddYouTubeController = NoAddYouTubeController;

  const controller = new NoAddYouTubeController();
  controller.start();
})();
