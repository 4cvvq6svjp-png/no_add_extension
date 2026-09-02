#!/usr/bin/env node
/**
 * capture-logs.mjs — Harness de test / capture des logs pour No Add Extension.
 *
 * Charge l'extension non empaquetée dans une instance Chrome dédiée (profil
 * persistant), ouvre une vidéo YouTube, et capture TOUS les contextes console
 * (page + iframes sandbox décodeur/OCR + service worker) vers un fichier JSONL,
 * puis affiche un résumé sur stdout.
 *
 * Nouveauté clé : on peut annoter les fenêtres de pub réelles (--ad start-end).
 * Le harness saute ~30 s avant chaque fenêtre, laisse jouer à travers, et juge
 * si l'extension a détecté/sauté le segment (HIT) ou non (MISS). Dès qu'une
 * fenêtre est jugée, on passe à la suivante (seek), et on s'arrête après la
 * dernière — inutile de laisser tourner la vidéo pour rien.
 *
 * Usage :
 *   node tools/capture-logs.mjs --url <video> [--ad 2:05-2:35 --ad 8:10-8:40]
 *                               [--seconds 180] [--out logs/run-<ts>.jsonl]
 *                               [--seek-lead 30] [--grace 2] [--headless]
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PROFILE_DIR = join(__dirname, ".profile");
const LOGS_DIR = join(REPO_ROOT, "logs");

/* Vidéo de référence : contient une pub « collaboration commerciale » 3:49→4:57. */
const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=vRAPfDSmBGM";
/* Fenêtres de pub par défaut (appliquées si --url == TEST_VIDEO_URL et aucun --ad). */
const DEFAULT_ADS = [{ start: 229, end: 297 }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- */
/*  Parsing des arguments                                                 */
/* --------------------------------------------------------------------- */

function parseTimecode(str) {
  // Accepte "125", "2:05", "1:02:05".
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Sort en code 2 comme `--ad` le fait déjà, plutôt que de propager un NaN. */
function requireNumber(flag, raw, { min = 0 } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`Valeur invalide pour ${flag} : "${raw}" (nombre >= ${min} attendu).`);
    process.exit(2);
  }
  return value;
}

function requireTimecode(flag, raw) {
  const value = parseTimecode(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Timecode invalide pour ${flag} : "${raw}" (attendu 125, 2:05 ou 1:02:05).`);
    process.exit(2);
  }
  return value;
}

function requireValue(flag, raw) {
  if (raw === undefined || String(raw).startsWith("--")) {
    console.error(`Argument manquant pour ${flag}.`);
    process.exit(2);
  }
  return raw;
}

function parseArgs(argv) {
  const opts = {
    url: TEST_VIDEO_URL,
    ads: [],
    seconds: 180,
    seekLead: 30,
    grace: 2,
    headless: false,
    noExtension: false,
    passive: false,
    login: false,
    noSeek: false,
    fullWindow: false,
    screenshot: null,
    out: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": opts.url = requireValue(a, next()); break;
      case "--seconds": opts.seconds = requireNumber(a, next(), { min: 1 }); break;
      case "--seek-lead": opts.seekLead = requireNumber(a, next()); break;
      case "--grace": opts.grace = requireNumber(a, next()); break;
      case "--out": opts.out = requireValue(a, next()); break;
      case "--headless": opts.headless = true; break;
      case "--no-extension": opts.noExtension = true; break;
      case "--passive": opts.passive = true; break;
      case "--login": opts.login = true; break;
      case "--no-seek": opts.noSeek = true; break;
      case "--full-window": opts.fullWindow = true; break;
      case "--screenshot": opts.screenshot = requireTimecode(a, next()); break;
      case "--ad": {
        const [s, e] = String(next()).split("-");
        const start = parseTimecode(s);
        const end = parseTimecode(e);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          console.error(`Fenêtre --ad invalide: "${s}-${e}" (attendu start-end, ex. 2:05-2:35)`);
          process.exit(2);
        }
        opts.ads.push({ start, end });
        break;
      }
      case "--help": case "-h":
        console.log("Usage: node tools/capture-logs.mjs --url <video> [--ad start-end ...] [--seconds N] [--out file] [--seek-lead 30] [--grace 2] [--headless]");
        process.exit(0);
        break;
      default:
        console.error(`Argument inconnu: ${a}`);
        process.exit(2);
    }
  }
  // Fenêtres par défaut pour la vidéo de référence si aucun --ad fourni.
  // --passive force la capture depuis le début (pas de seek, pas de fenêtre).
  if (!opts.passive && opts.ads.length === 0 && opts.url === TEST_VIDEO_URL) {
    opts.ads = DEFAULT_ADS.map((a) => ({ ...a }));
  }
  if (opts.passive) opts.ads = [];
  opts.ads.sort((x, y) => x.start - y.start);
  return opts;
}

/* --------------------------------------------------------------------- */
/*  Classification des messages console                                   */
/* --------------------------------------------------------------------- */

const DETECTION_PATTERNS = [
  { kind: "skip",          re: /Skip appliqué/ },
  { kind: "segment-ocr",   re: /Segment OCR ajouté/ }
];

/** Détermine si un message console signale une détection positive. */
function classifyDetection(text, argsValues) {
  for (const { kind, re } of DETECTION_PATTERNS) {
    if (re.test(text)) return { kind, detail: text };
  }
  // "AheadScanner: frame analysée" avec keyword:true = match OCR look-ahead.
  if (/frame analysée/.test(text)) {
    const obj = argsValues.find((v) => v && typeof v === "object" && "keyword" in v);
    if (obj && obj.keyword === true) {
      return { kind: "ocr-keyword", detail: `matched=${JSON.stringify(obj.matched)} lead=${obj.lead}` };
    }
  }
  return null;
}

/** Extrait l'objet heartbeat (compteurs pipeline) d'un message console. */
function extractHeartbeat(text, argsValues) {
  if (!/AheadScanner heartbeat/.test(text)) return null;
  return argsValues.find(
    (v) => v && typeof v === "object" && "mediaSegmentsReceived" in v
  ) ?? null;
}

/* --------------------------------------------------------------------- */
/*  Contrôle de la lecture YouTube (exécuté dans la page)                 */
/* --------------------------------------------------------------------- */

async function getCurrentTime(page) {
  return page.evaluate(() => {
    // Source de vérité = l'API du lecteur (temps du CONTENU, pas d'une preview).
    const p = document.querySelector("#movie_player");
    if (p && typeof p.getCurrentTime === "function") {
      const t = p.getCurrentTime();
      if (Number.isFinite(t)) return t;
    }
    const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
    return v && Number.isFinite(v.currentTime) ? v.currentTime : null;
  }).catch(() => null);
}

async function seekTo(page, t) {
  await page.evaluate((target) => {
    const player = document.querySelector("#movie_player");
    if (player && typeof player.seekTo === "function") {
      player.seekTo(target, true);
    }
    const v = document.querySelector("video.html5-main-video, video");
    if (v) { v.currentTime = target; v.play?.().catch(() => {}); }
  }, t).catch(() => {});
}

async function ensurePlaying(page) {
  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    player?.playVideo?.();
    const v = document.querySelector("video.html5-main-video, video");
    v?.play?.().catch(() => {});
  }).catch(() => {});
}

async function isAdShowing(page) {
  return page.evaluate(() => {
    const p = document.querySelector("#movie_player");
    return !!(p && p.classList.contains("ad-showing"));
  }).catch(() => false);
}

/** Attend/skippe les pubs servies par YouTube (celles qui resettent le seek). */
async function handleAds(page, maxWaitMs = 60000) {
  const deadline = Date.now() + maxWaitMs;
  let sawAd = false;
  while (Date.now() < deadline) {
    if (!(await isAdShowing(page))) return sawAd;
    sawAd = true;
    await page.evaluate(() => {
      const b = document.querySelector(
        ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button"
      );
      b?.click();
    }).catch(() => {});
    await sleep(1000);
  }
  return sawAd;
}

/** Seek + confirmation que le playhead a bien atterri (retries si pub/reset). */
async function seekAndConfirm(page, target) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await handleAds(page);
    await seekTo(page, target);
    await ensurePlaying(page);
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await isAdShowing(page)) break; // pub interrompt → on retente au tour suivant
      const ct = await getCurrentTime(page);
      if (ct !== null && ct >= target - 5 && ct <= target + 25) return true;
    }
  }
  return false;
}

async function dismissConsent(page) {
  // Best-effort : bannière de consentement UE. Persiste ensuite via le profil.
  try {
    const btn = page.getByRole("button", { name: /tout accepter|accept all|j'accepte|agree/i }).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
    }
  } catch { /* ignore */ }
}

/* --------------------------------------------------------------------- */
/*  Enregistrement des logs                                               */
/* --------------------------------------------------------------------- */

/** Collecte tout ce que le run produit : JSONL, compteurs, détections. */
function createRecorder(outPath) {
  const stream = createWriteStream(outPath, { flags: "w" });

  return {
    outPath,
    detections: [],   // { atWall, kind, detail }
    lastHeartbeat: null,
    heartbeatCount: 0,
    totalEntries: 0,
    bySource: Object.create(null),
    errors: [],

    /**
     * `entry.ts` l'emporte quand l'appelant connaît la date d'émission : le
     * déballage des arguments d'un message console fait un aller-retour vers
     * le navigateur, donc l'heure d'écriture n'est pas l'heure d'émission.
     */
    write(entry) {
      stream.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
    },

    noteError(message, source = "harness") {
      this.errors.push(message);
      this.write({ source, level: "error", text: message });
    },

    close() {
      stream.end();
    }
  };
}

/** Branche la console de tous les contextes (page + iframes sandbox). */
function attachLogging(page, recorder) {
  page.on("console", async (msg) => {
    // Pris AVANT tout await : c'est ce qui attribue une détection à une fenêtre
    // de pub, et le déballage ci-dessous coûte un aller-retour CDP.
    const emittedAt = Date.now();
    const text = msg.text();
    let argsValues = [];
    try {
      argsValues = await Promise.all(
        msg.args().map((handle) => handle.jsonValue().catch(() => undefined))
      );
    } catch { /* args non sérialisables */ }

    const frameUrl = msg.location?.()?.url ?? "";
    let source = "page";
    if (/decoder-sandbox/.test(frameUrl)) source = "decoder-sandbox";
    else if (/ocr-sandbox/.test(frameUrl)) source = "ocr-sandbox";

    recorder.write({ ts: emittedAt, source, level: msg.type(), text, args: argsValues });
    recorder.totalEntries++;
    recorder.bySource[source] = (recorder.bySource[source] ?? 0) + 1;

    const detection = classifyDetection(text, argsValues);
    if (detection) recorder.detections.push({ atWall: emittedAt, ...detection });

    const heartbeat = extractHeartbeat(text, argsValues);
    if (heartbeat) {
      recorder.lastHeartbeat = heartbeat;
      recorder.heartbeatCount++;
    }
  });

  page.on("pageerror", (err) => recorder.noteError(err.message, "page"));
  page.on("crash", () => recorder.noteError("PAGE CRASH (renderer gone)", "page"));

  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!/tessdata|traineddata|googlevideo|\.m4s|videoplayback/.test(url)) return;
    recorder.write({
      source: "network",
      level: "requestfailed",
      text: `${req.failure()?.errorText ?? "?"} ${url}`
    });
  });
}

/* --------------------------------------------------------------------- */
/*  Lancement du navigateur                                               */
/* --------------------------------------------------------------------- */

async function launchBrowser(opts) {
  const extensionArgs = opts.noExtension ? [] : [
    `--disable-extensions-except=${REPO_ROOT}`,
    `--load-extension=${REPO_ROOT}`
  ];
  if (opts.noExtension) console.log("⚠ Mode --no-extension : extension NON chargée (diagnostic).");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    // Chromium fourni par `npx playwright install chromium` (pas le Brave snap,
    // dont le confinement casserait --load-extension + profil custom).
    viewport: { width: 1280, height: 800 },
    // Anti-détection : sans --enable-automation, navigator.webdriver reste false,
    // ce qui évite que YouTube (BotGuard) flague la session et 403 le flux vidéo.
    ignoreDefaultArgs: ["--enable-automation"],
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    args: [
      ...extensionArgs,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      // Empêche Chromium de throttler les setInterval (heartbeat 5s, scan) quand
      // la fenêtre n'est pas au premier plan — sinon le pipeline semble "muet".
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    ]
  }).catch((err) => {
    console.error("Échec du lancement de Chromium avec l'extension :", err.message);
    console.error("Astuce : `cd tools && npm install && npx playwright install chromium`.");
    process.exit(1);
  });

  // Masque les derniers indices d'automatisation avant tout script de page.
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch { /* ignore */ }
  }).catch(() => {});

  return context;
}

/* --------------------------------------------------------------------- */
/*  Modes à sortie immédiate                                              */
/* --------------------------------------------------------------------- */

/**
 * Ouvre YouTube et attend que l'utilisateur se connecte (avatar présent).
 * Le profil persistant conserve ensuite la session.
 */
async function runLoginMode(page) {
  console.log("\n🔑 Mode --login : connecte-toi à YouTube dans la fenêtre ouverte.");
  console.log("   (détection auto de la connexion, sinon fermeture auto dans 5 min)");

  await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  const deadline = Date.now() + 300000;
  let signedIn = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    signedIn = await page
      .evaluate(() => !!document.querySelector("#avatar-btn, ytd-topbar-menu-button-renderer #avatar"))
      .catch(() => false);
    if (signedIn) break;
  }

  console.log(signedIn
    ? "✅ Connexion détectée — session enregistrée dans le profil."
    : "⏱ Délai écoulé (session enregistrée si tu t'es connecté).");
  await sleep(3000);

  return signedIn;
}

/** Seek au timestamp voulu, laisse s'afficher, capture la frame. */
async function runScreenshotMode(page, opts, stamp) {
  await seekAndConfirm(page, opts.screenshot);
  await sleep(2500);

  const shotPath = join(LOGS_DIR, `frame-${Math.round(opts.screenshot)}s-${stamp}.png`);
  await page.screenshot({ path: shotPath });
  console.log(`Capture: ${shotPath}`);
}

/* --------------------------------------------------------------------- */
/*  Jugement d'une fenêtre de pub                                         */
/* --------------------------------------------------------------------- */

/**
 * Verdict d'une fenêtre à partir des signaux observés depuis le seek.
 * Un skip prime sur une simple détection.
 */
function judge(windowDetections, playhead, { reachedEnd }) {
  const skips = windowDetections.filter((d) => d.kind === "skip");

  if (skips.length) {
    return {
      verdict: "SKIP",
      detail: { ct: playhead, kind: "skip", detail: reachedEnd ? `${skips.length} skip(s)` : skips[0].detail }
    };
  }
  if (windowDetections.length) {
    return {
      verdict: reachedEnd ? "DÉTECTÉ (sans skip)" : "HIT",
      detail: { ct: playhead, kind: windowDetections[0].kind, detail: windowDetections[0].detail }
    };
  }
  return reachedEnd ? { verdict: "MISS", detail: { ct: playhead } } : null;
}

/**
 * Amène la lecture sur une fenêtre de pub et observe jusqu'à un verdict.
 *
 * En mode normal on s'arrête au premier signal ; en `--full-window` on laisse
 * jouer toute la fenêtre pour compter tous les sauts et juger la couverture.
 */
async function judgeAdWindow(page, ad, opts, recorder, globalDeadline) {
  const { start, end } = ad;
  const seekTarget = Math.max(0, start - opts.seekLead);

  if (opts.noSeek) {
    console.log(`\n▶ Pub [${start}-${end}s] — lecture continue (--no-seek), on attend que le playhead y arrive…`);
    // Absorbe la/les pub(s) YouTube pré-roll avant de compter le temps.
    if (await handleAds(page, 90000)) console.log("  ⏭ pub YouTube pré-roll passée.");
    await ensurePlaying(page);
  } else {
    console.log(`\n⏩ Pub [${start}-${end}s] — seek à ${seekTarget}s…`);
    const landed = await seekAndConfirm(page, seekTarget);
    if (!landed) console.log("  ⚠ seek non confirmé (pub persistante ?) — observation quand même.");
  }

  const observeStart = Date.now();
  let lastProgressWall = Date.now();
  let lastCt = await getCurrentTime(page);

  while (Date.now() < globalDeadline) {
    await sleep(500);
    const ct = await getCurrentTime(page);
    const windowDetections = recorder.detections.filter((d) => d.atWall >= observeStart);

    if (!opts.fullWindow) {
      const early = judge(windowDetections, ct, { reachedEnd: false });
      if (early) return early;
    }

    if (ct !== null && ct > end + opts.grace) {
      return judge(windowDetections, ct, { reachedEnd: true });
    }

    // Pub YouTube en cours : on la passe. Le playhead du contenu ne bouge pas
    // pendant une pub → ne pas compter ça comme un blocage.
    if (await isAdShowing(page)) {
      await handleAds(page);
      await ensurePlaying(page);
      lastProgressWall = Date.now();
      lastCt = await getCurrentTime(page);
      continue;
    }

    // Mode seek uniquement : lecture réinitialisée sous la fenêtre → re-seek.
    if (!opts.noSeek && ct !== null && ct < seekTarget - 10) {
      console.log(`  ↻ reset détecté (t=${ct}s) — re-seek à ${seekTarget}s…`);
      await seekAndConfirm(page, seekTarget);
      lastProgressWall = Date.now();
      lastCt = await getCurrentTime(page);
      continue;
    }

    if (ct !== null && lastCt !== null && ct > lastCt + 0.3) {
      lastProgressWall = Date.now();
      lastCt = ct;
    }

    // STALLED : aucune progression du playhead depuis 45s malgré tout.
    if (Date.now() - lastProgressWall > 45000) {
      return {
        verdict: ct !== null && ct > end ? "MISS" : "STALLED",
        detail: { ct }
      };
    }
  }

  return { verdict: "TIMEOUT", detail: {} };
}

/** Traite les fenêtres l'une après l'autre ; s'arrête après la dernière. */
async function judgeAllAdWindows(page, opts, recorder, globalDeadline) {
  const verdicts = [];

  for (const ad of opts.ads) {
    const { verdict, detail } = await judgeAdWindow(page, ad, opts, recorder, globalDeadline);
    verdicts.push({ ...ad, verdict, ...detail });

    const positive = verdict === "HIT" || verdict === "SKIP" || verdict.startsWith("DÉTECTÉ");
    const line = positive
      ? `✅ ${verdict} pub[${ad.start}-${ad.end}] — ${detail.kind ?? ""}${detail.detail ? ` (${detail.detail})` : ""} @playhead=${detail.ct ?? "?"}s`
      : `❌ ${verdict} pub[${ad.start}-${ad.end}] — playhead=${detail.ct ?? "?"}s sans détection`;
    console.log(line);
    recorder.write({ source: "harness", level: "verdict", text: line, ad, verdict });
  }

  return verdicts;
}

/* --------------------------------------------------------------------- */
/*  Résumé stdout                                                         */
/* --------------------------------------------------------------------- */

function printSummary(recorder, verdicts, stopReason) {
  console.log("\n" + "═".repeat(64));
  console.log("RÉSUMÉ");
  console.log("═".repeat(64));
  console.log(`Raison d'arrêt : ${stopReason}`);

  const breakdown = Object.entries(recorder.bySource)
    .map(([source, count]) => `${source}=${count}`).join(", ") || "(aucune)";
  console.log(`Logs capturés  : ${recorder.totalEntries} [${breakdown}]`);

  if (verdicts.length) {
    console.log("\nVerdicts pub :");
    for (const v of verdicts) {
      console.log(`  [${v.start}-${v.end}s] → ${v.verdict}` + (v.kind ? ` (${v.kind})` : ""));
    }
  }

  console.log(`\nHeartbeats reçus : ${recorder.heartbeatCount}`);
  if (recorder.lastHeartbeat) {
    console.log("Dernier heartbeat (état pipeline) :");
    for (const field of [
      "mediaSegmentsReceived", "scansRun", "framesDecoded", "ocrMatches",
      "ocrBackend", "useFallback", "tesseractDisabled", "storeSize", "capturedSegments"
    ]) {
      console.log(`  ${field.padEnd(21)} : ${recorder.lastHeartbeat[field]}`);
    }
  } else {
    console.log("⚠ Aucun heartbeat capturé — l'AheadScanner n'a peut-être pas démarré.");
  }

  const skips = recorder.detections.filter((d) => d.kind === "skip").length;
  const ocrHits = recorder.detections.filter((d) => d.kind === "ocr-keyword").length;
  console.log(`\nSignaux détectés : ${recorder.detections.length} (skips=${skips}, ocr-keyword=${ocrHits})`);

  if (recorder.errors.length) {
    console.log(`\nErreurs (${recorder.errors.length}) :`);
    recorder.errors.slice(0, 5).forEach((e) => console.log(`  - ${e}`));
  }

  console.log(`\nLog complet : ${recorder.outPath}`);
}

/* --------------------------------------------------------------------- */
/*  Programme principal                                                   */
/* --------------------------------------------------------------------- */

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.url) {
    console.error("Aucune URL. Fournis --url <video> (ou renseigne TEST_VIDEO_URL dans le script).");
    process.exit(2);
  }

  mkdirSync(LOGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recorder = createRecorder(opts.out ? resolve(opts.out) : join(LOGS_DIR, `run-${stamp}.jsonl`));

  console.log(`▶ Extension : ${REPO_ROOT}`);
  console.log(`▶ Profil    : ${PROFILE_DIR}`);
  console.log(`▶ Sortie    : ${recorder.outPath}`);
  console.log(`▶ URL       : ${opts.url}`);
  if (opts.ads.length) {
    console.log(`▶ Pubs      : ${opts.ads.map((a) => `${a.start}-${a.end}s`).join(", ")} (seek-lead ${opts.seekLead}s, grâce ${opts.grace}s)`);
  }

  const context = await launchBrowser(opts);
  const page = context.pages()[0] ?? (await context.newPage());
  attachLogging(page, recorder);

  if (opts.login) {
    const signedIn = await runLoginMode(page);
    await context.close().catch(() => {});
    recorder.close();
    process.exit(signedIn ? 0 : 1);
  }

  let verdicts = [];
  let stopReason = "timeout";

  try {
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissConsent(page);

    // Attente du <video> et du démarrage effectif de la lecture.
    await page.waitForSelector("video", { timeout: 30000 });
    await ensurePlaying(page);

    if (opts.screenshot !== null) {
      await runScreenshotMode(page, opts, stamp);
      await context.close().catch(() => {});
      recorder.close();
      process.exit(0);
    }

    const globalDeadline = Date.now() + opts.seconds * 1000;

    if (opts.ads.length === 0) {
      console.log("Aucune fenêtre --ad : capture passive jusqu'au timeout.");
      while (Date.now() < globalDeadline) await sleep(1000);
      stopReason = "timeout";
    } else {
      verdicts = await judgeAllAdWindows(page, opts, recorder, globalDeadline);
      const missed = verdicts.some((v) => v.verdict !== "HIT" && v.verdict !== "SKIP");
      stopReason = missed ? "toutes fenêtres jugées (au moins un MISS)" : "toutes fenêtres HIT";
      if (Date.now() >= globalDeadline) stopReason = "timeout (plafond --seconds atteint)";
    }
  } catch (err) {
    recorder.noteError(err.message);
    stopReason = `erreur: ${err.message}`;
  } finally {
    await context.close().catch(() => {});
    recorder.close();
  }

  printSummary(recorder, verdicts, stopReason);

  // Code retour : non-zéro si erreur ou verdict non concluant (ni HIT ni SKIP).
  const failed = recorder.errors.length > 0 ||
    verdicts.some((v) => v.verdict !== "HIT" && v.verdict !== "SKIP");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
