'use strict';

// Calcolo dei consigli sul budget.
//
// Il numero lo decide QUESTO codice, non l'LLM: sono medie e mediane su dati
// che abbiamo già. L'LLM interviene dopo, solo per scrivere la frase attorno a
// un numero che è già stato calcolato ed è verificabile.

// Quanti mesi guardare (esclusi il mese corrente, che è incompleto).
const MESI = 6;
// Sotto questa soglia di mesi con spese non si consiglia: sarebbe rumore.
const MIN_MESI_ATTIVI = 3;
// Scostamenti sotto queste soglie sono oscillazione normale, non budget sbagliato.
const SOGLIA_ALZA = 1.15; // mediana oltre il +15% del budget
const SOGLIA_ABBASSA = 0.6; // sempre sotto il 60% del budget
// Non seppellire l'utente: pochi consigli, i più rilevanti.
const MAX_PER_WALLET = 3;

function mediana(valori) {
  const v = [...valori].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Arrotonda a 10€: un budget di 347,50 non ha senso, "350" sì.
// Il round ai centesimi prima serve contro la virgola mobile: 100 * 1.15 fa
// 114.99999999999999, che scenderebbe a 110 invece di salire a 120.
function arrotonda(n) {
  const pulito = Math.round(n * 100) / 100;
  return Math.max(10, Math.round(pulito / 10) * 10);
}

// Gli ultimi MESI mesi completi, dal più vecchio: ["2026-02", ..., "2026-07"]
function mesiDaAnalizzare(oggi) {
  const out = [];
  for (let i = MESI; i >= 1; i--) {
    const d = new Date(Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

module.exports = () => ({
  MESI,

  /**
   * Consigli per un wallet. Solo calcolo: nessuna scrittura, nessun LLM.
   * Restituisce al massimo MAX_PER_WALLET proposte, dalla più rilevante.
   */
  async calcola(walletDocumentId, oggi = new Date()) {
    const mesi = mesiDaAnalizzare(oggi);
    const dal = `${mesi[0]}-01`;
    const [ay, am] = mesi[mesi.length - 1].split('-').map(Number);
    const al = new Date(Date.UTC(ay, am, 0)).toISOString().slice(0, 10);

    const categorie = await strapi.documents('api::categorie.categorie').findMany({
      filters: { wallet: { documentId: walletDocumentId } },
    });
    if (!categorie.length) return [];

    const transazioni = await strapi.documents('api::transazioni.transazioni').findMany({
      filters: {
        categorie: { documentId: { $in: categorie.map((c) => c.documentId) } },
        Data: { $gte: dal, $lte: al },
      },
      populate: ['categorie'],
      limit: -1,
    });

    // { documentIdCategoria: { "2026-07": 123.45, ... } }
    const spesePerCategoria = {};
    for (const t of transazioni) {
      const cat = t.categorie?.documentId;
      if (!cat) continue;
      const mese = String(t.Data).slice(0, 7);
      spesePerCategoria[cat] ??= {};
      spesePerCategoria[cat][mese] = (spesePerCategoria[cat][mese] || 0) + Number(t.Importo);
    }

    const consigli = [];
    for (const cat of categorie) {
      const budget = Number(cat.Budget_categoria) || 0;
      if (budget <= 0) continue; // categoria senza budget: niente da consigliare

      const perMese = spesePerCategoria[cat.documentId] || {};
      // Un mese senza transazioni conta come speso 0, ma serve un minimo di
      // storia perché il dato voglia dire qualcosa.
      const spesi = mesi.map((m) => Number((perMese[m] || 0).toFixed(2)));
      const attivi = spesi.filter((s) => s > 0).length;
      if (attivi < MIN_MESI_ATTIVI) continue;

      const med = mediana(spesi);
      const sforati = spesi.filter((s) => s > budget).length;
      const dettaglio = mesi.map((m, i) => ({ mese: m, speso: spesi[i] }));

      // Mediana e non media: un mese eccezionale (la lavatrice rotta) non deve
      // alzarti il budget per sempre.
      if (med > budget * SOGLIA_ALZA && sforati >= Math.ceil(mesi.length / 2)) {
        consigli.push({
          categoria: cat,
          tipo: 'alza',
          budgetAttuale: budget,
          budgetProposto: arrotonda(med),
          mesiAnalizzati: dettaglio,
          scostamento: med / budget - 1,
        });
      } else if (spesi.every((s) => s < budget * SOGLIA_ABBASSA)) {
        const proposto = arrotonda(med * 1.15); // un margine sopra la mediana
        if (proposto < budget) {
          consigli.push({
            categoria: cat,
            tipo: 'abbassa',
            budgetAttuale: budget,
            budgetProposto: proposto,
            mesiAnalizzati: dettaglio,
            scostamento: 1 - med / budget,
          });
        }
      }
    }

    return consigli
      .sort((a, b) => b.scostamento - a.scostamento)
      .slice(0, MAX_PER_WALLET);
  },
});
