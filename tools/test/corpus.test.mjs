/**
 * Le corpus est la source de vérité du banc d'essai multi-vidéos : une entrée
 * mal formée coûterait des dizaines de minutes de runs avant d'être vue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./dom-stub.mjs";

const corpus = JSON.parse(readFileSync(join(REPO_ROOT, "tools/corpus.json"), "utf8"));

test("le corpus est non vide et daté", () => {
  assert.ok(Array.isArray(corpus.videos) && corpus.videos.length > 0);
  assert.match(corpus.annotatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("chaque entrée a un identifiant YouTube plausible et unique", () => {
  const ids = corpus.videos.map((v) => v.id);
  for (const id of ids) {
    assert.match(id, /^[\w-]{11}$/, `identifiant inattendu : ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, "identifiant en double");
});

test("chaque fenêtre de pub est cohérente", () => {
  for (const { id, ad } of corpus.videos) {
    assert.ok(Number.isInteger(ad.start) && ad.start >= 0, `${id}: start invalide`);
    assert.ok(Number.isInteger(ad.end) && ad.end > ad.start, `${id}: end <= start`);
    assert.ok(ad.end - ad.start >= 5, `${id}: fenêtre de ${ad.end - ad.start}s, trop courte pour être mesurable`);
  }
});

test("le plafond --seconds couvre le seek de mise en place et la fenêtre", () => {
  const DEFAULT_SEEK_LEAD = 30;
  const STARTUP_BUDGET = 45; // chargement de la page, consentement, démarrage OCR

  for (const { id, ad, seconds } of corpus.videos) {
    const needed = DEFAULT_SEEK_LEAD + (ad.end - ad.start) + STARTUP_BUDGET;
    assert.ok(
      seconds >= needed,
      `${id}: --seconds ${seconds} trop court, il en faut au moins ${needed}`
    );
  }
});

test("une seule vidéo est marquée comme référence", () => {
  const refs = corpus.videos.filter((v) => v.reference);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, "vRAPfDSmBGM", "la ligne de base historique porte sur cette vidéo");
});
