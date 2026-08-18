'use strict';

// Categoria di un movimento dedotta dallo storico, senza chiedere niente a
// nessuno.
//
// L'LLM indovinava la categoria di ogni movimento mancante da capo, ogni mese,
// anche per "ESSELUNGA" che compare da due anni. Ma la risposta è già nel
// database: se sei andato all'Esselunga venti volte e l'hai sempre messo in
// "Spesa", la ventunesima non serve chiederlo a un modello.
//
// Nessuna tabella di regole da mantenere: le regole SONO le transazioni che hai
// già registrato, quindi migliorano da sole ogni volta che ne correggi una.
// L'LLM resta per i negozi mai visti, che sono pochi.

// Parole che compaiono in mezza banca e non identificano niente. Tenerle
// significa far combaciare "PAGAMENTO POS" con "PAGAMENTO POS", cioè tutto
// con tutto.
const RUMORE = new Set([
  'PAGAMENTO', 'PAGAMENTI', 'ADDEBITO', 'ADDEBITI', 'BONIFICO', 'DISPOSIZIONE',
  'ACQUISTO', 'ACQUISTI', 'OPERAZIONE', 'MOVIMENTO', 'CARTA', 'CARTE',
  'BANCOMAT', 'CONTACTLESS', 'CIRCUITO', 'VISA', 'MASTERCARD', 'MAESTRO',
  'ITALIA', 'ITALY', 'ITAL', 'SEPA', 'ONLINE', 'INTERNET', 'DIGITAL',
  'COMMISSIONE', 'COMMISSIONI', 'SPESE', 'CANONE', 'RATA', 'SALDO',
  'DATA', 'VALUTA', 'RIFERIMENTO', 'PRESSO', 'DELLA', 'DELLO', 'DEGLI',
  'NOME', 'COGNOME', 'FAVORE', 'ORDINANTE', 'BENEFICIARIO',
]);

// Quanti caratteri deve avere una parola per contare. Sotto i 4 restano sigle
// e preposizioni, che agganciano qualsiasi cosa.
const MIN_LUNGHEZZA = 4;

/**
 * "PAGAMENTO POS 12/08 ESSELUNGA VIA ROMA 5 MILANO" -> Set{ESSELUNGA, MILANO}
 *
 * Via numeri, date e codici in un colpo solo: quello che identifica un negozio
 * è il suo nome, e il nome è fatto di lettere.
 */
function parole(descrizione) {
  return new Set(
    String(descrizione || '')
      .toUpperCase()
      .replace(/[^A-ZÀ-Ù]+/g, ' ')
      .split(' ')
      .filter((p) => p.length >= MIN_LUNGHEZZA && !RUMORE.has(p))
  );
}

module.exports = () => ({
  parole,

  /**
   * Assegna `categoriaSuggerita` ai movimenti che ancora non ce l'hanno,
   * cercando nello storico una spesa con lo stesso negozio.
   *
   * @param movimenti  [{ descrizione, categoriaSuggerita? }]
   * @param storiche   transazioni del DB con `categorie` popolata
   * @returns { movimenti, indovinati } — `indovinati` per il log
   */
  suggerisci(movimenti, storiche) {
    // Indice parola -> categorie che l'hanno usata, con quante volte.
    // Si conta perché una parola può finire in due categorie diverse ("BAR"
    // in Svago e in Pranzo): vince quella che ci finisce più spesso.
    const indice = new Map();
    for (const t of storiche) {
      const nome = t.categorie?.Nome;
      if (!nome) continue;
      for (const p of parole(t.Descrizione)) {
        if (!indice.has(p)) indice.set(p, new Map());
        const conteggi = indice.get(p);
        conteggi.set(nome, (conteggi.get(nome) || 0) + 1);
      }
    }

    let indovinati = 0;
    const risultato = movimenti.map((m) => {
      if (m.categoriaSuggerita) return m;

      // Voti: ogni parola in comune vota per le categorie in cui è già apparsa.
      const voti = new Map();
      for (const p of parole(m.descrizione)) {
        for (const [nome, n] of indice.get(p) || []) {
          voti.set(nome, (voti.get(nome) || 0) + n);
        }
      }
      if (voti.size === 0) return m;

      const [vincitrice] = [...voti.entries()].sort((a, b) => b[1] - a[1]);
      indovinati++;
      return { ...m, categoriaSuggerita: vincitrice[0], fonteCategoria: 'storico' };
    });

    return { movimenti: risultato, indovinati };
  },
});
