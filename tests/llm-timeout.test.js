'use strict';

// Check del timeout sulle chiamate al modello: node tests/llm-timeout.test.js
//
// Il caso che questo test protegge: un modello che non risponde mai. Prima la
// fetch restava appesa all'infinito, il reverse proxy davanti a Strapi chiudeva
// con un 504 e il server continuava a macinare una richiesta che nessuno
// avrebbe più letto.

const assert = require('node:assert');

// Il client logga tramite lo strapi globale.
global.strapi = { log: { info() {}, warn() {}, error() {} } };

process.env.AI_TIMEOUT_MS = '150';
const llmFactory = require('../src/api/analisi/services/llm-client');

const fetchVero = global.fetch;

/** Una fetch che non risponde mai, ma che rispetta l'abort del signal. */
function fetchCheNonRispondeMai(_url, opzioni) {
  return new Promise((_risolvi, rifiuta) => {
    opzioni.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      rifiuta(e);
    });
  });
}

async function test(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (e) {
    console.error(`  FAIL ${nome}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('llm-client: timeout');

  await test('ollama molla invece di restare appeso', async () => {
    global.fetch = fetchCheNonRispondeMai;
    const llm = llmFactory({ motore: 'ollama', url: 'http://x' });
    await assert.rejects(() => llm.ping(), /non ha risposto entro/);
  });

  await test('openrouter molla invece di restare appeso', async () => {
    global.fetch = fetchCheNonRispondeMai;
    const llm = llmFactory({
      motore: 'openrouter',
      url: 'http://x',
      chiave: 'k',
    });
    await assert.rejects(() => llm.ping(), /non ha risposto entro/);
  });

  await test('molla entro il tempo dichiarato, non molto dopo', async () => {
    global.fetch = fetchCheNonRispondeMai;
    const llm = llmFactory({ motore: 'ollama', url: 'http://x' });
    const inizio = Date.now();
    await llm.ping().catch(() => {});
    const durata = Date.now() - inizio;
    assert.ok(
      durata < 2000,
      `ha impiegato ${durata}ms: il timeout non sta scattando`
    );
  });

  await test('una risposta veloce passa senza essere toccata', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ response: '{ "ok": true }' }),
    });
    const llm = llmFactory({ motore: 'ollama', url: 'http://x' });
    assert.strictEqual(await llm.ping(), true);
  });

  await test('un errore HTTP resta distinto dal timeout', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'chiave non valida',
    });
    const llm = llmFactory({ motore: 'openrouter', url: 'http://x', chiave: 'k' });
    await assert.rejects(() => llm.ping(), /OpenRouter error 401/);
  });

  global.fetch = fetchVero;
})();
