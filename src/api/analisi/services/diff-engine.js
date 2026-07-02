'use strict';

// Tolleranza per matching importo (centesimi)
const TOLL_IMPORTO = 0.01;
// Finestra temporale per matching (giorni)
const TOLL_GIORNI = 3;

function diffGiorni(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

module.exports = () => ({
  // Confronta transazioni estratte dal PDF con quelle nel DB
  // Ritorna: { mancanti: [...transazioni in banca ma non nel DB] }
  confronta(transazioniBanca, transazioniDB) {
    const mancanti = [];
    const usate = new Set();

    for (const tBanca of transazioniBanca) {
      const idx = transazioniDB.findIndex((tDB, i) => {
        if (usate.has(i)) return false;
        const stessoImporto = Math.abs(Number(tDB.Importo) - Number(tBanca.importo)) < TOLL_IMPORTO;
        const stessaData = diffGiorni(tDB.Data, tBanca.data) <= TOLL_GIORNI;
        return stessoImporto && stessaData;
      });

      if (idx >= 0) {
        usate.add(idx);
      } else {
        mancanti.push(tBanca);
      }
    }

    return { mancanti };
  },

  // Calcola sforamenti per categoria del wallet
  calcolaSforamenti(transazioniDB, categorie) {
    return categorie.map((cat) => {
      const speso = transazioniDB
        .filter((t) => t.categorie?.documentId === cat.documentId)
        .reduce((sum, t) => sum + Number(t.Importo), 0);

      const budget = Number(cat.Budget_categoria) || 0;
      const rimanente = budget - speso;

      return {
        documentId: cat.documentId,
        nome: cat.Nome,
        icona: cat.icona,
        budget,
        speso: Number(speso.toFixed(2)),
        rimanente: Number(rimanente.toFixed(2)),
        sforato: rimanente < 0,
      };
    });
  },
});
