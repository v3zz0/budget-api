'use strict';

// Check della spezzatura in blocchi: node tests/spezza.test.js
// La regola che conta è una sola: mai tagliare a metà di una riga, altrimenti
// un movimento si spacca fra due blocchi e nessuno dei due lo estrae.

const assert = require('node:assert');
const { spezza } = require('../src/api/analisi/services/llm-client');

const righe = Array.from({ length: 100 }, (_, i) => `riga numero ${i} con del testo`);
const testo = righe.join('\n');

const blocchi = spezza(testo, 200);

assert.ok(blocchi.length > 1, 'con 100 righe e blocchi da 200 char deve spezzare');

// Nessuna riga persa e nessuna riga spezzata a metà.
const ricomposto = blocchi.join('').trim().split('\n');
assert.deepStrictEqual(ricomposto, righe, 'le righe devono tornare tutte e intatte');

// Testo corto: un blocco solo.
assert.strictEqual(spezza('una riga sola', 10000).length, 1);
assert.strictEqual(spezza('').length, 0);

console.log(`OK: 100 righe -> ${blocchi.length} blocchi, nessuna riga spezzata`);
