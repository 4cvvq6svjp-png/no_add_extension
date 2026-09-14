#!/usr/bin/env node
/**
 * Mesure ce que coûte une pub à l'utilisateur, à partir des JSONL du harness.
 *
 * « Pub vue » = la part de la fenêtre annotée que le playhead a réellement
 * traversée, c'est-à-dire sa durée moins ce que les sauts lui ont retiré.
 * Elle est décomposée en trois postes, parce qu'ils ne se corrigent pas avec
 * les mêmes réglages :
 *
 *   tête    avant le premier saut  — latence de détection
 *   milieu  entre deux sauts       — coût de reconfirmation, ~1,6s par saut
 *   queue   après le dernier saut  — la sonde s'est arrêtée avant la fin
 *
 * Et « débord » = où atterrit le dernier saut par rapport à la fin de pub
 * annotée. Positif, on a mangé du contenu légitime ; négatif, on a laissé voir
 * de la pub.
 *
 * Usage : node tools/ad-seen.mjs [--last N] [--label texte]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");

function parseArgs(argv) {
  const opts = { last: 10, label: null, byForward: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--last": opts.last = Number(argv[++i]); break;
      case "--label": opts.label = String(argv[++i]); break;
      case "--by-forward": opts.byForward = true; break;
      case "--help": case "-h":
        console.log("Usage: node tools/ad-seen.mjs [--last N] [--label texte] [--by-forward]");
        process.exit(0);
        break;
      default:
        console.error(`Argument inconnu: ${argv[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

function recentRuns(count) {
  return readdirSync(LOGS)
    .filter((f) => f.startsWith("run-") && f.endsWith(".jsonl"))
    .map((f) => join(LOGS, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, count)
    .reverse();
}

/** Extrait fenêtre, verdict et sauts d'un JSONL de run. */
function readRun(file) {
  let window = null;
  let verdict = null;
  let forward = null;
  const skips = [];

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.level === "config") forward = entry.forward;
    if (entry.ad) {
      window = [entry.ad.start, entry.ad.end];
      verdict = entry.verdict;
    }
    const skip = /Skip appliqué \{from: ([\d.]+), to: ([\d.]+)/.exec(entry.text ?? "");
    if (skip) skips.push([Number(skip[1]), Number(skip[2])]);
  }

  return { window, verdict, forward, skips };
}

/** Intervalles sautés à l'intérieur de la fenêtre, fusionnés et ordonnés. */
function skippedInsideWindow(skips, [start, end]) {
  const clipped = skips
    .map(([from, to]) => [Math.max(from, start), Math.min(to, end)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [from, to] of clipped) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function measure(run) {
  const [start, end] = run.window;
  const merged = skippedInsideWindow(run.skips, run.window);
  if (!merged.length) return null;

  let middle = 0;
  for (let i = 0; i < merged.length - 1; i++) {
    middle += Math.max(0, merged[i + 1][0] - merged[i][1]);
  }

  return {
    duration: end - start,
    head: Math.max(0, merged[0][0] - start),
    middle,
    tail: Math.max(0, end - merged[merged.length - 1][1]),
    skips: run.skips.length,
    // Débord du dernier saut : positif = contenu légitime mangé.
    overshoot: run.skips[run.skips.length - 1][1] - end
  };
}

const opts = parseArgs(process.argv);
const measured = [];

for (const file of recentRuns(opts.last)) {
  const run = readRun(file);
  if (!run.window || run.verdict !== "SKIP") continue;
  const m = measure(run);
  if (m) measured.push({ window: run.window, forward: run.forward, ...m });
}

if (!measured.length) {
  console.error("Aucun run exploitable (il faut des verdicts SKIP avec au moins un saut).");
  process.exit(1);
}

function summarize(rows) {
  const sum = (pick) => rows.reduce((total, m) => total + pick(m), 0);
  const seen = sum((m) => m.head + m.middle + m.tail);
  const overshoots = rows.map((m) => m.overshoot).sort((a, b) => a - b);
  const lost = overshoots.filter((o) => o > 0);

  return {
    count: rows.length,
    adTotal: sum((m) => m.duration),
    seen,
    head: sum((m) => m.head),
    middle: sum((m) => m.middle),
    tail: sum((m) => m.tail),
    skips: sum((m) => m.skips),
    median: overshoots[Math.floor(overshoots.length / 2)],
    maxOvershoot: overshoots[overshoots.length - 1],
    lostCount: lost.length,
    lostTotal: lost.reduce((total, o) => total + o, 0)
  };
}

function printGroup(title, rows) {
  const s = summarize(rows);
  console.log(`\n▶ ${title}`);
  console.log(`  ${s.count} pubs · ${s.adTotal.toFixed(0)}s de pub · ${s.seen.toFixed(1)}s vues · ${(100 * (1 - s.seen / s.adTotal)).toFixed(1)} % sautée`);
  console.log(`  tête ${s.head.toFixed(1)}s · milieu ${s.middle.toFixed(1)}s · queue ${s.tail.toFixed(1)}s`);
  console.log(`  pub vue moyenne ${(s.seen / s.count).toFixed(1)}s · ${s.skips} sauts · ${(s.middle / s.skips).toFixed(2)}s par saut`);
  console.log(`  CONTENU LÉGITIME PERDU : ${s.lostCount}/${s.count} runs · ${s.lostTotal.toFixed(1)}s au total · pire +${Math.max(0, s.maxOvershoot).toFixed(1)}s`);
}

if (!opts.byForward) {
  if (opts.label) console.log(`\n▶ ${opts.label}`);
  console.log(`\n${"fenêtre".padStart(13)} ${"tête".padStart(7)} ${"milieu".padStart(8)} ${"queue".padStart(7)} ${"vue".padStart(7)} ${"sauts".padStart(6)} ${"débord".padStart(8)}`);
  console.log("-".repeat(62));
  for (const m of measured) {
    console.log([
      `[${m.window[0]}-${m.window[1]}]`.padStart(13),
      `${m.head.toFixed(1)}s`.padStart(7),
      `${m.middle.toFixed(1)}s`.padStart(8),
      `${m.tail.toFixed(1)}s`.padStart(7),
      `${(m.head + m.middle + m.tail).toFixed(1)}s`.padStart(7),
      String(m.skips).padStart(6),
      `${m.overshoot >= 0 ? "+" : ""}${m.overshoot.toFixed(1)}s`.padStart(8)
    ].join(" "));
  }
  console.log("-".repeat(62));
  printGroup(opts.label ?? "ensemble", measured);
} else {
  const values = [...new Set(measured.map((m) => m.forward))].sort((a, b) => a - b);

  // Comparaison APPARIÉE : seules les fenêtres mesurées sous TOUTES les valeurs
  // comptent. Comparer des ensembles de vidéos différents ferait passer un
  // changement de distribution pour un effet du réglage.
  const byWindow = new Map();
  for (const m of measured) {
    const key = `${m.window[0]}-${m.window[1]}`;
    if (!byWindow.has(key)) byWindow.set(key, new Map());
    byWindow.get(key).set(m.forward, m);
  }
  const paired = [...byWindow.entries()].filter(([, byValue]) => values.every((v) => byValue.has(v)));

  console.log(`\nCOMPARAISON APPARIÉE — ${paired.length} fenêtres mesurées sous les ${values.length} réglages`);
  console.log(`(${byWindow.size - paired.length} fenêtres écartées : incomplètes)`);
  console.log(`\n${"fenêtre".padStart(13)} ${values.map((v) => `fwd=${v}`.padStart(9)).join(" ")}   verdict`);
  console.log("-".repeat(20 + values.length * 10));
  for (const [key, byValue] of paired) {
    const seens = values.map((v) => byValue.get(v).head + byValue.get(v).middle + byValue.get(v).tail);
    const delta = seens[seens.length - 1] - seens[0];
    const arrow = delta < -0.5 ? "mieux" : delta > 0.5 ? "pire" : "égal";
    console.log(`${`[${key}]`.padStart(13)} ${seens.map((s) => `${s.toFixed(1)}s`.padStart(9)).join(" ")}   ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}s`);
  }

  for (const v of values) {
    printGroup(`segmentForwardSeconds = ${v} (apparié)`, paired.map(([, byValue]) => byValue.get(v)));
  }
}
