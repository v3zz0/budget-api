'use strict';

const path = require('path');
const fs = require('fs');

// Istanzio direttamente i service tramite require — sono semplici factory
const pdfParserFactory = require('../services/pdf-parser');
const ollamaFactory = require('../services/ollama-client');
const diffFactory = require('../services/diff-engine');

const pdfParser = pdfParserFactory();
const ollama = ollamaFactory();
const diffEngine = diffFactory();

// "YYYY-MM" → { primoGiorno: "YYYY-MM-01", ultimoGiorno: "YYYY-MM-31" }
function rangeMese(meseYYYYMM) {
  const [y, m] = meseYYYYMM.split('-').map(Number);
  const primo = new Date(Date.UTC(y, m - 1, 1));
  const ultimo = new Date(Date.UTC(y, m, 0)); // ultimo giorno
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { primoGiorno: fmt(primo), ultimoGiorno: fmt(ultimo) };
}

// Verifica che il periodo dell'estratto cada nel mese richiesto
function validaMese(periodoEstratto, meseRichiesto) {
  if (!periodoEstratto) {
    return { ok: true, warning: 'Periodo non trovato nel PDF, validazione saltata' };
  }
  const meseDal = periodoEstratto.dal.slice(0, 7);
  const meseAl = periodoEstratto.al.slice(0, 7);
  if (meseDal !== meseRichiesto && meseAl !== meseRichiesto) {
    return {
      ok: false,
      warning: `L'estratto conto copre ${periodoEstratto.dal} → ${periodoEstratto.al}, ma hai richiesto ${meseRichiesto}`,
    };
  }
  return { ok: true };
}

module.exports = {
  async analizza(ctx) {
    try {
      const { walletId, mese } = ctx.request.body;
      const files = ctx.request.files;

      if (!walletId || !mese) {
        return ctx.badRequest('walletId e mese sono obbligatori');
      }
      if (!/^\d{4}-\d{2}$/.test(mese)) {
        return ctx.badRequest('mese deve essere in formato YYYY-MM');
      }
      if (!files || !files.pdf) {
        return ctx.badRequest('File PDF mancante (campo "pdf")');
      }

      const pdfFile = Array.isArray(files.pdf) ? files.pdf[0] : files.pdf;
      const pdfPath = pdfFile.filepath || pdfFile.path;

      // 1. Estrazione testo PDF
      const testoEstratto = await pdfParser.estraiTesto(pdfPath);

      // 2. Validazione periodo
      const periodoEstratto = pdfParser.estraiPeriodo(testoEstratto);
      const validazione = validaMese(periodoEstratto, mese);

      // 3. Carico categorie del wallet
      const categorie = await strapi.documents('api::categorie.categorie').findMany({
        filters: { wallet: { documentId: walletId } },
        populate: ['wallet'],
      });

      if (!categorie.length) {
        return ctx.badRequest('Nessuna categoria trovata per il wallet');
      }

      // 4. Carico transazioni del wallet per il mese
      const { primoGiorno, ultimoGiorno } = rangeMese(mese);
      const idsCategorie = categorie.map((c) => c.documentId);

      const transazioniDB = await strapi.documents('api::transazioni.transazioni').findMany({
        filters: {
          categorie: { documentId: { $in: idsCategorie } },
          Data: { $gte: primoGiorno, $lte: ultimoGiorno },
        },
        populate: ['categorie'],
      });

      // 5. LLM estrae transazioni dal testo
      const transazioniBanca = await ollama.estraiTransazioni(testoEstratto, categorie);

      // 6. Diff e sforamenti
      const { mancanti } = diffEngine.confronta(transazioniBanca, transazioniDB);
      const sforamenti = diffEngine.calcolaSforamenti(transazioniDB, categorie);

      const totaleSpeso = sforamenti.reduce((s, c) => s + c.speso, 0);
      const totaleBudget = sforamenti.reduce((s, c) => s + c.budget, 0);

      // 7. Giudizio sintetico LLM
      const giudizio = await ollama.giudizioMese({
        mese,
        sforamenti,
        totaleSpeso: Number(totaleSpeso.toFixed(2)),
        totaleBudget: Number(totaleBudget.toFixed(2)),
        mancanti,
      });

      // 8. Pulizia file temporaneo (best-effort)
      try { fs.unlinkSync(pdfPath); } catch (_) {}

      return {
        mese,
        walletId,
        validazione,
        periodoEstratto,
        sforamenti,
        mancanti,
        totale: {
          budget: Number(totaleBudget.toFixed(2)),
          speso: Number(totaleSpeso.toFixed(2)),
          rimanente: Number((totaleBudget - totaleSpeso).toFixed(2)),
        },
        giudizio,
      };
    } catch (err) {
      strapi.log.error('Errore analisi estratto conto:', err);
      return ctx.internalServerError(err.message);
    }
  },
};
