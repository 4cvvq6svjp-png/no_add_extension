/**
 * Retour visuel dans le lecteur.
 *
 * Une notification discrète, injectée dans le player YouTube.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { CONFIG } = NoAdd;

  class PlayerNotifier {
    constructor() {
      this.container = null;
      this.hideTimeout = null;
    }

    show(message, timeoutMs = CONFIG.notifierTimeoutMs) {
      const player = document.querySelector("#movie_player");
      if (!player) {
        return;
      }

      if (!this.container) {
        this.container = document.createElement("div");
        this.container.setAttribute("data-no-add-toast", "true");
        this.container.style.position = "absolute";
        this.container.style.top = "14px";
        this.container.style.right = "14px";
        this.container.style.maxWidth = "300px";
        this.container.style.padding = "10px 12px";
        this.container.style.borderRadius = "10px";
        this.container.style.background = "rgba(15, 15, 15, 0.82)";
        this.container.style.color = "white";
        this.container.style.fontSize = "12px";
        this.container.style.lineHeight = "1.35";
        this.container.style.fontFamily = "Inter, Arial, sans-serif";
        this.container.style.backdropFilter = "blur(4px)";
        this.container.style.zIndex = "9999";
        this.container.style.opacity = "0";
        this.container.style.transition = "opacity 160ms ease";
        this.container.style.pointerEvents = "none";
        player.appendChild(this.container);
      }

      this.container.textContent = message;
      this.container.style.opacity = "1";

      if (this.hideTimeout !== null) {
        window.clearTimeout(this.hideTimeout);
      }

      this.hideTimeout = window.setTimeout(() => {
        if (this.container) {
          this.container.style.opacity = "0";
        }
      }, timeoutMs);
    }

    destroy() {
      if (this.hideTimeout !== null) {
        window.clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }

      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }

      this.container = null;
    }
  }

  NoAdd.PlayerNotifier = PlayerNotifier;
})();
