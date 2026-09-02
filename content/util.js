/**
 * Petites fonctions partagées.
 *
 * Journalisation, normalisation de texte, recherche de mots-clés, et les
 * quelques helpers DOM dont la session a besoin.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { EXTENSION_TAG, COMMERCIAL_KEYWORDS } = NoAdd;

  function logInfo(message, extra) {
    console.info(EXTENSION_TAG, message, ...(extra === undefined ? [] : [extra]));
  }

  function logWarn(message, extra) {
    console.warn(EXTENSION_TAG, message, ...(extra === undefined ? [] : [extra]));
  }

  function normalizeText(text) {
    if (!text) {
      return "";
    }

    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  /** Liste normalisée une fois au chargement, pas à chaque frame analysée. */
  const NORMALIZED_KEYWORDS = COMMERCIAL_KEYWORDS.map(normalizeText);

  function extractCommercialKeywords(rawText) {
    const normalized = normalizeText(rawText);

    if (!normalized) {
      return [];
    }

    return NORMALIZED_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  }

  function combineSources(previousSource, nextSource) {
    const labels = new Set();

    for (const source of [previousSource, nextSource]) {
      for (const label of String(source).split("+")) {
        const trimmed = label.trim();
        if (trimmed) {
          labels.add(trimmed);
        }
      }
    }

    return Array.from(labels).join("+");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatError(error) {
    if (error instanceof Error) {
      const base = error.message?.trim() || error.name || "Error";
      return error.stack ? `${base} (${error.stack.split("\n")[0]})` : base;
    }
    if (error === undefined || error === null) {
      return String(error);
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  async function waitForVideoElement(timeoutMs) {
    const startAt = Date.now();

    while (Date.now() - startAt < timeoutMs) {
      const video =
        document.querySelector("video.html5-main-video") ??
        document.querySelector("#movie_player video") ??
        document.querySelector("video");

      if (video instanceof HTMLVideoElement) {
        return video;
      }

      await sleep(250);
    }

    return null;
  }

  function getVideoIdFromCurrentUrl() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname !== "/watch") {
        return null;
      }

      return url.searchParams.get("v");
    } catch {
      return null;
    }
  }

  /** Résultat d'analyse sans mot-clé trouvé (ou analyse impossible). */
  function noDetection(sampleTime, source) {
    return {
      sampleTime,
      hasCommercialKeyword: false,
      matchedKeywords: [],
      source
    };
  }

  NoAdd.logInfo = logInfo;
  NoAdd.logWarn = logWarn;
  NoAdd.normalizeText = normalizeText;
  NoAdd.extractCommercialKeywords = extractCommercialKeywords;
  NoAdd.combineSources = combineSources;
  NoAdd.sleep = sleep;
  NoAdd.formatError = formatError;
  NoAdd.waitForVideoElement = waitForVideoElement;
  NoAdd.getVideoIdFromCurrentUrl = getVideoIdFromCurrentUrl;
  NoAdd.noDetection = noDetection;
})();
