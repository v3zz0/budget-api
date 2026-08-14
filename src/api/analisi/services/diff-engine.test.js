'use strict';
// Check minimo: node src/api/analisi/services/diff-engine.test.js
const assert = require('assert');
const diff = require('./diff-engine')();

// Banca ha un movimento da 50€ non registrato. Nel DB c'è una spesa in contanti
// dello stesso importo e data: senza il filtro Contanti farebbe match con quel
// movimento e il mancante sparirebbe dal report.
const banca = [{ importo: 50, data: '2026-03-10', descrizione: 'POS ignoto' }];
const db = [{ Importo: 50, Data: '2026-03-10', Contanti: true }];

assert.strictEqual(diff.confronta(banca, db).mancanti.length, 0, 'senza filtro il contante maschera il mancante');

const filtrate = db.filter((t) => !t.Contanti);
assert.strictEqual(diff.confronta(banca, filtrate).mancanti.length, 1, 'con filtro il mancante emerge');

// Una spesa tracciata (non contanti) deve invece continuare a fare match.
const tracciata = [{ Importo: 50, Data: '2026-03-10', Contanti: false }];
assert.strictEqual(diff.confronta(banca, tracciata.filter((t) => !t.Contanti)).mancanti.length, 0);

console.log('ok');
