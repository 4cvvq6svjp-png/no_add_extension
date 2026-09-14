#!/usr/bin/env node
/**
 * Campagne A/B sur `segmentForwardSeconds`, alternée vidéo par vidéo.
 *
 * Une première tentative — un lot complet à 5, puis un lot complet à 10 — s'est
 * révélée ininterprétable : les conditions réseau avaient dérivé entre les deux
 * lots (8 TIMEOUT contre 2, effondrements de rendition jusqu'en 240p), si bien
 * que l'écart mesuré tenait autant à l'heure de la nuit qu'au réglage.
 *
 * On alterne donc les valeurs SUR LA MÊME VIDÉO, dos à dos : les deux
 * configurations voient la même bande passante, la même rendition, la même
 * session. Ce qui reste d'écart est attribuable au réglage.
 *
 * Usage : node tools/ab-forward.mjs [--values 5,10,12] [--only id1,id2]
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, "capture-logs.mjs");
const CORPUS = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));

function parseArgs(argv) {
  const opts = { values: [5, 10, 12], only: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--values": opts.values = String(argv[++i]).split(",").map(Number); break;
      case "--only": opts.only = String(argv[++i]).split(",").map((s) => s.trim()); break;
      case "--help": case "-h":
        console.log("Usage: node tools/ab-forward.mjs [--values 5,10,12] [--only id1,id2]");
        process.exit(0);
        break;
      default:
        console.error(`Argument inconnu: ${argv[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

function runOnce(video, forward) {
  const args = [
    CAPTURE,
    "--url", `https://www.youtube.com/watch?v=${video.id}`,
    "--ad", `${video.ad.start}-${video.ad.end}`,
    "--seconds", String(video.seconds),
    "--full-window",
    "--forward", String(forward)
  ];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: join(HERE, "..") });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", () => {
      const verdict = /^(?:✅|❌)\s*(\w+)/m.exec(output)?.[1] ?? "?";
      resolve(verdict);
    });
  });
}

const opts = parseArgs(process.argv);
const videos = CORPUS.videos.filter((v) => !opts.only || opts.only.includes(v.id));

console.log(`▶ A/B alterné : ${videos.length} vidéos × ${opts.values.join("/")}s de projection\n`);

for (const [index, video] of videos.entries()) {
  for (const forward of opts.values) {
    const started = Date.now();
    const verdict = await runOnce(video, forward);
    const seconds = Math.round((Date.now() - started) / 1000);
    const mark = verdict === "SKIP" ? "✅" : "❌";
    console.log(`${mark} [${index + 1}/${videos.length}] ${video.id.padEnd(13)} forward=${String(forward).padEnd(3)} ${verdict.padEnd(8)} ${seconds}s`);
  }
}

console.log(`\nMesure : node tools/ad-seen.mjs --last ${videos.length * opts.values.length} --by-forward`);
