'use strict';

// Parser deterministico per la lista movimenti di Banca Sella.
// Il PDF (e l'export CSV) hanno righe sempre negli stessi campi:
//
//   26001435096898 29/07/2026 31/07/2026 COFFEE CAPP BY N AND I POGNANO EUR -4,00
//   <codice>       <data op>  <valuta>   <descrizione>                  EUR <importo>
//
// Attenzione: gli spazi che vedi qui sopra sono un caso fortunato. pdf-parse
// spesso restituisce i campi tutti attaccati, così:
//
//   2600143509689829/07/202631/07/2026COFFEE CAPP BY N AND I POGNANOEUR-4,00
//
// Per questo i separatori sono \s* e non \s+: con \s+ il parser non trovava
// niente e l'intero estratto finiva all'LLM, un blocco alla volta — da
// millisecondi a minuti, con il rischio di righe saltate o inventate.
//
// Essendo una tabella regolare non serve un LLM per leggerla: una regex la
// estrae in millisecondi, sempre allo stesso modo, senza inventare nulla.

// L'importo DEVE finire con ",dd": è questo vincolo a far funzionare la
// descrizione non-greedy anche quando contiene la parola EUR, come in
// "PAYPAL *ALIPAY EUR 17280818884EUR-20,36".
const MOVIMENTO =
  /^(\d{10,20})\s*(\d{2}\/\d{2}\/\d{4})\s*(\d{2}\/\d{2}\/\d{4})\s*([\s\S]*?)\s*EUR\s*([+-]?[\d.]*\d,\d{2})/;

// Inizio di un nuovo movimento: codice identificativo + data operazione.
const INIZIO = /^\d{10,20}\s*\d{2}\/\d{2}\/\d{4}/;

// Secondo formato: "LISTA MOVIMENTI CARTA". Stessa banca, tabella diversa —
// niente codice identificativo, l'importo viene PRIMA della descrizione, e in
// fondo si ripete in divisa originale:
//
//   26/07/2026 -71,50 DALLA LELLA AL MARE SRL RIMINI EUR -71,50
//   <data op>  <imp>  <descrizione>                  EUR <importo originale>
//
// Non può essere confuso col formato conto: lì la riga comincia con 10-20
// cifre, qui con una data, e una data ha lo slash in terza posizione.
const MOVIMENTO_CARTA =
  /^(\d{2}\/\d{2}\/\d{4})\s*([+-][\d.]*\d,\d{2})\s*([\s\S]*?)\s*EUR\s*[+-]?[\d.]*\d,\d{2}\s*$/;

const INIZIO_CARTA = /^\d{2}\/\d{2}\/\d{4}\s*[+-][\d.]*\d,\d{2}/;

// L'addebito mensile della carta di credito sul conto ("VISA CLASSIC GIUGNO")
// non è una spesa: è la somma delle spese già elencate nell'estratto della
// carta. Contarlo significa contare due volte lo stesso mese di acquisti.
// Non lo si butta qui: lo si marca, e chi legge decide (e lo dice all'utente).
const ADDEBITO_CARTA = /\b(VISA|MASTERCARD|MAESTRO)\b|SALDO CARTA|ADDEBITO CARTA/i;

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

      if (INIZIO.test(t) || INIZIO_CARTA.test(t)) {
        buffer = t; // nuovo movimento (se il precedente era incompleto, si scarta)
      } else if (buffer) {
        buffer += ' ' + t; // descrizione andata a capo
      } else {
        continue; // intestazioni, note legali, righe di totale
      }

      // I due formati si escludono a vicenda, quindi basta provarli in fila.
      const conto = buffer.match(MOVIMENTO);
      const carta = conto ? null : buffer.match(MOVIMENTO_CARTA);
      if (!conto && !carta) continue; // movimento incompleto: aspetto la riga dopo
      buffer = '';

      // Data operazione, non data valuta: è il giorno in cui hai speso.
      const [data, grezzo, descrizione] = conto
        ? [conto[2], conto[5], conto[4]]
        : [carta[1], carta[2], carta[3]];

      const importo = toNumero(grezzo);
      // Solo le spese: accrediti e storni positivi non sono transazioni dell'app.
      if (importo >= 0) continue;

      const pulita = descrizione.replace(/\s+/g, ' ').trim();
      movimenti.push({
        data: toIso(data),
        importo: Math.abs(importo),
        descrizione: pulita,
        // Vale solo per il formato conto: nell'estratto della carta le righe
        // sono gli acquisti veri, non il loro riepilogo.
        addebitoCarta: Boolean(conto) && ADDEBITO_CARTA.test(pulita),
      });
    }

    return movimenti;
  },
});
