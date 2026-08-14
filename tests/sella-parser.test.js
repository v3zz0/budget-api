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
});

// "EUR" dentro la descrizione non deve troncare il movimento.
assert.deepStrictEqual(m[1], {
  data: '2026-07-18',
  importo: 20.36,
  descrizione: 'PAYPAL *ALIPAY EUR 17280818884',
});

// Descrizione andata a capo.
assert.deepStrictEqual(m[2], {
  data: '2026-07-15',
  importo: 555,
  descrizione: 'RATA MUTUO LUIGI GATTI A ALESSANDRO VEZZOLI',
});

// Separatore delle migliaia.
assert.strictEqual(m[3].importo, 1200);

// Il totale del mese deve tornare con quello stampato dalla banca.
const somma = m.reduce((s, x) => s + x.importo, 0);
assert.strictEqual(Number(somma.toFixed(2)), 1779.36);

console.log(`OK: ${m.length} movimenti, totale uscite ${somma.toFixed(2)} EUR`);
