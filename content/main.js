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
