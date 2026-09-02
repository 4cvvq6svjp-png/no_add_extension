/**
 * DOM minimal permettant d'exécuter le content script hors navigateur.
 *
 * Le but n'est pas de simuler Chrome, mais de faire tourner la logique pure
 * (géométrie du composite OCR, fusion de segments, mots-clés, amorçage de la
 * session) sans lancer de navigateur. Tout ce qui touche au réseau, au décodage
 * ou à Tesseract est hors de portée de ces tests — c'est le rôle du harness
 * `capture-logs.mjs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Contexte 2D factice qui enregistre les appels drawImage. */
class RecordingContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.draws = [];
  }

  drawImage(_source, sx, sy, sw, sh, dx, dy, dw, dh) {
    this.draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
  }

  fillRect() {}
  putImageData() {}

  getImageData(_x, _y, width, height) {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
}

function createElement(tag) {
  const element = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    isConnected: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    remove() { this.isConnected = false; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };

  if (tag === "canvas") {
    element.width = 300;
    element.height = 150;
    element.getContext = () => (element.recordingContext ??= new RecordingContext(element));
  }
  if (tag === "iframe") {
    element.contentWindow = { postMessage() {} };
  }

  return element;
}

/**
 * Installe le DOM factice sur globalThis.
 *
 * @param {{ href?: string, withVideo?: boolean }} options
 * @returns {{ logs: string[], warns: string[], timers: Array<{ ms: number }>, video: object, player: object }}
 */
export function installDomStub({ href = "https://www.youtube.com/watch?v=test", withVideo = true } = {}) {
  const logs = [];
  const warns = [];
  const timers = [];

  console.info = (...args) => logs.push(args.map(String).join(" "));
  console.warn = (...args) => warns.push(args.map(String).join(" "));

  const video = {
    ...createElement("video"),
    currentTime: 0,
    duration: 600,
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    buffered: { length: 0 }
  };
  const player = createElement("div");

  globalThis.window = globalThis;
  globalThis.location = { href };
  globalThis.HTMLVideoElement = Object; // waitForVideoElement fait un instanceof
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
  globalThis.document = {
    documentElement: createElement("html"),
    body: createElement("body"),
    createElement,
    addEventListener() {},
    querySelector(selector) {
      if (selector === "#movie_player") return player;
      if (withVideo && selector.includes("video")) return video;
      return null;
    }
  };

  // Les intervalles sont tracés, pas seulement comptés : un composant qui fuit
  // laisse le sien vivant, ce qui est observable.
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length;
  };
  globalThis.clearInterval = (id) => {
    const timer = timers[id - 1];
    if (timer) timer.cleared = true;
  };
  // Les timeouts ne se déclenchent pas : aucun test ne dépend d'un délai.
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.postMessage = () => {};
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

  return { logs, warns, timers, video, player };
}

/** Évalue libs/mp4demux.js et renvoie son API. */
export function loadMp4Demux() {
  globalThis.window ??= globalThis;
  new Function(readFileSync(join(REPO_ROOT, "libs/mp4demux.js"), "utf8"))();
  return globalThis.__mp4demux;
}

/**
 * Évalue les modules du content script, dans l'ordre déclaré par le manifeste,
 * et renvoie le namespace qu'ils publient.
 *
 * Les tests exercent donc le vrai ordre de chargement : un module qui
 * dépendrait d'un autre chargé après lui échouerait ici comme dans le
 * navigateur.
 */
export function loadContentScript() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "manifest.json"), "utf8"));
  const isolated = manifest.content_scripts.find((entry) => entry.world !== "MAIN");

  globalThis.window ??= globalThis;
  for (const file of isolated.js) {
    new Function(readFileSync(join(REPO_ROOT, file), "utf8"))();
  }

  return globalThis.__NoAdd;
}
