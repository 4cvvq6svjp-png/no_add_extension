/**
 * Robustesse du démarrage de Tesseract.
 *
 * Le démarrage a lieu dans la boucle de scan, qui l'attend : une panne mal
 * gérée gèle tout le pipeline. Ces tests couvrent les trois modes de
 * défaillance identifiés, chacun avec un comportement distinct avant
 * correction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, loadContentScript } from "./dom-stub.mjs";

installDomStub({ href: "https://www.youtube.com/" }); // pas de /watch : aucune session
const { CONFIG, TesseractOcr } = loadContentScript();

/** Horloge pilotée : le backoff se mesure, il ne s'attend pas. */
function withClock() {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  return {
    advance(ms) { now += ms; },
    restore() { Date.now = real; }
  };
}

/**
 * Remplace le pont par un double dont on pilote chaque étape.
 * `ensureReady` et `request` renvoient ce que le scénario décide.
 */
function fakeBridge({ connects = true, initFails = false, recognizeFails = false } = {}) {
  return {
    calls: { ensureReady: 0, init: 0, recognize: 0, destroy: 0 },
    connects,
    initFails,
    recognizeFails,
    async ensureReady() { this.calls.ensureReady++; return this.connects; },
    async request(type) {
      if (type === "init") {
        this.calls.init++;
        if (this.initFails) throw new Error("modèle fra indisponible");
        return {};
      }
      if (type === "recognize") {
        this.calls.recognize++;
        if (this.recognizeFails) throw new Error("worker mort");
        return { text: "Publicité" };
      }
      return {};
    },
    isConnected() { return true; },
    destroy() { this.calls.destroy++; }
  };
}

function engineWith(bridgeOptions) {
  const engine = new TesseractOcr();
  const bridge = fakeBridge(bridgeOptions);
  engine.bridge = bridge;
  return { engine, bridge };
}

const CANVAS = { width: 10, height: 10 };

/* --------------------------------------------------------------------- */
/*  Mode A — l'iframe ne signale jamais sa disponibilité                  */
/* --------------------------------------------------------------------- */

test("une sandbox qui ne répond pas ne condamne pas le moteur", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({ connects: false });

    assert.deepEqual(await engine.recognize(CANVAS), { error: "tesseract-unavailable" });
    assert.equal(engine.failures, 1, "l'échec est compté (il ne l'était pas avant)");

    // Avant correction, une promesse résolue à false restait en cache et plus
    // aucune tentative n'avait lieu, pour toujours.
    bridge.connects = true;
    clock.advance(CONFIG.ocrRetryBaseDelayMs);
    const result = await engine.recognize(CANVAS);

    assert.deepEqual(result, { text: "Publicité" }, "le moteur se rattrape");
    assert.equal(engine.failures, 0, "le compteur est remis à zéro");
    assert.equal(engine.disabled, false);
  } finally {
    clock.restore();
  }
});

/* --------------------------------------------------------------------- */
/*  Mode B — l'initialisation du moteur échoue                            */
/* --------------------------------------------------------------------- */

test("un démarrage raté n'est pas retenté à chaque frame", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({ initFails: true });

    await engine.recognize(CANVAS);
    assert.equal(bridge.calls.init, 1);

    // Trois frames de plus pendant le délai d'attente : aucune ne relance
    // l'initialisation. Avant correction, chacune en déclenchait une complète.
    for (let i = 0; i < 3; i++) await engine.recognize(CANVAS);
    assert.equal(bridge.calls.init, 1, "aucune tentative pendant le backoff");

    clock.advance(CONFIG.ocrRetryBaseDelayMs);
    await engine.recognize(CANVAS);
    assert.equal(bridge.calls.init, 2, "une seule nouvelle tentative après le délai");
  } finally {
    clock.restore();
  }
});

test("le délai entre tentatives croît puis se plafonne", async () => {
  const clock = withClock();
  try {
    const { engine } = engineWith({ initFails: true });
    const delays = [];

    for (let i = 0; i < 8; i++) {
      const before = Date.now();
      await engine.recognize(CANVAS);
      delays.push(engine.nextAttemptAt - before);
      clock.advance(CONFIG.ocrRetryMaxDelayMs);
    }

    assert.equal(delays[0], CONFIG.ocrRetryBaseDelayMs);
    assert.equal(delays[1], CONFIG.ocrRetryBaseDelayMs * 2);
    assert.equal(delays[2], CONFIG.ocrRetryBaseDelayMs * 4);
    assert.ok(delays.every((d) => d <= CONFIG.ocrRetryMaxDelayMs), "jamais au-delà du plafond");
    assert.equal(delays.at(-1), CONFIG.ocrRetryMaxDelayMs, "le plafond est atteint");
  } finally {
    clock.restore();
  }
});

test("après le seuil, l'état est honnête et une reprise reste possible", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({ initFails: true });

    for (let i = 0; i < CONFIG.maxTesseractFailures; i++) {
      await engine.recognize(CANVAS);
      clock.advance(CONFIG.ocrRetryMaxDelayMs);
    }

    assert.equal(engine.disabled, true, "le heartbeat dira enfin la vérité");
    assert.deepEqual(await engine.recognize(CANVAS), { error: "tesseract-disabled" });

    // Le moteur ne se rend pas définitivement : le réseau peut revenir.
    bridge.initFails = false;
    clock.advance(CONFIG.ocrRetryMaxDelayMs);
    assert.deepEqual(await engine.recognize(CANVAS), { text: "Publicité" });
    assert.equal(engine.disabled, false, "la reprise réarme le moteur");
  } finally {
    clock.restore();
  }
});

test("une reprise repart d'une iframe neuve", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({ initFails: true });

    await engine.recognize(CANVAS);
    const destroyedAfterFirst = bridge.calls.destroy;

    clock.advance(CONFIG.ocrRetryBaseDelayMs);
    await engine.recognize(CANVAS);

    assert.ok(
      bridge.calls.destroy > destroyedAfterFirst,
      "la sandbox met son worker en cache : réinitialiser sans la recréer " +
      "rendrait le même worker mort"
    );
  } finally {
    clock.restore();
  }
});

/* --------------------------------------------------------------------- */
/*  Mode C — le worker lâche après un démarrage réussi                    */
/* --------------------------------------------------------------------- */

test("un échec de reconnaissance isolé ne redémarre pas le moteur", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({});
    await engine.recognize(CANVAS);
    assert.equal(engine.started, true);

    bridge.recognizeFails = true;
    assert.deepEqual(await engine.recognize(CANVAS), { error: "tesseract-error" });
    assert.equal(engine.started, true, "un seul raté ne condamne pas le worker");

    bridge.recognizeFails = false;
    assert.deepEqual(await engine.recognize(CANVAS), { text: "Publicité" });
    assert.equal(engine.failures, 0);
  } finally {
    clock.restore();
  }
});

test("un worker durablement cassé est remplacé au lieu d'être abandonné", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({});
    await engine.recognize(CANVAS);

    bridge.recognizeFails = true;
    for (let i = 0; i < CONFIG.maxTesseractFailures; i++) await engine.recognize(CANVAS);

    assert.equal(engine.started, false, "le worker est considéré mort");
    assert.equal(engine.disabled, true);

    // Avant correction, `disabled` bloquait toute reconnaissance pour toujours.
    bridge.recognizeFails = false;
    clock.advance(CONFIG.ocrRetryMaxDelayMs);
    assert.deepEqual(await engine.recognize(CANVAS), { text: "Publicité" });
  } finally {
    clock.restore();
  }
});

/* --------------------------------------------------------------------- */
/*  Invariants                                                            */
/* --------------------------------------------------------------------- */

test("un seul démarrage en vol même sur des appels concurrents", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({});
    await Promise.all([
      engine.recognize(CANVAS),
      engine.recognize(CANVAS),
      engine.recognize(CANVAS)
    ]);
    assert.equal(bridge.calls.init, 1);
  } finally {
    clock.restore();
  }
});

test("terminate remet le moteur à son état initial", async () => {
  const clock = withClock();
  try {
    const { engine, bridge } = engineWith({ initFails: true });
    await engine.recognize(CANVAS);
    assert.equal(engine.failures, 1);

    bridge.initFails = false;
    await engine.terminate();

    assert.equal(engine.started, false);
    assert.equal(engine.failures, 0);
    assert.equal(engine.disabled, false);
    assert.equal(engine.nextAttemptAt, 0, "aucun délai résiduel après un redémarrage de session");
  } finally {
    clock.restore();
  }
});
