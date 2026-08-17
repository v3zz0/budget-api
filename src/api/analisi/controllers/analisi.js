'use strict';

const path = require('path');
const fs = require('fs');

// Istanzio direttamente i service tramite require — sono semplici factory
const pdfParserFactory = require('../services/pdf-parser');
const llmFactory = require('../services/llm-client');
const diffFactory = require('../services/diff-engine');
const sellaFactory = require('../services/sella-parser');

const pdfParser = pdfParserFactory();
const diffEngine = diffFactory();
const sellaParser = sellaFactory();

// Verifica che il wallet sia dell'utente che sta chiamando.
// Senza questo controllo un utente autenticato potrebbe passare il walletId di
// un altro e farsi restituire le sue categorie, transazioni e sforamenti.
// Stesso schema usato in categorie/transazioni.
async function walletDelloUtente(documentId, userId) {
  const entry = await strapi.documents('api::wallet.wallet').findOne({
    documentId,
    populate: { users_permissions_user: true },
  });
  if (!entry || !entry.users_permissions_user) return null;
  if (entry.users_permissions_user.id !== userId) return null;
  return entry;
}

// Impostazioni AI dell'utente (scelte dall'app). Se non ha mai configurato
// niente resta il comportamento storico: Ollama con le variabili d'ambiente.
function configAi(user) {
  return {
    motore: user?.aiMotore || 'ollama',
    url: user?.aiUrl,
    modello: user?.aiModello,
    chiave: user?.aiChiave,
  };
}

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

      // Motore AI scelto dall'utente nelle impostazioni dell'app.
      const llm = llmFactory(configAi(ctx.state.user));

      if (!walletId || !mese) {
        return ctx.badRequest('walletId e mese sono obbligatori');
      }
      if (!/^\d{4}-\d{2}$/.test(mese)) {
        return ctx.badRequest('mese deve essere in formato YYYY-MM');
      }

      const userId = ctx.state.user && ctx.state.user.id;
      if (!userId) return ctx.unauthorized();
      if (!(await walletDelloUtente(walletId, userId))) {
        return ctx.notFound('Portafoglio non trovato');
      }
      if (!files || !files.pdf) {
        return ctx.badRequest('Nessun documento caricato (campo "pdf")');
      }

      // Supporta 1..N documenti (PDF o CSV) caricati sotto il campo "pdf".
      const lista = Array.isArray(files.pdf) ? files.pdf : [files.pdf];
      const daPulire = [];
      const testi = [];
      for (const f of lista) {
        const p = f.filepath || f.path;
        daPulire.push(p);
        const nome = (f.originalFilename || f.name || '').toLowerCase();
        let testo;
        if (nome.endsWith('.pdf')) {
          testo = await pdfParser.estraiTesto(p);
        } else {
          // CSV o testo semplice: lo passiamo direttamente all'LLM
          testo = fs.readFileSync(p, 'utf8');
        }
        testi.push(`### Documento: ${f.originalFilename || f.name || 'documento'}\n${testo}`);
      }

      // 1. Testo combinato di tutti i documenti
      const testoEstratto = testi.join('\n\n');

      // 2. Validazione periodo (dal testo combinato; per i CSV spesso assente → skip)
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

      // 5. Estrazione movimenti, UN DOCUMENTO ALLA VOLTA.
      // Il formato Banca Sella è una tabella regolare: la legge una regex,
      // esatta e istantanea. L'LLM resta come rete per le altre banche, dove
      // però può saltare o inventare righe.
      // Documento per documento e non sul testo combinato: caricando un Sella
      // insieme a un estratto di un'altra banca, il parser troverebbe i
      // movimenti del primo e il secondo sparirebbe senza un avviso.
      const transazioniBanca = [];
      const fonti = [];
      const avvisiExtra = [];
      for (const testo of testi) {
        const daParser = sellaParser.parse(testo);
        if (daParser.length) {
          transazioniBanca.push(...daParser);
          fonti.push('sella-parser');
        } else {
          // Un documento che il modello non riesce a leggere non deve far
          // fallire anche gli altri: con due estratti caricati insieme, il
          // secondo va analizzato lo stesso.
          try {
            transazioniBanca.push(...(await llm.estraiTransazioni(testo, categorie)));
            fonti.push('llm');
          } catch (e) {
            strapi.log.warn(`Analisi: documento non letto dal modello (${e.message})`);
            avvisiExtra.push(
              'Un documento non è stato letto: nessun parser lo riconosce e il modello non ha risposto in tempo.'
            );
          }
        }
      }
      const fonte = [...new Set(fonti)].join('+') || 'nessuna';
      strapi.log.info(
        `Analisi: ${transazioniBanca.length} movimenti da ${testi.length} documento/i (${fonte})`
      );

      // 6. Diff e sforamenti
      // I contanti non passano dal conto: escluderli dal confronto, altrimenti
      // rubano il match a un movimento bancario vero e lo nascondono dai mancanti.
      // Restano invece negli sforamenti: sono spesa a tutti gli effetti.
      const daConfrontare = transazioniDB.filter((t) => !t.Contanti);
      let { mancanti } = diffEngine.confronta(transazioniBanca, daConfrontare);
      const sforamenti = diffEngine.calcolaSforamenti(transazioniDB, categorie);

      // Il parser estrae i numeri ma non sa cosa siano: la categoria la
      // suggerisce l'LLM, e solo sui pochi movimenti mancanti (poche righe di
      // descrizione, non l'estratto conto intero).
      // I due passi che seguono sono rifiniture: i numeri del report li ha già
      // prodotti il parser. Se il modello è lento o giù, si consegna il report
      // senza di loro invece di buttare via tutto il lavoro con un errore.
      // Prima una qualsiasi di queste chiamate faceva fallire l'intera analisi.
      if (mancanti.some((m) => !m.categoriaSuggerita)) {
        try {
          mancanti = await llm.suggerisciCategorie(mancanti, categorie);
        } catch (e) {
          strapi.log.warn(`Analisi: categorie non suggerite (${e.message})`);
          avvisiExtra.push('Categorie non suggerite: il modello non ha risposto in tempo.');
        }
      }

      const totaleSpeso = sforamenti.reduce((s, c) => s + c.speso, 0);
      const totaleBudget = sforamenti.reduce((s, c) => s + c.budget, 0);

      // 7. Giudizio sintetico LLM
      let giudizio = '';
      try {
        giudizio = await llm.giudizioMese({
          mese,
          sforamenti,
          totaleSpeso: Number(totaleSpeso.toFixed(2)),
          totaleBudget: Number(totaleBudget.toFixed(2)),
          mancanti,
        });
      } catch (e) {
        strapi.log.warn(`Analisi: giudizio non generato (${e.message})`);
        avvisiExtra.push('Giudizio non generato: il modello non ha risposto in tempo.');
      }

      // 8. Pulizia file temporanei (best-effort)
      for (const p of daPulire) {
        try { fs.unlinkSync(p); } catch (_) {}
      }

      // Tutto quello che è stato saltato o troncato finisce nel warning che la
      // app già mostra in cima al report: un report parziale deve dirlo da sé,
      // altrimenti si legge come completo.
      const avvisi = [...llm.avvisi(), ...avvisiExtra];
      const validazioneFinale = avvisi.length
        ? {
            ok: validazione.ok,
            warning: [validazione.warning, ...avvisi].filter(Boolean).join(' · '),
          }
        : validazione;

      return {
        mese,
        walletId,
        fonte, // "sella-parser" oppure "llm": utile per capire cosa è successo
        validazione: validazioneFinale,
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

  // Bottone "Prova connessione" delle impostazioni: usa i valori che l'utente
  // sta digitando, non quelli salvati, così può testare prima di confermare.
  async testAi(ctx) {
    const { motore, url, modello, chiave } = ctx.request.body || {};
    try {
      const llm = llmFactory({
        motore,
        url,
        modello,
        // Chiave vuota nel form = usa quella già salvata (non la rimandiamo
        // mai all'app, quindi il campo arriva vuoto se non l'hai ritoccata).
        chiave: chiave || ctx.state.user?.aiChiave,
      });
      const ok = await llm.ping();
      return {
        ok,
        messaggio: ok
          ? `${llm.motore} risponde (${llm.modello})`
          : 'Risposta non valida dal modello',
      };
    } catch (err) {
      return { ok: false, messaggio: err.message };
    }
  },
};
