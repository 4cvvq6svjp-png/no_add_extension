# No Add Extension — Architecture & Feasibility Document

> Written for review by Claude Opus. This document describes what the project wants to achieve, why the current approach was chosen, and how every component fits together. It is intended as context for an external technical review of efficiency, correctness, and feasibility.

---

## 1. Project Goal

YouTube creators are required by law (in France and the EU) to visually disclose when a video segment is a paid collaboration. This disclosure appears as an on-screen text overlay (e.g. "Collaboration commerciale" or "Contenu sponsorisé"). The **No Add Extension** is a Chromium browser extension that:

1. Detects these commercial disclosure overlays automatically by reading the video content before the user reaches them.
2. Skips the video past the sponsored segment when the user arrives at it, without any manual intervention.

The extension specifically targets the YouTube player and works on french-language disclosures. It is a prototype ("prototype" in the manifest description).

---

## 2. Why This Approach Was Chosen

### 2.1 The naive approach (DOM scraping) is insufficient

YouTube's player injects the `.ytp-paid-content-overlay` element when the video timeline reaches the marked position — meaning DOM detection is reactive, not predictive. It also relies on YouTube continuing to emit that element, which could change at any time.

### 2.2 The "ghost video" approach was abandoned

An early version created a hidden `<video>` element playing the same stream ahead of the main player. This was abandoned because:
- YouTube's player JS detects duplicate video elements and throttles or blocks them.
- Managing dual playback state (buffering, seeking, codec variants) is complex and fragile.

### 2.3 Current approach: MSE interception

YouTube uses the **Media Source Extensions (MSE) API** to feed video into its player segment-by-segment. Since the segments arrive on the network ahead of playback (typically 15–60s of buffer), the extension intercepts those raw binary segments at the `SourceBuffer.appendBuffer` level, decodes the keyframes ahead of time, and OCRs them for commercial keywords.

This gives a look-ahead window without a second video element, and requires no network requests of its own.

---

## 3. System Overview

```
YouTube Page
│
├── MAIN world (document_start)
│   └── mseInterceptor.js
│       Monkey-patches SourceBuffer.appendBuffer
│       → postMessage → ISOLATED world
│
└── ISOLATED world (document_idle)
    └── mainContent.js
        ├── OverlayDetector    (DOM fallback, reactive)
        ├── AheadScanner       (MSE path, predictive)
        │   ├── decoder-sandbox iframe
        │   │   ├── decoder-sandbox.js  (WebCodecs VideoDecoder)
        │   │   └── libs/mp4demux.js    (fMP4 + WebM parser)
        │   └── FrameClassifier
        │       ├── TextDetector API   (fast native pre-filter)
        │       └── ocr-sandbox iframe
        │           └── Tesseract.js   (heavy OCR fallback)
        ├── SegmentStore       (stores detected commercial ranges)
        └── SkipController     (acts on stored ranges at playback time)
```

---

## 4. Component-by-Component Description

### 4.1 `content/mseInterceptor.js` — MAIN world, `document_start`

**Role:** Observe all raw video bytes YouTube feeds into MSE before the ISOLATED world script is running.

**Why MAIN world:** The `SourceBuffer` prototype patches must be installed before YouTube's player JS runs. The only way to patch native browser APIs in the same scope as page JavaScript is `world: "MAIN"` in Manifest V3.

**What it does:**
- Patches `MediaSource.prototype.addSourceBuffer` to record which `SourceBuffer` instances carry video (based on MIME type: `video/*`, `avc`, `vp0`, `av01`).
- Patches `SourceBuffer.prototype.appendBuffer` to intercept every buffer append. For video buffers, it **copies the data before** delegating to the original `appendBuffer` and sends the copy via `window.postMessage`. The copy must happen before the original call because the MSE implementation can take ownership of a transferable buffer and detach it asynchronously, after which the copy attempt would silently fail.
- Patches `URL.createObjectURL` to detect when YouTube creates a new `MediaSource` (happens on SPA navigation to a new video) and resets the buffer.
- Maintains a **replay buffer** (`lastInitSegment` + `pendingMediaSegments`, max 20 segments) so that if the ISOLATED world content script starts after some segments have already been appended, it can request a replay and not miss them.
- Classifies each buffer as either an **init segment** (contains `ftyp`/`moov` for fMP4, or starts with EBML magic `0x1A45DFA3` for WebM) or a **media segment** (everything else).
- Attaches a `container` field (`"mp4"` or `"webm"`) to each message, derived from the SourceBuffer's MIME type.

**Messages sent (channel `no-add-mse-intercept`):**
| type | payload |
|------|---------|
| `init-segment` | `{ data: ArrayBuffer, mime, container, timestampOffset }` |
| `media-segment` | `{ data: ArrayBuffer, mime, timestampOffset }` |
| `new-media-source` | `{ blobUrl }` |

**Message received:**
| type | action |
|------|--------|
| `request-replay` | Re-sends buffered init + pending media segments |

---

### 4.2 `content/mainContent.js` — ISOLATED world, `document_idle`

This is the orchestration layer. It contains four major classes and a top-level bootstrap function.

#### 4.2.1 `SegmentStore`

A simple sorted list of `{ start, end, source, confidence }` objects representing detected commercial segments. On `addSegment`, it merges overlapping or near-adjacent segments (within `mergeGapSeconds = 2s`) and discards segments shorter than `minSegmentSeconds = 3s`.

#### 4.2.2 `PlayerNotifier`

A UI element: a small semi-transparent overlay injected into `#movie_player` that shows toast-style messages like "Segment publicitaire détecté — passage à…".

#### 4.2.3 `OverlayDetector`

**Role:** Reactive fallback detection using the DOM.

**How it works:**
- Polls YouTube's player DOM every `overlayPollMs = 750ms` and also watches for DOM mutations.
- Queries elements like `.ytp-paid-content-overlay`, `.ytp-paid-content-overlay-text`, `.ytp-impression-link`, and inspects their text content.
- When commercial keywords are found in the text, records the start time. When they disappear, records the end time and calls `onSegmentDetected`.
- Confidence: 0.9 (high, because it's reading YouTube's own disclosure element).

**Limitation:** This is reactive — it fires when the overlay is on screen, not before. So the user sees the first second or two of the commercial segment before the skip fires.

#### 4.2.4 `FrameClassifier`

**Role:** OCR engine that takes a video frame (from a `<video>` element or an `ImageBitmap`) and returns whether it contains commercial keywords.

**How it works:**
- Draws the source image to a 420×236 canvas.
- Crops the top 25% of the canvas into an ROI canvas (420×59). The disclosure overlay always appears near the top of the frame.
- Sends the ROI canvas to one of two OCR backends:

**Backend 1: `TextDetector` API (Chrome Shape Detection API)**
- Native browser API, extremely fast (~5–15ms).
- Used as the primary backend when available (Chromium 88+, not Firefox, not all platforms).
- Also used as a fast pre-filter when Tesseract is the primary backend: if `TextDetector` finds no text blocks at all, skip the Tesseract call entirely.

**Backend 2: Tesseract.js (inside OCR sandbox iframe)**
- Tesseract is a full OCR engine compiled to WebAssembly (~20MB).
- YouTube's CSP (`script-src 'self' 'unsafe-eval'` on `youtube.com`) would block WASM execution.
- The extension loads Tesseract inside a hidden `<iframe>` pointing to `pages/ocr-sandbox.html` (a chrome-extension:// page, which has its own CSP: `'wasm-unsafe-eval'`).
- Communication via `postMessage` with request IDs.
- Slow (~200–500ms per frame on a typical machine) but works on all platforms.

**Text normalization:** Accents are stripped (NFD normalization + remove combining diacritics) and text is lowercased before keyword matching. This handles "Collaboration commerciale" → "collaboration commerciale" → match.

#### 4.2.5 `AheadScanner`

**Role:** The main prediction engine. Decodes future video frames from raw MSE segments ahead of playback.

**Key state:**
- `initSegment`: The last received init segment (fMP4 or WebM).
- `initSegmentContainer`: `"mp4"` or `"webm"`.
- `capturedSegments[]`: Up to 30 recent media segments, each with `{ data, timestampOffset, receivedAt, scanned }`.
- `decoderIframe`: Hidden iframe running `decoder-sandbox.js`.
- `lastScannedTime`: Prevents re-scanning already-analyzed timestamps.
- `useFallback`: Set to `true` after 8s if no MSE data arrives (e.g. non-MSE player mode).

**Lifecycle:**

1. **`start()`**: Registers the `message` listener, sends `request-replay`, starts the scan interval (every 1200ms), and starts an 8-second fallback timer.
2. **MSE messages**: `init-segment` → stores init segment, cancels fallback timer, resets `decoderConfigured`. `media-segment` → appends to `capturedSegments`, evicts if >30 entries.
3. **`scanNext()`** (called every 1200ms):
   - Skips if `useFallback` is true, a scan is already pending, or there's no data.
   - Calls `ensureDecoderConfigured()` which lazily creates the decoder iframe and sends a `configure` message.
   - Finds the first unscanned segment in `capturedSegments`.
   - Sends a `scan-segment` message (transferring the raw `ArrayBuffer`) to the decoder sandbox.
   - Receives back an array of `{ timestamp, imageBitmap }` decoded keyframes.
   - For each bitmap, calls `frameClassifier.detectFromBitmap()`, then `consumeDetection()`.
   - Closes each bitmap after use.
4. **`consumeDetection()`**: Accumulates OCR results into commercial segments. An "active commercial" starts when a keyword is detected. It ends when `noMatchGraceSeconds = 8s` of non-matching frames pass. The finished segment is added to `SegmentStore`.
5. **Fallback mode**: If `useFallback = true`, `startFallbackPolling()` creates an interval that calls `fallbackTick()` every 1200ms. This reads frames directly from the visible `<video>` element using `detectFromVideo()` — same OCR path, no decoder needed.

#### 4.2.6 `SkipController`

**Role:** Executes skips when playback reaches a known commercial segment.

**How it works:**
- Listens to `timeupdate` + `seeked` events and also polls every 220ms.
- On each tick, calls `segmentStore.findSegmentForTime(video.currentTime)`.
- If the current time is inside a known segment, seeks to `segment.end + 0.4s` (skip margin).
- Enforces a 900ms cooldown between skips to avoid seek loops.
- Shows a `PlayerNotifier` message after each skip.

---

### 5. `pages/decoder-sandbox.js` — Extension iframe

**Role:** Runs inside a hidden `<iframe>` created by `AheadScanner`. Receives raw binary container data, parses it, decodes keyframes with WebCodecs, and returns `ImageBitmap` objects.

**Why an iframe:** WebCodecs `VideoDecoder` works fine in content scripts, but `mp4demux.js` needs to run in the same JS context as the `VideoDecoder`. Isolating it to an iframe also provides:
- A clean sandbox that can be destroyed and recreated when videos change.
- Its own JS execution context, preventing interference with YouTube's page.

**Message protocol (channel `no-add-decoder`):**

| type → | payload | response |
|--------|---------|----------|
| `configure` | `{ initSegment: ArrayBuffer, container, mime, fallbackWidth, fallbackHeight }` | `configure-ok` / `configure-err` |
| `scan-segment` | `{ mediaSegment: ArrayBuffer, minTime, sampleInterval }` | `scan-segment-ok { frames[] }` / `scan-segment-err` |
| `decode` | `{ data: ArrayBuffer, timestamp, isKeyframe, duration? }` | `decode-ok { imageBitmap }` / `decode-err` |
| `reset` | — | `reset-ok` |
| `terminate` | — | `terminate-ok` |

**`configure` handler:**
1. Branches on `container`:
   - `"webm"`: calls `mp4.parseWebMInitSegment(initBuffer, mime)` → extracts `{ codec, codedWidth, codedHeight, timestampScale }`.
   - `"mp4"`: calls `mp4.parseInitSegment(initBuffer)` + `mp4.parseTimescale(initBuffer)`.
2. If WebM returns `codedWidth = 0` (EBML parser failure), falls back to `fallbackWidth/fallbackHeight` from the `<video>` element's `videoWidth/videoHeight`. If both are zero (e.g. video metadata not yet loaded) the handler throws; the caller logs the error and the next `scanNext` tick will retry with refreshed dimensions.
3. Calls `VideoDecoder.isConfigSupported(config)` to verify the codec is supported.
4. Configures the `VideoDecoder`.
5. Stores `codecInfo = { ...info, timescale, container }`.

The caller (`AheadScanner.ensureDecoderConfigured`) snapshots `initSegment` / `container` / `mime` before sending `configure`, and after the await checks whether `this.initSegment` still points to the same snapshot. If a fresher init segment arrived during the round-trip (quality switch, ad break), `decoderConfigured` is left `false` so the next `scanNext` reconfigures with the new bytes — preventing the decoder from running with stale init data.

**`scan-segment` handler:**
1. Parses the media segment:
   - fMP4: `mp4.parseMediaSegment()` → array of `{ data, timestamp, duration, isKeyframe }`.
   - WebM: `mp4.parseWebMClusters()` → same shape.
2. Filters to keyframes beyond `minTime`, spaced at least `sampleInterval` seconds apart.
3. For each keyframe: creates an `EncodedVideoChunk`, calls `decoder.decode()` + `decoder.flush()`, waits for the `output` callback (via a Promise with 10s timeout), draws the resulting `VideoFrame` to an `OffscreenCanvas`, calls `canvas.transferToImageBitmap()`.
4. Returns all bitmaps in a single `scan-segment-ok` message, transferring the bitmaps.

---

### 6. `libs/mp4demux.js` — Container Parser Library

**Role:** Pure JS library for parsing fMP4 (ISO BMFF) and WebM (EBML/Matroska) container formats. Loaded inside the decoder iframe only.

#### 6.1 fMP4 functions

- **`parseInitSegment(buffer)`**: Walks the ISO BMFF box tree to find `moov > trak > mdia > minf > stbl > stsd`. Extracts codec string (`avc1.PPCCLL`, `hvc1.…`, `mp4a.40.2`, etc.), coded dimensions, and the codec-specific descriptor box (`avcC`, `hvcC`, `av1C`, `vpcC`).
- **`parseTimescale(buffer)`**: Reads `moov > mvhd` for the movie timescale.
- **`parseMediaSegment(buffer, { timescale, defaultSampleDuration, defaultSampleSize, defaultSampleFlags })`**: Walks `moof > traf > tfhd + tfdt + trun` boxes to extract individual sample records. Returns `[{ data, timestamp (seconds), duration, isKeyframe }]`.

**Utility helpers:** `hex(n)`, `pad2(n)` — used to build codec strings like `avc1.64001f`.

#### 6.2 WebM / EBML functions

WebM is used by Chromium on Linux for VP9 streams. It uses the EBML binary format (Extensible Binary Meta Language), a variable-length encoding scheme.

**EBML encoding:**
- **VINT IDs:** The number of leading zero bits + 1 determines the byte length. Unlike sizes, the marker bit is **kept** in the ID value.
- **VINT sizes:** Same length encoding, but the marker bit is **stripped** via a mask to get the actual byte count.

**Parser functions:**
- `ebmlReadId(u8, pos)` → `{ id, nextPos }`: reads 1–4 byte element ID.
- `ebmlReadSize(u8, pos)` → `{ size, nextPos }`: reads 1–8 byte element size (-1 for unknown/streaming size).
- `ebmlReadUint(u8, pos, len)` → integer: reads a big-endian unsigned integer of arbitrary byte length.
- `iterateEbml(u8, start, end)`: generator that yields `{ id, dataPos, size }` for each direct child element. Tolerates unknown-size (-1) elements by normalizing the yielded `size` to "extends to parent end" (`end - dataPos`); iteration ends after such an element since its true boundary is unknowable from the header alone.
- `findEbml(u8, targetId, start, end)`: linear scan that locates the first element with `targetId` inside `[start, end)`. **Descends past unknown-size containers** rather than stopping — this is what allows it to reach `Tracks` even when `Segment` is delivered with `size = -1` (the YouTube streaming case). Used by `parseWebMInitSegment` to find `Info`, `Tracks`, `TrackEntry`, `Video`, `PixelWidth`, `PixelHeight`, and `TimestampScale`.
- **`parseWebMInitSegment(buffer, mimeString)`**: Uses `findEbml` to locate `Tracks`, then iterates `TrackEntry` siblings until one with `TrackType = 1` (video) is found, and reads `Video > PixelWidth` / `PixelHeight`. `TimestampScale` is read from inside `Info`. The VP9 codec string is extracted from the MIME string (e.g. `video/webm; codecs="vp09.00.51.08"` → `vp09.00.51.08`) rather than from EBML, because the EBML `CodecID` value (`V_VP9`) is not a valid WebCodecs codec string. Returns `{ codec, codedWidth, codedHeight, description: null, timestampScale, container: "webm" }`.
- **`parseWebMClusters(buffer, { timestampScale })`**: Iterates the media segment looking for `Cluster` elements. Within each cluster, reads the `Timestamp` element and then each `SimpleBlock`. Decodes the SimpleBlock header (track number VINT, relative timestamp int16, flags byte) and constructs sample records. The keyframe flag is bit 7 of the flags byte. Converts timestamps from EBML units (nanoseconds × timestampScale / 1e9) to seconds.

**Streaming-size handling:** YouTube delivers WebM init segments with a top-level `Segment` element of unknown size (`-1`). The previous size-driven hierarchical walk stopped at that boundary and never reached `Tracks`, returning `codedWidth = 0, codedHeight = 0`. `findEbml` solves this by stepping past unknown-size headers and continuing the scan; for the small set of IDs we care about, EBML IDs are unique enough that flat scanning is unambiguous. The `videoWidth/videoHeight` fallback in the configure handler remains as a defensive net but should not be needed in normal operation.

---

### 7. Platform Differences

| Platform | Codec (observed) | Container | Parser used |
|----------|------------------|-----------|-------------|
| Windows / Mac (YouTube) | H.264 (`avc1`) or AV1 (`av01`) | fMP4 | `parseInitSegment` + `parseMediaSegment` |
| Linux (YouTube) — historically | VP9 (`vp09`) | WebM | `parseWebMInitSegment` + `parseWebMClusters` |
| Linux (YouTube) — now common | **AV1 (`av01`) in fMP4** | fMP4 | `parseInitSegment` + `parseMediaSegment` |

The MIME type of the `SourceBuffer` is used by the interceptor to determine container type (`video/webm` → WebM, anything else → fMP4).

**Update (2026-05-24):** YouTube has rolled out AV1 in fMP4 to Linux clients as well, so the fMP4 + AV1 path is now the primary code path on every desktop platform observed. The WebM/VP9 path still exists for older streams or fallback ABR selections, but is no longer the default on Linux. This is why correctness of the AV1 codec string emitted by `parseAv1C` is critical (see §11).

---

### 8. Cross-World Communication Architecture

The extension operates across four JS execution contexts. All communication uses `window.postMessage` or `iframe.contentWindow.postMessage`.

```
MAIN world (mseInterceptor.js)
  ↕  channel: "no-add-mse-intercept"
ISOLATED world (mainContent.js)
  ↕  channel: "no-add-decoder"
decoder-sandbox iframe (decoder-sandbox.js)
  (decoder-sandbox.js calls mp4demux.js internally)

ISOLATED world (mainContent.js / FrameClassifier)
  ↕  channel: "no-add-extension-ocr"
ocr-sandbox iframe (ocr-sandbox.js + Tesseract.js)
```

**ArrayBuffer transfers:** Raw segment data is transferred (not copied) between the ISOLATED world and the decoder iframe using `postMessage`'s `transferList`. This is a zero-copy operation but **neuters the source buffer** — once sent, `segmentEntry.data` is a detached 0-byte ArrayBuffer. This is acceptable because the data is no longer needed after scanning.

**Request IDs:** Every message from `mainContent.js` to its iframes includes a `reqId` (`${Date.now()}-${random}`). The reply listener filters on `reqId` to match responses to requests, allowing concurrent requests without cross-talk.

---

### 9. Bootstrap Flow

On page load at `https://www.youtube.com/watch`:

1. `mseInterceptor.js` installs patches synchronously at `document_start` (before any YouTube JS runs).
2. `mainContent.js` runs at `document_idle`. It:
   a. Checks for duplicate load (`window.__NO_ADD_EXTENSION_LOADED__`).
   b. Waits up to 20s for a `<video>` element to appear in the DOM.
   c. Constructs `SegmentStore`, `PlayerNotifier`, `FrameClassifier`, `AheadScanner`, `OverlayDetector`, `SkipController`.
   d. Calls `aheadScanner.start()`, `overlayDetector.start()`, `skipController.start()`.
   e. `AheadScanner.start()` sends `request-replay` to get any segments already buffered.
3. YouTube starts appending fMP4/WebM segments. The interceptor forwards each one.
4. On the first init segment, `AheadScanner` cancels the fallback timer, stores the segment.
5. On subsequent media segments, the scanner eventually calls `ensureDecoderConfigured()`, which lazily creates the decoder iframe and sends `configure`.
6. Each `scanNext()` tick (every 1200ms) sends the next unscanned media segment to the decoder sandbox for keyframe extraction + OCR.
7. When commercial keywords are detected, a segment range accumulates in `SegmentStore`.
8. When `video.currentTime` enters a known segment range, `SkipController` seeks past it and shows the notification.

---

### 10. Configuration Parameters

All tuneable constants are in the `CONFIG` object at the top of `mainContent.js`:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `frameSampleSeconds` | 5 | Minimum gap between analyzed keyframes |
| `minSegmentSeconds` | 3 | Minimum duration for a segment to be stored |
| `mergeGapSeconds` | 2 | Merge segments closer than this |
| `noMatchGraceSeconds` | 8 | Non-matching frames needed to close an active commercial |
| `skipMarginSeconds` | 0.4 | Extra seconds to seek past segment end |
| `skipCooldownMs` | 900 | Minimum ms between consecutive skips |
| `analysisPollMs` | 1200 | `scanNext` / `fallbackTick` interval |
| `canvasWidth/Height` | 420×236 | Resolution for OCR canvas |
| `ocrRoiTopFraction` | 0.25 | Top fraction of frame sent to OCR |
| `overlayPollMs` | 750 | DOM overlay check interval |
| `initTimeoutMs` | 20000 | Max wait for `<video>` element |

---

### 11. Known Issues and Open Risks

| Issue | Severity | Status |
|-------|----------|--------|
| AV1 codec string emitted by `parseAv1C` was malformed (`av01.P.LLT.BB.CCC` instead of `av01.P.LLT.BB.M.CCC`) — `VideoDecoder.isConfigSupported` rejected every AV1 stream | ~~High~~ | **Fixed.** `parseAv1C` now reads `chroma_sample_position` and emits the proper monochrome digit + 3-digit chroma triplet per ISO BMFF. Critical because YouTube now ships AV1/fMP4 on Linux (see §7). |
| `AheadScanner` re-attempted `configure` every 1.2 s indefinitely when the platform genuinely lacked a decoder, flooding the console | Medium | **Fixed.** `ensureDecoderConfigured` tracks failures per init segment; after 3 failures on the same init it pins `configureFailedInit`, switches `useFallback = true`, and starts the main-video OCR poller. Counters reset on every new init segment. |
| WebM coded size returns (0, 0) from EBML parser | ~~High~~ | **Fixed.** Root cause was `iterateEbml` breaking on the streaming `Segment` element (size = -1). Replaced with `findEbml`, a flat-scan helper that descends past unknown-size containers. The `videoWidth/videoHeight` fallback remains as a safety net. |
| Buffer copy in `mseInterceptor` happened after `origAppendBuffer` | High | **Fixed.** Copy is now performed before the original call, so the MSE implementation cannot detach a transferable buffer out from under us. |
| Configure race: stale init bytes if quality switch happens during configure round-trip | Medium | **Fixed.** `ensureDecoderConfigured` snapshots `initSegment` and re-checks identity after the await; if a fresher init arrived, `decoderConfigured` stays false and the next scan tick reconfigures. |
| Tesseract worker fetches `fra.traineddata` from `tessdata.projectnaptha.com` | Medium | Open. Architecture claims "no remote code", but the language data is loaded from a CDN. On builds where `TextDetector` is available (most Linux/Windows Chromium ≥ 88) the Tesseract path is never hit; otherwise a network failure leaves OCR unavailable until the next session. Fix: bundle `fra.traineddata.gz` under `libs/tesseract/lang-data/` and point `langPath` at `chrome.runtime.getURL(...)`. |
| `decoderBridgePromise` may be stale if iframe disconnects unexpectedly | Medium | Returns cached promise; iframe reload would require a full `stop()`/`start()` cycle |
| `scanInterval` continues ticking even in `useFallback = true` mode | Low | Wastes one check per 1.2s (early-return guard present) |
| Transferring media segment neuters `segmentEntry.data` | Design | If `scan-segment` fails, the data is unrecoverable — no retry possible |
| `evictOldSegments` evicts by count (>30), not by time behind playback | Low | Comment says "10s behind video" but implementation is count-based |
| `pendingDecode` is a single shared slot in `decoder-sandbox.js` | Low | Works because `scan-segment` decodes keyframes sequentially and VP9 keyframes produce one output each. A queue would harden the rare super-frame / multi-output case. |
| YouTube could change its SourceBuffer MIME patterns | External risk | The `isVideoMime()` heuristic (`avc`, `vp0`, `av01`) may miss new codecs |
| `TextDetector` API is not available on all Chromium builds | Platform | Gracefully falls back to Tesseract; performance degrades significantly |
| AV1 (`av01`) on WebM is not handled | Medium | Only fMP4 AV1 is implicitly handled; AV1-in-WebM would need a new EBML codec path |

---

### 11bis. Diagnostics & Logging

To make end-to-end pipeline failures debuggable from the DevTools console alone, the following structured logs are emitted (all prefixed `[NoAddExtension]`, `[NoAdd-MSE]`, or `[NoAdd-Decoder]`):

| Source | Cadence | Log | What it tells you |
|--------|---------|-----|-------------------|
| `mseInterceptor` | every 5 s, throttled | `media-segments: N reçus, K KB cumulés` | YouTube is feeding fMP4/WebM data into MSE and we are observing it. Silence here means the MSE patch never engaged. |
| `mseInterceptor` | once per stream | `Video SourceBuffer registered <mime>` | The MIME (and therefore codec/container) YouTube selected for this video. |
| `AheadScanner` | every 5 s | `AheadScanner heartbeat { currentTime, bufferedAhead, decoderConfigured, useFallback, capturedSegments, mediaSegmentsReceived, scansRun, framesDecoded, ocrMatches, storeSize, lastScannedTime }` | One-line snapshot of the entire pipeline state. The single most useful log for triage: it tells you whether segments are arriving, whether the decoder is configured, whether scans are running, and whether OCR has matched anything. |
| `decoder-sandbox` | once per `scan-segment` | `scan-segment parse: { samples, keyframesTotal, keyframesKept, minTime, tsRange, container }` | Whether the demuxer found any samples at all, how many were keyframes, and how many survived the `minTime`/`sampleInterval` filter. `keyframesKept = 0` while `keyframesTotal > 0` means the filter is too aggressive for this segment. |
| `decoder-sandbox` | per failed keyframe | `keyframe decode failed { ts, err }` + summary `N/M keyframes failed to decode` | WebCodecs decoder errors on specific frames (corrupt data, codec/profile mismatch). |
| `AheadScanner` | per analyzed frame | `frame analysée { time, keyword, matched, ocrSource, textPreview, lead }` | The exact text the OCR returned for each keyframe, which keywords (if any) matched, and how far ahead of playback the scan is. `textPreview` is truncated to 80 chars. |
| `AheadScanner` | per empty scan | `scan-segment OK mais aucune keyframe utile { minTime, bufferBytes }` | The scan completed but the decoder sandbox returned no usable frames — either no keyframes in this segment, or they were all below `minTime`. |
| `SkipController` | every 10 s, throttled | `aucun segment ne couvre currentTime { currentTime, storeSize, firstSegments }` | The store has detected segments but `currentTime` is outside all of them. Useful to confirm whether detections are landing in the wrong time range (e.g. after playback already passed them, or pointing into the future the user hasn't reached). |
| `SkipController` | per skip | `Skip appliqué { from, to, source }` | Confirms a successful skip and identifies which detection source (`dom-overlay`, `ahead-ocr`, `main-video-ocr`) produced the segment. |

**Reading order during triage.** Start with the `heartbeat`. If `mediaSegmentsReceived` is 0, the MSE patch failed (check MAIN-world install). If it is non-zero but `scansRun` is 0, the decoder configure is failing — look upward for `échec configuration decoder`. If `scansRun > 0` but `framesDecoded` is 0, look for `scan-segment parse:` lines to see whether the demuxer returns samples. If `framesDecoded > 0` but `ocrMatches` is 0, inspect `textPreview` in `frame analysée` to see what the OCR actually reads (the overlay may be cropped out, or YouTube may have changed the disclosure wording).

---

### 12. Security and Extension Permissions

- **Permissions:** `storage` only (not used yet, reserved for settings).
- **Host permissions:** `https://www.youtube.com/*` only.
- **CSP for extension pages:** `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` — minimal, allows WASM for Tesseract.
- **No remote code:** All resources are bundled in the extension package. Tesseract WASM is loaded from `libs/tesseract/*` (web-accessible resources).
- **ArrayBuffer handling:** All buffer copies are made before sending via postMessage to avoid use-after-free bugs. The interceptor copies before posting; the decoder-sandbox receives transfers (zero-copy but neuters source).
- **No eval, no innerHTML:** The extension uses only DOM APIs and postMessage. No user-controlled content is ever injected into the page as HTML.

---

### 13. Summary: Data Flow for a Typical Commercial Segment

```
YouTube player calls SourceBuffer.appendBuffer(mediaSegment)
  │
  ├─ mseInterceptor copies data → postMessage("media-segment", data)
  │
  └─ AheadScanner receives "media-segment"
       └─ capturedSegments.push(...)
         (1200ms later) scanNext() fires
           └─ decoderRequest("scan-segment", { mediaSegment })
                [ArrayBuffer transferred to decoder iframe]
                │
                └─ decoder-sandbox.js
                     ├─ mp4.parseMediaSegment() or mp4.parseWebMClusters()
                     │    → [{data, timestamp, isKeyframe}, ...]
                     ├─ filter: keyframes, spaced ≥5s, beyond lastScannedTime
                     └─ for each keyframe:
                          VideoDecoder.decode(chunk)
                          await VideoDecoder.flush()
                          → VideoFrame output callback
                          → OffscreenCanvas.drawImage(frame)
                          → canvas.transferToImageBitmap()
                          [bitmap collected]
                     → scan-segment-ok { frames: [{timestamp, imageBitmap}] }
                          [ImageBitmaps transferred back to ISOLATED world]
           │
           └─ for each bitmap:
                frameClassifier.detectFromBitmap(bitmap, timestamp)
                  ├─ ctx.drawImage(bitmap, 0, 0, 420, 236)
                  ├─ roiCtx.drawImage(canvas, 0,0,420,59, 0,0,420,59)
                  └─ TextDetector.detect(roiCanvas)
                       or Tesseract postMessage("recognize", roiCanvas)
                       → { hasCommercialKeyword, matchedKeywords }
                consumeDetection(detection)
                  → [eventually] segmentStore.addSegment({ start, end })

(at playback time, every 220ms)
SkipController.tick()
  └─ segmentStore.findSegmentForTime(video.currentTime)
       → if match: video.currentTime = segment.end + 0.4
                   notifier.show("Segment publicitaire sauté")
```

---

*End of document.*
