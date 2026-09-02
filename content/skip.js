/**
 * Exécution du saut.
 *
 * Surveille la lecture et saute quand elle entre dans une zone connue.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { CONFIG, logInfo } = NoAdd;

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

  NoAdd.SkipController = SkipController;
})();
