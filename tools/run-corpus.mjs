#!/usr/bin/env node
/**
 * run-corpus.mjs — rejoue tout le corpus de vidéos annotées.
 *
 * Lit `tools/corpus.json` (source de vérité) et lance `capture-logs.mjs` par
 * vidéo, en série ou en parallèle, puis agrège les verdicts en un tableau.
 *
 * Deux passes très différentes :
 *
 *   Détection    (défaut)        « le mot-clé est-il lu dans la fenêtre ? »
 *                                Robuste à la contention → parallélisable.
 *   Couverture   (--full-window) « quelle part de la pub est sautée ? »
 *                                Dépend du buffer et de la cadence, deux
 *                                ressources que le parallélisme met en
 *                                concurrence → RESTE EN SÉRIE.
 *
 * Usage :
 *   node tools/run-corpus.mjs [--jobs 3] [--full-window] [--seek-lead 45]
 *                             [--only id1,id2] [--seconds N]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(__dirname, "capture-logs.mjs");
const CORPUS = join(__dirname, "corpus.json");
const BASE_PROFILE = join(__dirname, ".profile");
const WORKER_PROFILES = join(__dirname, ".profile-workers");

/* --------------------------------------------------------------------- */
/*  Arguments                                                             */
/* --------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { jobs: 1, fullWindow: false, seekLead: null, seconds: null, only: null };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--jobs": opts.jobs = Number(next()); break;
      case "--full-window": opts.fullWindow = true; break;
      case "--seek-lead": opts.seekLead = Number(next()); break;
      case "--seconds": opts.seconds = Number(next()); break;
      case "--only": opts.only = String(next()).split(",").map((s) => s.trim()); break;
      case "--help": case "-h":
        console.log("Usage: node tools/run-corpus.mjs [--jobs N] [--full-window] [--seek-lead S] [--seconds N] [--only id1,id2]");
        process.exit(0);
        break;
      default:
        console.error(`Argument inconnu: ${flag}`);
        process.exit(2);
    }
  }

  if (!Number.isInteger(opts.jobs) || opts.jobs < 1) {
    console.error(`--jobs invalide : "${opts.jobs}" (entier >= 1 attendu).`);
    process.exit(2);
  }

  // La mesure de couverture porte précisément sur le buffer et la cadence :
  // les faire concourir entre workers la rendrait ininterprétable.
  if (opts.fullWindow && opts.jobs > 1) {
    console.error("--full-window mesure le buffer et la cadence, que le parallélisme");
    console.error("met en concurrence. Utilise --jobs 1 pour cette passe.");
    process.exit(2);
  }

  return opts;
}

/* --------------------------------------------------------------------- */
/*  Profils de worker                                                     */
/* --------------------------------------------------------------------- */

/**
 * Chromium verrouille son dossier de profil : chaque worker a besoin du sien.
 * On clone le profil de référence pour conserver la session YouTube.
 */
function prepareProfiles(jobs) {
  if (jobs === 1) return [null]; // le profil par défaut du harness suffit

  if (!existsSync(BASE_PROFILE)) {
    console.error(`Profil de référence absent : ${BASE_PROFILE}`);
    console.error("Lance un run simple une fois pour le créer (et t'y connecter).");
    process.exit(2);
  }

  rmSync(WORKER_PROFILES, { recursive: true, force: true });
  mkdirSync(WORKER_PROFILES, { recursive: true });

  const profiles = [];
  for (let i = 0; i < jobs; i++) {
    const dir = join(WORKER_PROFILES, `w${i}`);
    cpSync(BASE_PROFILE, dir, { recursive: true });
    profiles.push(dir);
  }
  console.log(`Profils clonés pour ${jobs} workers dans ${WORKER_PROFILES}\n`);
  return profiles;
}

/* --------------------------------------------------------------------- */
/*  Exécution d'une vidéo                                                 */
/* --------------------------------------------------------------------- */

const timecode = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function runVideo(video, opts, profile) {
  const args = [
    CAPTURE,
    "--url", `https://www.youtube.com/watch?v=${video.id}`,
    "--ad", `${video.ad.start}-${video.ad.end}`,
    "--seconds", String(opts.seconds ?? video.seconds)
  ];
  if (opts.fullWindow) args.push("--full-window");
  if (opts.seekLead !== null) args.push("--seek-lead", String(opts.seekLead));
  if (profile) args.push("--profile", profile);

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    child.on("close", (code) => {
      const verdict = output.match(/\[\d+-\d+s\] → (.+?)(?: \(|$)/m)?.[1]?.trim()
        ?? (output.includes("STALLED") ? "STALLED" : "—");
      const skips = Number(output.match(/skips=(\d+)/)?.[1] ?? 0);
      const heartbeat = Object.fromEntries(
        [...output.matchAll(/^ {2}(\w+)\s+: (.+)$/gm)].map(([, k, v]) => [k, v.trim()])
      );
      resolve({
        video, code, verdict, skips,
        seconds: (Date.now() - startedAt) / 1000,
        ocrMatches: Number(heartbeat.ocrMatches ?? 0),
        log: output.match(/Log complet : (\S+)/)?.[1] ?? null,
        output
      });
    });
  });
}

/** Exécute `tasks` avec au plus `jobs` en vol. */
async function runPool(videos, opts, profiles) {
  const results = [];
  const queue = [...videos];
  let done = 0;

  const worker = async (profile) => {
    while (queue.length > 0) {
      const video = queue.shift();
      const result = await runVideo(video, opts, profile);
      results.push(result);
      done++;
      const mark = result.verdict === "SKIP" || result.verdict === "HIT" ? "✅" : "❌";
      console.log(`${mark} [${done}/${videos.length}] ${video.id.padEnd(14)} ${result.verdict.padEnd(20)} ${result.seconds.toFixed(0)}s`);
    }
  };

  await Promise.all(profiles.map(worker));
  return results;
}

/* --------------------------------------------------------------------- */
/*  Résumé                                                                */
/* --------------------------------------------------------------------- */

function printSummary(results, opts, elapsed) {
  const byId = new Map(results.map((r) => [r.video.id, r]));

  console.log("\n" + "═".repeat(78));
  console.log(opts.fullWindow ? "COUVERTURE — part de la pub réellement sautée" : "DÉTECTION — le mot-clé est-il lu dans la fenêtre ?");
  console.log("═".repeat(78));
  console.log(`${"vidéo".padEnd(14)} ${"fenêtre".padEnd(16)} ${"durée".padEnd(6)} ${"verdict".padEnd(20)} ${"sauts".padEnd(6)} OCR`);

  for (const video of results.map((r) => r.video)) {
    const r = byId.get(video.id);
    const window = `${timecode(video.ad.start)}→${timecode(video.ad.end)}`;
    const duration = `${video.ad.end - video.ad.start}s`;
    console.log(`${video.id.padEnd(14)} ${window.padEnd(16)} ${duration.padEnd(6)} ${r.verdict.padEnd(20)} ${String(r.skips).padEnd(6)} ${r.ocrMatches}`);
  }

  const positive = results.filter((r) => r.verdict === "SKIP" || r.verdict === "HIT");
  console.log("═".repeat(78));
  console.log(`  ${positive.length}/${results.length} vidéos détectées · ${(elapsed / 60).toFixed(1)} min · ${opts.jobs} worker(s)`);

  const failed = results.filter((r) => !positive.includes(r));
  if (failed.length) {
    console.log("\n  À relire dans le JSONL avant de conclure à un défaut de détection :");
    for (const r of failed) {
      console.log(`    ${r.video.id}  ${r.verdict}${r.video.note ? `\n        note du corpus : ${r.video.note}` : ""}`);
      if (r.log) console.log(`        ${r.log}`);
    }
  }

  return failed.length === 0;
}

/* --------------------------------------------------------------------- */

async function main() {
  const opts = parseArgs(process.argv);
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));

  let videos = corpus.videos;
  if (opts.only) {
    videos = videos.filter((v) => opts.only.includes(v.id));
    if (videos.length === 0) {
      console.error(`Aucune vidéo du corpus ne correspond à --only ${opts.only.join(",")}.`);
      process.exit(2);
    }
  }

  console.log(`▶ Corpus   : ${videos.length} vidéos (${corpus.annotatedAt})`);
  console.log(`▶ Passe    : ${opts.fullWindow ? "couverture (--full-window, série imposée)" : "détection"}`);
  console.log(`▶ Workers  : ${opts.jobs}`);
  if (opts.seekLead !== null) console.log(`▶ Seek-lead: ${opts.seekLead}s (surcharge globale)`);
  console.log();

  const profiles = prepareProfiles(opts.jobs);
  const startedAt = Date.now();
  const results = await runPool(videos, opts, profiles);

  // Rétablit l'ordre du corpus, que le parallélisme mélange.
  results.sort((a, b) => videos.indexOf(a.video) - videos.indexOf(b.video));

  const allPassed = printSummary(results, opts, (Date.now() - startedAt) / 1000);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
