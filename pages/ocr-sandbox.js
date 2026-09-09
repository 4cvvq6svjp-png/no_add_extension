/**
 * OCR Sandbox — Tesseract.js running inside an extension iframe.
 *
 * YouTube's CSP forbids the WASM worker Tesseract needs, so the engine lives
 * in a chrome-extension:// page, which is governed by the extension's own CSP.
 * The content script sends ImageBitmaps in and gets recognised text back.
 *
 * Communication channel: "no-add-extension-ocr"
 *
 *   init       — start (or reuse) the Tesseract worker
 *   recognize  — { imageBitmap } -> { text }
 *   terminate  — release the worker
 */
(() => {
  "use strict";

  const CHANNEL = "no-add-extension-ocr";

  let workerPromise = null;

  function formatError(error) {
    if (error instanceof Error) return error.message || error.name || "Error";
    return String(error);
  }

  async function getWorker() {
    if (!workerPromise) {
      const base = chrome.runtime.getURL("libs/tesseract/");
      workerPromise = self.Tesseract.createWorker("fra", 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-simd.wasm.js`,
        // Modèle embarqué : c'était la seule dépendance réseau, et depuis
        // la suppression de la détection DOM, son échec rend l'extension muette.
        langPath: chrome.runtime.getURL("libs/tesseract/lang-data"),
        gzip: true,
        workerBlobURL: false,
        logger: () => {}
      })
        .then(async (worker) => {
          // PSM 11 = SPARSE_TEXT: find as much text as possible regardless of
          // layout. Right tool for a video frame where we just want to surface
          // any disclosure keyword wherever it appears (top, bottom, badge,
          // overlay corner...). PSM 6 (SINGLE_BLOCK, the previous setting)
          // assumed one uniform paragraph and bailed early on multi-region UI.
          await worker.setParameters({
            tessedit_pageseg_mode: String(
              self.Tesseract?.PSM?.SPARSE_TEXT ?? "11"
            )
          });
          return worker;
        })
        .catch((error) => {
          workerPromise = null;
          throw error;
        });
    }
    return workerPromise;
  }

  /**
   * Tesseract.js' internal Web Worker fails with "Error attempting to read
   * image" when handed a raw ImageBitmap that has already been transferred via
   * postMessage. Reify it into a PNG Blob — the input type most widely
   * supported across Tesseract.js versions.
   */
  async function toRecognizableInput(source) {
    if (typeof ImageBitmap === "undefined" || !(source instanceof ImageBitmap)) {
      return source;
    }

    const canvas = new OffscreenCanvas(source.width, source.height);
    canvas.getContext("2d").drawImage(source, 0, 0);
    try { source.close(); } catch { /* ignore */ }
    return canvas.convertToBlob({ type: "image/png" });
  }

  /** One handler per message type; the return value becomes the reply payload. */
  const HANDLERS = {
    async init() {
      await getWorker();
      return {};
    },

    async recognize(msg) {
      const worker = await getWorker();
      const input = await toRecognizableInput(msg.imageBitmap);
      const { data: { text } } = await worker.recognize(input);
      return { text: text ?? "" };
    },

    async terminate() {
      const pending = workerPromise;
      workerPromise = null;
      const worker = pending ? await pending.catch(() => null) : null;
      if (worker) {
        await worker.terminate().catch(() => {});
      }
      return {};
    }
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent) return;

    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    const handler = HANDLERS[msg.type];
    if (!handler) return;

    const reply = (payload) =>
      event.source.postMessage({ channel: CHANNEL, reqId: msg.reqId, ...payload }, "*");

    try {
      reply({ type: `${msg.type}-ok`, ...(await handler(msg)) });
    } catch (error) {
      reply({ type: `${msg.type}-err`, error: formatError(error) });
    }
  });

  window.parent.postMessage({ channel: CHANNEL, type: "sandbox-ready" }, "*");
})();
