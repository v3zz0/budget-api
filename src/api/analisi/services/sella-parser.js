'use strict';

// Parser deterministico per la lista movimenti di Banca Sella.
// Il PDF (e l'export CSV) hanno righe sempre nella stessa forma:
//
//   26001435096898 29/07/2026 31/07/2026 COFFEE CAPP BY N AND I POGNANO EUR -4,00
//   <codice>       <data op>  <valuta>   <descrizione>                  EUR <importo>
//
// Essendo una tabella regolare non serve un LLM per leggerla: una regex la
// estrae in millisecondi, sempre allo stesso modo, senza inventare nulla.

// L'importo DEVE finire con ",dd": è questo vincolo a far funzionare la
// descrizione non-greedy anche quando contiene la parola EUR, come in
// "PAYPAL *ALIPAY EUR 17280818884 EUR -20,36".
const MOVIMENTO =
  /^(\d{10,20})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([\s\S]*?)\s+EUR\s+([+-]?[\d.]*\d,\d{2})/;

// Inizio di un nuovo movimento: codice identificativo + data operazione.
const INIZIO = /^\d{10,20}\s+\d{2}\/\d{2}\/\d{4}/;

// "1.487,00" -> 1487.00   "-4,00" -> -4
function toNumero(s) {
  return Number(s.replace(/\./g, '').replace(',', '.'));
}

// "29/07/2026" -> "2026-07-29"
function toIso(s) {
  const [g, m, a] = s.split('/');
  return `${a}-${m}-${g}`;
}

module.exports = () => ({
  /**
   * Estrae le USCITE dal testo di un estratto conto Banca Sella.
   * Restituisce lo stesso formato di llm-client.estraiTransazioni,
   * così il diff-engine non si accorge della differenza.
   */
  parse(testo) {
    const movimenti = [];
    let buffer = '';

    for (const riga of String(testo).split('\n')) {
      const t = riga.trim();
      if (!t) continue;

      if (INIZIO.test(t)) {
        buffer = t; // nuovo movimento (se il precedente era incompleto, si scarta)
      } else if (buffer) {
        buffer += ' ' + t; // descrizione andata a capo
      } else {
        continue; // intestazioni, note legali, righe di totale
      }

      const m = buffer.match(MOVIMENTO);
      if (!m) continue; // movimento non ancora completo: aspetto la riga dopo
      buffer = '';

      const importo = toNumero(m[5]);
      // Solo le spese: accrediti e storni positivi non sono transazioni dell'app.
      if (importo >= 0) continue;

      movimenti.push({
        // Data operazione, non data valuta: è il giorno in cui hai speso.
        data: toIso(m[2]),
        importo: Math.abs(importo),
        descrizione: m[4].replace(/\s+/g, ' ').trim(),
      });
    }

    return movimenti;
  },
});
