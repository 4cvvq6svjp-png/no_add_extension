/**
 * Zones commerciales détectées.
 *
 * Liste triée des segments à sauter, fusionnés au fil des détections.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { combineSources } = NoAdd;

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

  NoAdd.SegmentStore = SegmentStore;
})();
