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
        workerBlobURL: true,
        logger: () => {}
      })
        .then(async (worker) => {
          await worker.setParameters({
            tessedit_pageseg_mode: String(
              self.Tesseract?.PSM?.SINGLE_BLOCK ?? "6"
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
        const {
          data: { text }
        } = await worker.recognize(msg.imageBitmap);
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
