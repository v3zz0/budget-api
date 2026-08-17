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
process.env.AI_BUDGET_MS = '120';
const llmFactory = require('../src/api/analisi/services/llm-client');
const { soloMovimenti } = llmFactory;

const fetchVero = global.fetch;

/** Rifiuta con AbortError quando il signal scatta, come fa la fetch vera. */
function abortabile(opzioni) {
  return new Promise((_risolvi, rifiuta) => {
    opzioni.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      rifiuta(e);
    });
  });
}

/** Una fetch che non risponde mai, ma che rispetta l'abort del signal. */
function fetchCheNonRispondeMai(_url, opzioni) {
  return abortabile(opzioni);
}

/**
 * Il caso vero di OpenRouter: header immediati, corpo che arriva con calma.
 * È quello che rendeva inutile il timeout — la Response tornava subito, il
 * timer veniva cancellato, e la lettura del corpo restava senza limite.
 */
function fetchConCorpoLento(_url, opzioni) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => abortabile(opzioni),
  });
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Il bug che ha fatto durare un'analisi 432 secondi con il limite a 60.
  await test('molla anche se a essere lento è il CORPO, non gli header', async () => {
    global.fetch = fetchConCorpoLento;
    const llm = llmFactory({ motore: 'openrouter', url: 'http://x', chiave: 'k' });
    const inizio = Date.now();
    await assert.rejects(() => llm.ping(), /non ha risposto entro/);
    const durata = Date.now() - inizio;
    assert.ok(durata < 2000, `ha impiegato ${durata}ms: il corpo non è coperto dal timeout`);
  });

  await test('esaurito il budget le chiamate rimaste falliscono subito', async () => {
    global.fetch = fetchCheNonRispondeMai;
    // Budget più corto del timeout: la prima chiamata lo consuma tutto.
    const llm = llmFactory({ motore: 'ollama', url: 'http://x', budgetMs: 120 });
    await llm.ping().catch(() => {});
    await pausa(40);
    const inizio = Date.now();
    await assert.rejects(() => llm.ping(), /Tempo massimo/);
    assert.ok(Date.now() - inizio < 50, 'la seconda chiamata non deve nemmeno partire');
  });

  await test('dopo un timeout non regala un altro minuto alla chiamata dopo', async () => {
    global.fetch = fetchCheNonRispondeMai;
    // Budget ampio: qui a fermare la seconda chiamata dev'essere il fatto che
    // il modello ha già sforato, non il tempo finito.
    const llm = llmFactory({ motore: 'ollama', url: 'http://x', budgetMs: 60000 });
    await llm.ping().catch(() => {});
    const inizio = Date.now();
    await assert.rejects(() => llm.ping(), /non ha risposto entro/);
    assert.ok(
      Date.now() - inizio < 50,
      'la seconda chiamata ha aspettato di nuovo invece di mollare subito'
    );
  });

  await test('ogni analisi ha il suo budget, non uno condiviso', async () => {
    global.fetch = fetchCheNonRispondeMai;
    const primo = llmFactory({ motore: 'ollama', url: 'http://x', budgetMs: 120 });
    await primo.ping().catch(() => {});
    await pausa(40);
    // Client nuovo = richiesta nuova: non deve ereditare né il budget esaurito
    // né il modello marcato come giù.
    const secondo = llmFactory({ motore: 'ollama', url: 'http://x', budgetMs: 120 });
    await assert.rejects(() => secondo.ping(), /non ha risposto entro/);
  });

  await test('una risposta veloce passa senza essere toccata', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: '{ "ok": true }' }),
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

  await test('una pagina HTML al posto del JSON lo dice invece di esplodere', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>504 Gateway Time-out</html>',
    });
    const llm = llmFactory({ motore: 'openrouter', url: 'http://x', chiave: 'k' });
    await assert.rejects(() => llm.ping(), /risposta non JSON/);
  });

  console.log('llm-client: prefiltro del testo');

  await test('tiene i movimenti e butta le note legali', async () => {
    const testo = [
      'BANCA SELLA S.p.A. - Sede legale in Biella',
      'Il presente documento e disponibile in formato elettronico',
      'Condizioni economiche applicate al rapporto',
      '26001435096898 29/07/2026 31/07/2026 COFFEE POGNANO EUR -4,00',
      '26001435096899 30/07/2026 31/07/2026 ESSELUNGA MILANO EUR -52,30',
      '26001435096900 31/07/2026 31/07/2026 PAGAMENTO POS EUR -12,00',
      'Foglio informativo n. 1234 aggiornato al',
    ].join('\n');
    const filtrato = soloMovimenti(testo);
    assert.ok(filtrato.includes('COFFEE POGNANO'), 'ha perso un movimento');
    assert.ok(filtrato.includes('ESSELUNGA MILANO'), 'ha perso un movimento');
    assert.ok(!filtrato.includes('Sede legale'), 'ha tenuto le note legali');
    assert.ok(filtrato.length < testo.length, 'non ha tagliato niente');
  });

  await test('formato non riconosciuto: manda tutto invece del vuoto', async () => {
    const testo = 'estratto in un formato\nche non contiene\nne date ne importi';
    assert.strictEqual(soloMovimenti(testo), testo);
  });

  global.fetch = fetchVero;
})();
