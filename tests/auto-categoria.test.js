'use strict';

// Categoria dedotta dallo storico: node tests/auto-categoria.test.js
//
// Quello che conta è che non spari a caso: un suggerimento sbagliato finisce
// nel budget senza che nessuno se ne accorga, ed è peggio di nessun
// suggerimento (lì almeno l'LLM ci prova, o scegli tu).

const assert = require('node:assert');
const autoCategoria = require('../src/api/analisi/services/auto-categoria')();

const cat = (Nome) => ({ Nome });
const storiche = [
  { Descrizione: 'PAGAMENTO POS ESSELUNGA VIA ROMA MILANO', categorie: cat('Spesa') },
  { Descrizione: 'ESSELUNGA SUPERSTORE BERGAMO', categorie: cat('Spesa') },
  { Descrizione: 'PAGAMENTO CARTA ENEL ENERGIA', categorie: cat('Bollette') },
  { Descrizione: 'FARMACIA COMUNALE 12', categorie: cat('Salute') },
];

// ── Il caso base: negozio già visto, categoria dedotta senza AI ────────────
{
  const { movimenti, indovinati } = autoCategoria.suggerisci(
    [{ descrizione: 'PAGAMENTO POS 12/08 ESSELUNGA PONTIROLO' }],
    storiche,
  );
  assert.strictEqual(movimenti[0].categoriaSuggerita, 'Spesa');
  assert.strictEqual(movimenti[0].fonteCategoria, 'storico');
  assert.strictEqual(indovinati, 1);
}

// ── Negozio mai visto: nessun suggerimento, non un suggerimento a caso ─────
// Deve restare scoperto, così ci prova l'LLM dopo.
{
  const { movimenti, indovinati } = autoCategoria.suggerisci(
    [{ descrizione: 'PAGAMENTO POS BOTTEGA DEL CAFFE TRIESTE' }],
    storiche,
  );
  assert.strictEqual(movimenti[0].categoriaSuggerita, undefined);
  assert.strictEqual(indovinati, 0);
}

// ── Solo parole di rumore in comune: NON deve bastare ──────────────────────
// "PAGAMENTO" e "CARTA" stanno in mezzo estratto conto: se contassero,
// qualsiasi movimento aggancerebbe qualsiasi categoria.
{
  const { movimenti } = autoCategoria.suggerisci(
    [{ descrizione: 'PAGAMENTO CARTA CONTACTLESS ITALIA' }],
    storiche,
  );
  assert.strictEqual(movimenti[0].categoriaSuggerita, undefined);
}

// ── Parola contesa: vince la categoria che la usa più spesso ───────────────
{
  const contese = [
    { Descrizione: 'BAR CENTRALE', categorie: cat('Svago') },
    { Descrizione: 'BAR CENTRALE', categorie: cat('Svago') },
    { Descrizione: 'BAR CENTRALE', categorie: cat('Pranzo') },
  ];
  const { movimenti } = autoCategoria.suggerisci(
    [{ descrizione: 'BAR CENTRALE PIAZZA' }],
    contese,
  );
  assert.strictEqual(movimenti[0].categoriaSuggerita, 'Svago');
}

// ── Un suggerimento già presente non si sovrascrive ────────────────────────
{
  const { movimenti, indovinati } = autoCategoria.suggerisci(
    [{ descrizione: 'ESSELUNGA MILANO', categoriaSuggerita: 'Regali' }],
    storiche,
  );
  assert.strictEqual(movimenti[0].categoriaSuggerita, 'Regali');
  assert.strictEqual(indovinati, 0);
}

// ── Storico vuoto o transazioni senza categoria: nessun crash ──────────────
{
  assert.strictEqual(
    autoCategoria.suggerisci([{ descrizione: 'ESSELUNGA' }], []).indovinati,
    0,
  );
  assert.strictEqual(
    autoCategoria.suggerisci(
      [{ descrizione: 'ESSELUNGA' }],
      [{ Descrizione: 'ESSELUNGA', categorie: null }],
    ).indovinati,
    0,
  );
  assert.strictEqual(
    autoCategoria.suggerisci([{ descrizione: null }], storiche).indovinati,
    0,
  );
}

// ── Tokenizzazione: numeri, date e codici non sono parole ──────────────────
{
  const p = autoCategoria.parole('PAGAMENTO POS 12/08/2026 ESSELUNGA VIA ROMA 5');
  assert.ok(p.has('ESSELUNGA'));
  assert.ok(!p.has('PAGAMENTO'), 'rumore escluso');
  assert.ok(!p.has('POS'), 'sotto i 4 caratteri');
  assert.ok(![...p].some((x) => /\d/.test(x)), 'nessun numero fra le parole');
}

console.log('OK: categoria dedotta dallo storico, rumore ignorato, nessun falso positivo');
