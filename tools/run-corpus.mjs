#!/usr/bin/env node
/**
 * run-corpus.mjs — rejoue tout le corpus de vidéos annotées.
 *
 * Lit `tools/corpus.json` (source de vérité) et lance `capture-logs.mjs` par
 * vidéo, puis agrège les verdicts en un tableau.
 *
 * Deux passes :
 *
 *   Détection    (défaut)        « le mot-clé est-il lu dans la fenêtre ? »
 *   Couverture   (--full-window) « quelle part de la pub est sautée ? »
 *
 * Les runs restent en série. Le parallélisme a été écarté : la couverture
 * dépend de la profondeur du buffer et de la cadence de scan (DEV-NOTES §4.1),
 * or plusieurs navigateurs simultanés se disputent la bande passante et le CPU
 * — c'est-à-dire précisément ces deux variables. On mesurerait la contention.
 *
 * Usage :
 *   node tools/run-corpus.mjs [--full-window] [--seek-lead 45]
 *                             [--only id1,id2] [--seconds N]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(__dirname, "capture-logs.mjs");
const CORPUS = join(__dirname, "corpus.json");

/* --------------------------------------------------------------------- */
/*  Arguments                                                             */
/* --------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { fullWindow: false, seekLead: null, seconds: null, only: null };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--full-window": opts.fullWindow = true; break;
      case "--seek-lead": opts.seekLead = Number(next()); break;
      case "--seconds": opts.seconds = Number(next()); break;
      case "--only": opts.only = String(next()).split(",").map((s) => s.trim()); break;
      case "--help": case "-h":
        console.log("Usage: node tools/run-corpus.mjs [--full-window] [--seek-lead S] [--seconds N] [--only id1,id2]");
        process.exit(0);
        break;
      default:
        console.error(`Argument inconnu: ${flag}`);
        process.exit(2);
    }
  }



  return opts;
}

/* --------------------------------------------------------------------- */
/*  Exécution d'une vidéo                                                 */
/* --------------------------------------------------------------------- */

const timecode = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function runVideo(video, opts) {
  const args = [
    CAPTURE,
    "--url", `https://www.youtube.com/watch?v=${video.id}`,
    "--ad", `${video.ad.start}-${video.ad.end}`,
    "--seconds", String(opts.seconds ?? video.seconds)
  ];
  if (opts.fullWindow) args.push("--full-window");
  if (opts.seekLead !== null) args.push("--seek-lead", String(opts.seekLead));

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

async function runAll(videos, opts) {
  const results = [];

  for (const [index, video] of videos.entries()) {
    const result = await runVideo(video, opts);
    results.push(result);
    const mark = result.verdict === "SKIP" || result.verdict === "HIT" ? "✅" : "❌";
    console.log(`${mark} [${index + 1}/${videos.length}] ${video.id.padEnd(14)} ${result.verdict.padEnd(20)} ${result.seconds.toFixed(0)}s`);
  }

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
  console.log(`  ${positive.length}/${results.length} vidéos détectées · ${(elapsed / 60).toFixed(1)} min`);

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
  console.log(`▶ Passe    : ${opts.fullWindow ? "couverture (--full-window)" : "détection"}`);
  if (opts.seekLead !== null) console.log(`▶ Seek-lead: ${opts.seekLead}s (surcharge globale)`);
  console.log();

  const startedAt = Date.now();
  const results = await runAll(videos, opts);

  const allPassed = printSummary(results, opts, (Date.now() - startedAt) / 1000);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
