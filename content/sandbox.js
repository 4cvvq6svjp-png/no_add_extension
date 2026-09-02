/**
 * Pont vers les iframes d'extension.
 *
 * Un seul mécanisme pour les deux sandboxes (OCR et décodeur) : création de
 * l'iframe, handshake, requêtes corrélées par identifiant.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { logInfo, logWarn, formatError } = NoAdd;

  /**
   * Pont vers une sandbox iframe chrome-extension:// (OCR ou décodeur).
   *
   * Les deux sandboxes parlent le même protocole — création d'une iframe
   * invisible, handshake `sandbox-ready`, puis requêtes corrélées par `reqId`
   * avec timeout. Ce pont était écrit deux fois et les deux copies avaient
   * commencé à diverger ; il n'existe plus qu'ici.
   */
  class SandboxBridge {
    constructor({ channel, pagePath, readyTimeoutMs, requestTimeoutMs }) {
      this.channel = channel;
      this.pagePath = pagePath;
      this.readyTimeoutMs = readyTimeoutMs;
      this.requestTimeoutMs = requestTimeoutMs;
      this.iframe = null;
      this.pendingReady = null;
    }

    isConnected() {
      return Boolean(this.iframe?.contentWindow);
    }

    /** Crée l'iframe si besoin et attend son `sandbox-ready`. Idempotent. */
    async ensureReady() {
      if (this.iframe?.isConnected) {
        return true;
      }
      if (this.pendingReady) {
        return this.pendingReady;
      }

      this.pendingReady = this.createSandbox().finally(() => {
        this.pendingReady = null;
      });

      return this.pendingReady;
    }

    async createSandbox() {
      // L'écoute doit être armée AVANT l'insertion : la sandbox poste son
      // `sandbox-ready` dès qu'elle a chargé.
      const ready = this.waitForReadySignal();

      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-no-add-sandbox", this.channel);
      iframe.src = chrome.runtime.getURL(this.pagePath);
      iframe.style.cssText =
        "position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;";
      (document.documentElement ?? document.body).appendChild(iframe);

      try {
        await ready;
        this.iframe = iframe;
        logInfo(`Sandbox ${this.channel} prête.`);
        return true;
      } catch (error) {
        iframe.remove();
        logWarn(`Sandbox ${this.channel} : échec d'initialisation`, {
          error: formatError(error)
        });
        return false;
      }
    }

    waitForReadySignal() {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        };

        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`${this.channel}: sandbox-ready timeout`));
        }, this.readyTimeoutMs);

        const onMessage = (event) => {
          const data = event.data;
          if (data?.channel !== this.channel || data?.type !== "sandbox-ready") {
            return;
          }
          cleanup();
          resolve();
        };

        window.addEventListener("message", onMessage);
      });
    }

    /** Envoie une requête et résout sur la réponse `<type>-ok` correspondante. */
    async request(type, payload, { transferList = [], timeoutMs } = {}) {
      const sandboxWindow = this.iframe?.contentWindow;
      if (!sandboxWindow) {
        throw new Error(`Sandbox ${this.channel} indisponible`);
      }

      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        };

        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Sandbox timeout (${this.channel}/${type})`));
        }, timeoutMs ?? this.requestTimeoutMs);

        const onMessage = (event) => {
          const data = event.data;
          if (data?.channel !== this.channel || data.reqId !== reqId) {
            return;
          }

          cleanup();

          if (typeof data.type === "string" && data.type.endsWith("-ok")) {
            resolve(data);
          } else {
            reject(new Error(data.error || data.type || `${this.channel}-error`));
          }
        };

        window.addEventListener("message", onMessage);
        sandboxWindow.postMessage(
          { channel: this.channel, type, reqId, ...payload },
          "*",
          transferList
        );
      });
    }

    /** Notifie la sandbox sans attendre de réponse (teardown). */
    postWithoutReply(type) {
      try {
        this.iframe?.contentWindow?.postMessage(
          { channel: this.channel, type, reqId: "teardown" },
          "*"
        );
      } catch {
        // best-effort
      }
    }

    destroy() {
      if (this.iframe) {
        this.iframe.remove();
        this.iframe = null;
      }
      this.pendingReady = null;
    }
  }

  NoAdd.SandboxBridge = SandboxBridge;
})();
