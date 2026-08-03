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

/* --------------------------------------------------------------------- */
/*  Parsing des arguments                                                 */
/* --------------------------------------------------------------------- */

function parseTimecode(str) {
  // Accepte "125", "2:05", "1:02:05".
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
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
      case "--url": opts.url = next(); break;
      case "--seconds": opts.seconds = Number(next()); break;
      case "--seek-lead": opts.seekLead = Number(next()); break;
      case "--grace": opts.grace = Number(next()); break;
      case "--out": opts.out = next(); break;
      case "--headless": opts.headless = true; break;
      case "--no-extension": opts.noExtension = true; break;
      case "--passive": opts.passive = true; break;
      case "--login": opts.login = true; break;
      case "--no-seek": opts.noSeek = true; break;
      case "--full-window": opts.fullWindow = true; break;
      case "--screenshot": opts.screenshot = parseTimecode(next()); break;
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
  { kind: "overlay-dom",   re: /Overlay commercial détecté/ },
  { kind: "segment-ocr",   re: /Segment OCR ajouté/ },
  { kind: "segment-overlay", re: /Segment overlay ajouté/ }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const outPath = opts.out ? resolve(opts.out) : join(LOGS_DIR, `run-${stamp}.jsonl`);
  const out = createWriteStream(outPath, { flags: "w" });

  const write = (entry) => out.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");

  // État partagé alimenté par le handler console.
  const detections = []; // { atWall, kind, detail }
  let lastHeartbeat = null;
  let heartbeatCount = 0;
  let totalEntries = 0;
  const bySource = Object.create(null);
  const errors = [];

  console.log(`▶ Extension : ${REPO_ROOT}`);
  console.log(`▶ Profil    : ${PROFILE_DIR}`);
  console.log(`▶ Sortie    : ${outPath}`);
  console.log(`▶ URL       : ${opts.url}`);
  if (opts.ads.length) {
    console.log(`▶ Pubs      : ${opts.ads.map((a) => `${a.start}-${a.end}s`).join(", ")} (seek-lead ${opts.seekLead}s, grâce ${opts.grace}s)`);
  }

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

  // Capture de la console de tous les contextes (page + frames enfants).
  const attachConsole = (source) => async (msg) => {
    const text = msg.text();
    let argsValues = [];
    try {
      argsValues = await Promise.all(
        msg.args().map((h) => h.jsonValue().catch(() => undefined))
      );
    } catch { /* args non sérialisables */ }

    const loc = msg.location?.() ?? {};
    const frameUrl = loc.url || "";
    let frameLabel = source;
    if (/decoder-sandbox/.test(frameUrl)) frameLabel = "decoder-sandbox";
    else if (/ocr-sandbox/.test(frameUrl)) frameLabel = "ocr-sandbox";
    else if (/youtube\.com/.test(frameUrl)) frameLabel = "page";

    write({ source: frameLabel, level: msg.type(), text, args: argsValues });
    totalEntries++;
    bySource[frameLabel] = (bySource[frameLabel] ?? 0) + 1;

    const det = classifyDetection(text, argsValues);
    if (det) detections.push({ atWall: Date.now(), ...det });

    const hb = extractHeartbeat(text, argsValues);
    if (hb) { lastHeartbeat = hb; heartbeatCount++; }
  };

  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", attachConsole("page"));
  page.on("pageerror", (err) => {
    errors.push(err.message);
    write({ source: "page", level: "pageerror", text: err.message });
  });
  page.on("crash", () => {
    errors.push("PAGE CRASH (renderer gone)");
    write({ source: "page", level: "crash", text: "PAGE CRASH (renderer gone)" });
  });
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (/tessdata|traineddata|googlevideo|\.m4s|videoplayback/.test(url)) {
      write({ source: "network", level: "requestfailed", text: `${req.failure()?.errorText ?? "?"} ${url}` });
    }
  });

  // Service worker (aujourd'hui muet, mais on branche ce qu'on peut).
  const attachWorker = (worker) => {
    write({ source: "service-worker", level: "info", text: `worker: ${worker.url()}` });
    try { worker.on("console", attachConsole("service-worker")); } catch { /* non supporté selon version */ }
  };
  context.serviceWorkers().forEach(attachWorker);
  context.on("serviceworker", attachWorker);

  // Mode connexion : ouvre YouTube, attend que l'utilisateur se connecte
  // (avatar présent), puis ferme. Le profil persistant conserve la session.
  if (opts.login) {
    console.log("\n🔑 Mode --login : connecte-toi à YouTube dans la fenêtre ouverte.");
    console.log("   (détection auto de la connexion, sinon fermeture auto dans 5 min)");
    await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    const loginDeadline = Date.now() + 300000;
    let signedIn = false;
    while (Date.now() < loginDeadline) {
      await sleep(3000);
      signedIn = await page.evaluate(() => !!document.querySelector("#avatar-btn, ytd-topbar-menu-button-renderer #avatar")).catch(() => false);
      if (signedIn) break;
    }
    console.log(signedIn ? "✅ Connexion détectée — session enregistrée dans le profil." : "⏱ Délai écoulé (session enregistrée si tu t'es connecté).");
    await sleep(3000);
    await context.close().catch(() => {});
    out.end();
    process.exit(signedIn ? 0 : 1);
  }

  let stopReason = "timeout";

  try {
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissConsent(page);

    // Attente du <video> et du démarrage effectif de la lecture.
    await page.waitForSelector("video", { timeout: 30000 });
    await ensurePlaying(page);

    // Mode capture : seek au timestamp voulu, laisse s'afficher, screenshot.
    if (opts.screenshot !== null) {
      await seekAndConfirm(page, opts.screenshot);
      await sleep(2500);
      const shotPath = join(LOGS_DIR, `frame-${Math.round(opts.screenshot)}s-${stamp}.png`);
      await page.screenshot({ path: shotPath });
      console.log(`Capture: ${shotPath}`);
      await context.close().catch(() => {});
      out.end();
      process.exit(0);
    }

    const globalDeadline = Date.now() + opts.seconds * 1000;

    if (opts.ads.length === 0) {
      // Pas d'annotation : capture passive jusqu'au plafond.
      console.log("Aucune fenêtre --ad : capture passive jusqu'au timeout.");
      while (Date.now() < globalDeadline) await sleep(1000);
      stopReason = "timeout";
    } else {
      // Traitement séquentiel des fenêtres de pub, avec seek + verdict.
      const verdicts = [];
      let missed = false;

      for (let idx = 0; idx < opts.ads.length; idx++) {
        const { start, end } = opts.ads[idx];
        const seekTarget = Math.max(0, start - opts.seekLead);
        if (opts.noSeek) {
          console.log(`\n▶ Pub ${idx + 1}/${opts.ads.length} [${start}-${end}s] — lecture continue (--no-seek), on attend que le playhead y arrive…`);
          // Absorbe la/les pub(s) YouTube pré-roll avant de compter le temps.
          if (await handleAds(page, 90000)) console.log("  ⏭ pub YouTube pré-roll passée.");
          await ensurePlaying(page);
        } else {
          console.log(`\n⏩ Pub ${idx + 1}/${opts.ads.length} [${start}-${end}s] — seek à ${seekTarget}s…`);
          const landed = await seekAndConfirm(page, seekTarget);
          if (!landed) console.log("  ⚠ seek non confirmé (pub persistante ?) — observation quand même.");
        }

        const observeStart = Date.now();
        let verdict = null;
        let detailAt = null;
        let lastProgressWall = Date.now();
        let lastCt = await getCurrentTime(page);

        // On observe jusqu'à ce que le playhead dépasse end+grace, ou détection.
        while (Date.now() < globalDeadline) {
          await sleep(500);
          const ct = await getCurrentTime(page);

          // Signaux de détection attribués à cette fenêtre (depuis le seek).
          const windowDetections = detections.filter((d) => d.atWall >= observeStart);
          const skipSigs = windowDetections.filter((d) => d.kind === "skip");
          // Mode normal : on s'arrête au 1er signal (skip prioritaire = SKIP,
          // sinon HIT). Mode --full-window : on NE s'arrête PAS, on laisse jouer
          // toute la fenêtre pour compter tous les skips et juger la couverture.
          if (!opts.fullWindow) {
            if (skipSigs.length) {
              verdict = "SKIP";
              detailAt = { ct, kind: "skip", detail: skipSigs[0].detail };
              break;
            }
            if (windowDetections.length > 0) {
              verdict = "HIT";
              detailAt = { ct, kind: windowDetections[0].kind, detail: windowDetections[0].detail };
              break;
            }
          }
          if (ct !== null && ct > end + opts.grace) {
            if (skipSigs.length) {
              verdict = "SKIP";
              detailAt = { ct, kind: "skip", detail: `${skipSigs.length} skip(s)` };
            } else if (windowDetections.length) {
              verdict = "DÉTECTÉ (sans skip)";
              detailAt = { ct, kind: windowDetections[0].kind, detail: windowDetections[0].detail };
            } else {
              verdict = "MISS";
              detailAt = { ct };
            }
            break;
          }
          // Pub YouTube en cours : on la passe. Le playhead du contenu ne bouge
          // pas pendant une pub → ne pas compter ça comme un blocage.
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
          // Progression réelle ? (sinon on considère bloqué)
          if (ct !== null && lastCt !== null && ct > lastCt + 0.3) {
            lastProgressWall = Date.now();
            lastCt = ct;
          }
          // STALLED : aucune progression du playhead depuis 45s malgré tout.
          if (Date.now() - lastProgressWall > 45000) {
            verdict = ct !== null && ct > end ? "MISS" : "STALLED";
            detailAt = { ct };
            break;
          }
        }
        if (verdict === null) verdict = "TIMEOUT";

        verdicts.push({ start, end, verdict, ...detailAt });
        const positive = verdict === "HIT" || verdict === "SKIP" || verdict.startsWith("DÉTECTÉ");
        const line = positive
          ? `✅ ${verdict} pub[${start}-${end}] — ${detailAt?.kind ?? ""}${detailAt?.detail ? ` (${detailAt.detail})` : ""} @playhead=${detailAt?.ct ?? "?"}s`
          : `❌ ${verdict} pub[${start}-${end}] — playhead=${detailAt?.ct ?? "?"}s sans détection`;
        console.log(line);
        write({ source: "harness", level: "verdict", text: line, ad: { start, end }, verdict });

        if (verdict !== "HIT" && verdict !== "SKIP") missed = true;
        // Dès qu'une fenêtre est jugée on passe à la suivante (seek) : on ne
        // laisse jamais la vidéo tourner inutilement.
      }

      opts._verdicts = verdicts;
      // Toutes les fenêtres jugées → on s'arrête, sans attendre --seconds.
      stopReason = missed ? "toutes fenêtres jugées (au moins un MISS)" : "toutes fenêtres HIT";
      if (Date.now() >= globalDeadline) stopReason = "timeout (plafond --seconds atteint)";
    }
  } catch (err) {
    errors.push(err.message);
    write({ source: "harness", level: "error", text: err.message });
    stopReason = `erreur: ${err.message}`;
  } finally {
    await context.close().catch(() => {});
    out.end();
  }

  /* ----------------------------------------------------------------- */
  /*  Résumé stdout                                                     */
  /* ----------------------------------------------------------------- */
  console.log("\n" + "═".repeat(64));
  console.log("RÉSUMÉ");
  console.log("═".repeat(64));
  console.log(`Raison d'arrêt : ${stopReason}`);

  const sourceBreakdown = Object.entries(bySource)
    .map(([s, n]) => `${s}=${n}`).join(", ") || "(aucune)";
  console.log(`Logs capturés  : ${totalEntries} [${sourceBreakdown}]`);

  if (opts._verdicts?.length) {
    console.log("\nVerdicts pub :");
    for (const v of opts._verdicts) {
      console.log(`  [${v.start}-${v.end}s] → ${v.verdict}` + (v.kind ? ` (${v.kind})` : ""));
    }
  }

  console.log(`\nHeartbeats reçus : ${heartbeatCount}`);
  if (lastHeartbeat) {
    const h = lastHeartbeat;
    console.log("Dernier heartbeat (état pipeline) :");
    console.log(`  mediaSegmentsReceived : ${h.mediaSegmentsReceived}`);
    console.log(`  scansRun              : ${h.scansRun}`);
    console.log(`  framesDecoded         : ${h.framesDecoded}`);
    console.log(`  ocrMatches            : ${h.ocrMatches}`);
    console.log(`  ocrBackend            : ${h.ocrBackend}`);
    console.log(`  useFallback           : ${h.useFallback}`);
    console.log(`  tesseractDisabled     : ${h.tesseractDisabled}`);
    console.log(`  storeSize             : ${h.storeSize}`);
    console.log(`  capturedSegments      : ${h.capturedSegments}`);
  } else {
    console.log("⚠ Aucun heartbeat capturé — l'AheadScanner n'a peut-être pas démarré.");
  }

  const skips = detections.filter((d) => d.kind === "skip").length;
  const ocrHits = detections.filter((d) => d.kind === "ocr-keyword").length;
  console.log(`\nSignaux détectés : ${detections.length} (skips=${skips}, ocr-keyword=${ocrHits})`);
  if (errors.length) {
    console.log(`\nErreurs (${errors.length}) :`);
    errors.slice(0, 5).forEach((e) => console.log(`  - ${e}`));
  }
  console.log(`\nLog complet : ${outPath}`);

  // Code retour : non-zéro si erreur ou verdict non concluant (ni HIT ni SKIP).
  const failed = errors.length > 0 ||
    opts._verdicts?.some((v) => v.verdict !== "HIT" && v.verdict !== "SKIP");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
