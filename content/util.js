/**
 * Petites fonctions partagées.
 *
 * Journalisation, normalisation de texte, recherche de mots-clés, et les
 * quelques helpers DOM dont la session a besoin.
 */
(() => {
  "use strict";

  const NoAdd = (window.__NoAdd ??= {});
  const { EXTENSION_TAG, CONFIG, COMMERCIAL_KEYWORDS } = NoAdd;

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

  /**
   * Distance d'édition minimale entre `needle` et une sous-chaîne quelconque de
   * `haystack` : préfixe et suffixe libres.
   *
   * C'est de la recherche approchée de sous-chaîne, pas une comparaison de
   * chaînes entières — l'OCR rend le mot-clé noyé dans du bruit, et on veut
   * savoir s'il s'y trouve à quelques fautes près. La première ligne de la
   * matrice reste à zéro (on peut commencer n'importe où) et on lit le minimum
   * de la dernière (on peut finir n'importe où).
   */
  function approximateDistance(haystack, needle) {
    if (!needle) return 0;

    let previous = new Array(haystack.length + 1).fill(0);

    for (let i = 1; i <= needle.length; i++) {
      const current = new Array(haystack.length + 1);
      current[0] = i;

      for (let j = 1; j <= haystack.length; j++) {
        const substitution = previous[j - 1] + (needle[i - 1] === haystack[j - 1] ? 0 : 1);
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      }

      previous = current;
    }

    return Math.min(...previous);
  }

  /** Nombre de fautes toléré sur un mot-clé, proportionnel à sa longueur. */
  function keywordEditBudget(keyword) {
    return Math.min(CONFIG.keywordMaxEdits, Math.floor(keyword.length / CONFIG.keywordEditDivisor));
  }

  /** Mots-clés normalisés et leur budget, calculés une fois au chargement. */
  const NORMALIZED_KEYWORDS = COMMERCIAL_KEYWORDS.map((keyword) => {
    const text = normalizeText(keyword);
    return { text, budget: keywordEditBudget(text) };
  });

  function extractCommercialKeywords(rawText) {
    const normalized = normalizeText(rawText);

    if (!normalized) {
      return [];
    }

    return NORMALIZED_KEYWORDS
      .filter(({ text, budget }) =>
        // Le cas exact est de loin le plus fréquent : on l'écarte avant de
        // payer la matrice de distance.
        normalized.includes(text) ||
        (budget > 0 && approximateDistance(normalized, text) <= budget))
      .map(({ text }) => text);
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
  NoAdd.approximateDistance = approximateDistance;
  NoAdd.extractCommercialKeywords = extractCommercialKeywords;
  NoAdd.combineSources = combineSources;
  NoAdd.sleep = sleep;
  NoAdd.formatError = formatError;
  NoAdd.waitForVideoElement = waitForVideoElement;
  NoAdd.getVideoIdFromCurrentUrl = getVideoIdFromCurrentUrl;
  NoAdd.noDetection = noDetection;
})();
