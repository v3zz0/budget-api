'use strict';

// Check delle regole dei consigli: node tests/motore-consigli.test.js
// Il service parla col database, quindi qui si verifica la parte che decide —
// mediana, soglie, arrotondamento — ricreandola sugli stessi valori.
// Se cambi le costanti in motore-consigli.js, cambiale anche qui: il test serve
// a dire "con questi numeri il consiglio è questo", non a duplicare il codice.

const assert = require('node:assert');

const SOGLIA_ALZA = 1.15;
const SOGLIA_ABBASSA = 0.6;

function mediana(valori) {
  const v = [...valori].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const arrotonda = (n) => {
  const pulito = Math.round(n * 100) / 100; // 100*1.15 = 114.99999999999999
  return Math.max(10, Math.round(pulito / 10) * 10);
};

function consiglio(spesi, budget) {
  const attivi = spesi.filter((s) => s > 0).length;
  if (attivi < 3) return null;
  const med = mediana(spesi);
  const sforati = spesi.filter((s) => s > budget).length;
  if (med > budget * SOGLIA_ALZA && sforati >= Math.ceil(spesi.length / 2)) {
    return { tipo: 'alza', proposto: arrotonda(med) };
  }
  if (spesi.every((s) => s < budget * SOGLIA_ABBASSA)) {
    const proposto = arrotonda(med * 1.15);
    if (proposto < budget) return { tipo: 'abbassa', proposto };
  }
  return null;
}

// Sforamento sistematico: mediana 345 su budget 250 -> alza a 350.
assert.deepStrictEqual(
  consiglio([340, 380, 290, 410, 350, 330], 250),
  { tipo: 'alza', proposto: 350 }
);

// Budget largo il doppio: sempre sotto il 60% -> abbassa.
assert.deepStrictEqual(
  consiglio([80, 95, 70, 90, 85, 75], 300),
  { tipo: 'abbassa', proposto: 90 }
);

// Sopra ma di poco (mediana +8%): oscillazione normale, nessun consiglio.
assert.strictEqual(consiglio([260, 270, 250, 280, 265, 255], 250), null);

// Un mese eccezionale non deve trascinare il consiglio: la media sarebbe 258,
// la mediana resta 100 e il budget da 500 va comunque abbassato.
assert.deepStrictEqual(
  consiglio([100, 90, 110, 100, 1050, 100], 5000),
  { tipo: 'abbassa', proposto: 120 }
);

// Categoria quasi nuova: due soli mesi con spese -> si tace.
assert.strictEqual(consiglio([0, 0, 0, 0, 400, 380], 100), null);

console.log('OK: regole dei consigli verificate');
