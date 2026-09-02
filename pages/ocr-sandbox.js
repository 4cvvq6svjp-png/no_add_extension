(() => {
  const CHANNEL = "no-add-extension-ocr";

  let workerPromise = null;

  function formatErr(error) {
    if (error instanceof Error) {
      return error.message || error.name || "Error";
    }
    return String(error);
  }

  function replyToParent(eventSource, payload) {
    eventSource.postMessage({ channel: CHANNEL, ...payload }, "*");
  }

  async function getWorker() {
    if (!workerPromise) {
      const base = chrome.runtime.getURL("libs/tesseract/");
      workerPromise = self.Tesseract.createWorker("fra", 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-simd.wasm.js`,
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
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

  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent) {
      return;
    }

    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) {
      return;
    }

    const answer = (payload) => replyToParent(event.source, payload);

    if (msg.type === "init") {
      try {
        await getWorker();
        answer({ type: "init-ok", reqId: msg.reqId });
      } catch (error) {
        answer({
          type: "init-err",
          reqId: msg.reqId,
          error: formatErr(error)
        });
      }
      return;
    }

    if (msg.type === "recognize") {
      try {
        const worker = await getWorker();

        // Tesseract.js' internal Web Worker fails with
        // "Error attempting to read image" when handed a raw ImageBitmap
        // that has already been transferred via postMessage. Reify it into a
        // Blob (PNG) through an OffscreenCanvas — Blob is the most widely
        // supported input across Tesseract.js versions.
        let input = msg.imageBitmap;
        if (typeof ImageBitmap !== "undefined" && input instanceof ImageBitmap) {
          const canvas = new OffscreenCanvas(input.width, input.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(input, 0, 0);
          try { input.close(); } catch { /* ignore */ }
          input = await canvas.convertToBlob({ type: "image/png" });
        }

        const {
          data: { text }
        } = await worker.recognize(input);
        answer({
          type: "recognize-ok",
          reqId: msg.reqId,
          text: text ?? ""
        });
      } catch (error) {
        answer({
          type: "recognize-err",
          reqId: msg.reqId,
          error: formatErr(error)
        });
      }
      return;
    }

    if (msg.type === "terminate") {
      try {
        const pending = workerPromise;
        workerPromise = null;
        if (pending) {
          const worker = await pending.catch(() => null);
          if (worker) {
            await worker.terminate();
          }
        }
      } catch {
        // best-effort
      }
      answer({ type: "terminate-ok", reqId: msg.reqId });
    }
  });

  window.parent.postMessage({ channel: CHANNEL, type: "sandbox-ready" }, "*");
})();
