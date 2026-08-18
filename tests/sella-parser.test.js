'use strict';

// Check del parser Banca Sella. Si lancia con:  node tests/sella-parser.test.js
// (fuori da src/ apposta: Strapi carica come service tutto ciò che sta in
// src/api/*/services/)

const assert = require('node:assert');
const parser = require('../src/api/analisi/services/sella-parser')();

// Estratto reale ridotto ai casi che contano.
const TESTO = `
Codice
Identificativo
Data
operazione Data Valuta Descrizione Divisa Importo Note
26001435096898 29/07/2026 31/07/2026 COFFEE CAPP BY N AND I POGNANO EUR -4,00
26001420807639 18/07/2026 22/07/2026 PAYPAL *ALIPAY EUR 17280818884 EUR -20,36
26001409754683 15/07/2026 15/07/2026 RATA MUTUO LUIGI GATTI A ALESSANDRO
VEZZOLI EUR -555,00
26001399971237 09/07/2026 09/07/2026 RETRIBUZIONE GIUGNO 26 DA VPS SAS DI
VEZZOLI PIERO E C. EUR +1.487,00
26001384701461 01/07/2026 01/07/2026 Arredamento A ALESSANDRO VEZZOLI EUR -1.200,00
Totale movimenti Euro -506,82
Saldo al 14/08/2026 (*) Euro 665,81
`;

const m = parser.parse(TESTO);

// Le due entrate (+1.487,00) e le righe di totale/saldo non sono movimenti di spesa.
assert.strictEqual(m.length, 4, `attesi 4 movimenti, trovati ${m.length}`);

assert.deepStrictEqual(m[0], {
  data: '2026-07-29',
  importo: 4,
  descrizione: 'COFFEE CAPP BY N AND I POGNANO',
  addebitoCarta: false,
});

// "EUR" dentro la descrizione non deve troncare il movimento.
assert.deepStrictEqual(m[1], {
  data: '2026-07-18',
  importo: 20.36,
  descrizione: 'PAYPAL *ALIPAY EUR 17280818884',
  addebitoCarta: false,
});

// Descrizione andata a capo.
assert.deepStrictEqual(m[2], {
  data: '2026-07-15',
  importo: 555,
  descrizione: 'RATA MUTUO LUIGI GATTI A ALESSANDRO VEZZOLI',
  addebitoCarta: false,
});

// Separatore delle migliaia.
assert.strictEqual(m[3].importo, 1200);

// Il totale del mese deve tornare con quello stampato dalla banca.
const somma = m.reduce((s, x) => s + x.importo, 0);
assert.strictEqual(Number(somma.toFixed(2)), 1779.36);

console.log(`OK: ${m.length} movimenti, totale uscite ${somma.toFixed(2)} EUR`);

// ─────────────────────────────────────────────────────────────────────────────
// Formato senza spazi: è quello che pdf-parse produce davvero sui PDF Sella.
// Con \s+ fra i campi il parser tornava 0 movimenti e l'estratto finiva
// all'LLM, che ne trovava circa la metà.
const SENZA_SPAZI = [
  '2600143509689829/07/202631/07/2026COFFEE CAPP BY N AND I POGNANOEUR-4,00',
  '2600141824819521/07/202621/07/2026POS 2106 CARDHOLDER ADJUSTMENTEUR+52,73',
  '2600142080763918/07/202622/07/2026PAYPAL *ALIPAY EUR 17280818884EUR-20,36',
  '2600140975468315/07/202615/07/2026',
  'RATA MUTUO LUIGI GATTI A ALESSANDRO',
  'VEZZOLI',
  'EUR-555,00',
  '2600139997123709/07/202609/07/2026RETRIBUZIONE GIUGNOEUR+1.487,00',
].join('\n');

const s = parser.parse(SENZA_SPAZI);

// Le due righe con importo positivo sono accrediti: non sono spese.
assert.strictEqual(s.length, 3, `attesi 3 movimenti, trovati ${s.length}`);

assert.deepStrictEqual(s[0], {
  data: '2026-07-29',
  importo: 4,
  descrizione: 'COFFEE CAPP BY N AND I POGNANO',
  addebitoCarta: false,
});

// Il codice identificativo non deve mangiarsi le cifre della data.
assert.deepStrictEqual(s[1], {
  data: '2026-07-18',
  importo: 20.36,
  descrizione: 'PAYPAL *ALIPAY EUR 17280818884',
  addebitoCarta: false,
});

assert.deepStrictEqual(s[2], {
  data: '2026-07-15',
  importo: 555,
  descrizione: 'RATA MUTUO LUIGI GATTI A ALESSANDRO VEZZOLI',
  addebitoCarta: false,
});

console.log(`OK: formato senza spazi, ${s.length} movimenti`);

// ─────────────────────────────────────────────────────────────────────────────
// Secondo formato: "LISTA MOVIMENTI CARTA". Copiato da un PDF vero, comprese
// le descrizioni spezzate su più righe. L'oracolo è il totale che stampa la
// banca in fondo: se la somma non fa 770,72 abbiamo perso o inventato righe.
const CARTA = `
 Data Operazione Importo in Euro Descrizione Divisa originale Importo originale
 26/07/2026 -71,50 DALLA LELLA AL
MARE SRL RIMINI
 EUR -71,50
 24/07/2026 -18,27 AUTOGRILL 0006
FIORENZUOLAPC
 EUR -18,27
 24/07/2026 -49,93 SUPERMERCATO
NOVA COOP -
TORINO TO
 EUR -49,93
 21/07/2026 -51,60 RISTORANTE
MEIWEI DI ZHA
AVIGLIANA
 EUR -51,60
 19/07/2026 -289,96 Sixt DGMRWG6BJ
Appiano sulla
 EUR -289,96
 19/07/2026 -38,40 DALLA LELLA
RIMINI RN
 EUR -38,40
 11/07/2026 -88,70 JustEatItaly MILANO EUR -88,70
 11/07/2026 -5,00 PUMA S.R.L.
COLLEGNO TO
 EUR -5,00
 10/07/2026 -2,20 MC DONALD'S
COLLEGNO TO
 EUR -2,20
 10/07/2026 -3,00 PARCHEGGIO VIA
ROMA TORINO TO
 EUR -3,00
 05/07/2026 -61,20 OLD WILD WEST
TORINO TO
 EUR -61,20
 05/07/2026 -17,50 JYSK TORINO IT3
TORINO
 EUR -17,50
 02/07/2026 -25,90 VODAFONE ADDEB
CONTO TEL IVREA
TO
 EUR -25,90
 01/07/2026 -39,20 E J DI ZHENG
FENGMEI ROSTA
TO
 EUR -39,20
 29/06/2026 -8,36 PRESTOFRESCO
SPA
SANT'ANTONINO
 EUR -8,36
Totale speso al 16/08/2026 08:17:31 770,72
`;

const c = parser.parse(CARTA);

assert.strictEqual(c.length, 15, `attesi 15 movimenti carta, trovati ${c.length}`);

const totaleCarta = c.reduce((s, x) => s + x.importo, 0);
assert.strictEqual(
  Number(totaleCarta.toFixed(2)),
  770.72,
  `il totale non torna con quello stampato dalla banca: ${totaleCarta.toFixed(2)}`
);

// Descrizione su più righe, ricomposta.
assert.deepStrictEqual(c[0], {
  data: '2026-07-26',
  importo: 71.5,
  descrizione: 'DALLA LELLA AL MARE SRL RIMINI',
  addebitoCarta: false,
});

// Riga singola.
assert.deepStrictEqual(c[6], {
  data: '2026-07-11',
  importo: 88.7,
  descrizione: 'JustEatItaly MILANO',
  addebitoCarta: false,
});

// La riga "Totale speso" non deve diventare un movimento.
assert.ok(!c.some((x) => /Totale/i.test(x.descrizione)), 'riga di totale letta come movimento');

// Stesso formato ma senza spazi fra i campi, come lo produce pdf-parse.
const CARTA_SENZA_SPAZI = [
  '26/07/2026-71,50DALLA LELLA AL',
  'MARE SRL RIMINI',
  'EUR-71,50',
  '11/07/2026-88,70JustEatItaly MILANOEUR-88,70',
].join('\n');

const cs = parser.parse(CARTA_SENZA_SPAZI);
assert.strictEqual(cs.length, 2, `attesi 2 movimenti, trovati ${cs.length}`);
assert.strictEqual(cs[0].importo, 71.5);
assert.strictEqual(cs[0].descrizione, 'DALLA LELLA AL MARE SRL RIMINI');
assert.strictEqual(cs[1].descrizione, 'JustEatItaly MILANO');

console.log(`OK: formato carta, ${c.length} movimenti, totale ${totaleCarta.toFixed(2)} EUR`);

// --- Addebito della carta di credito sul conto ---
// "VISA CLASSIC GIUGNO" non e' una spesa: e' il totale degli acquisti gia'
// elencati uno per uno nell'estratto della carta. Contarlo raddoppia il mese.
const CONTO_CON_VISA = [
  '26001435096898 10/07/2026 10/07/2026 VISA CLASSIC GIUGNO EUR -587,91',
  '26001435096899 11/07/2026 11/07/2026 JustEatItaly MILANO EUR -88,70',
].join('\n');

const v = parser.parse(CONTO_CON_VISA);
assert.strictEqual(v.length, 2, 'entrambi i movimenti vanno letti, poi si filtra');
assert.strictEqual(v[0].addebitoCarta, true, 'addebito carta non riconosciuto');
assert.strictEqual(v[1].addebitoCarta, false, 'spesa normale marcata per sbaglio');

// Nell'estratto della CARTA le righe sono acquisti veri: nessuna va esclusa,
// nemmeno se il negozio si chiamasse "Visa qualcosa".
const CARTA_CON_VISA = '10/07/2026 -20,00 VISA STORE MILANO EUR -20,00';
assert.strictEqual(parser.parse(CARTA_CON_VISA)[0].addebitoCarta, false,
  'un acquisto nell\'estratto carta e\' stato scambiato per un addebito');

console.log('OK: addebito carta riconosciuto solo nel formato conto');
