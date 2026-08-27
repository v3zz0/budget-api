'use strict';

const path = require('path');
const fs = require('fs');

// Istanzio direttamente i service tramite require — sono semplici factory
const pdfParserFactory = require('../services/pdf-parser');
const llmFactory = require('../services/llm-client');
const diffFactory = require('../services/diff-engine');
const sellaFactory = require('../services/sella-parser');
const autoCategoriaFactory = require('../services/auto-categoria');

const pdfParser = pdfParserFactory();
const diffEngine = diffFactory();
const sellaParser = sellaFactory();
const autoCategoria = autoCategoriaFactory();

// Quanti mesi di storico guardare per dedurre la categoria di un movimento.
// Un anno copre le spese stagionali (bollette, assicurazione, vacanze) senza
// tirarsi dietro archeologia.
const MESI_STORICO = 12;

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
  const motore = user?.aiMotore || 'ollama';
  return {
    motore,
    url: user?.aiUrl,
    modello: user?.aiModello,
    chiave: llmFactory.chiaveDiUtente(user, motore),
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

      // 3. Carico le categorie di TUTTI i portafogli dell'utente.
      // L'estratto conto è uno solo — il conto corrente — mentre i portafogli
      // sono tanti: confrontandolo con un portafoglio per volta, ogni spesa
      // registrata in un altro risultava "mancante" pur essendo già a posto.
      // Gli sforamenti restano invece sul portafoglio scelto: un budget ha
      // senso solo dentro il suo portafoglio.
      const walletsUtente = await strapi.documents('api::wallet.wallet').findMany({
        filters: { users_permissions_user: { id: userId } },
      });
      const categorie = await strapi.documents('api::categorie.categorie').findMany({
        filters: { wallet: { documentId: { $in: walletsUtente.map((w) => w.documentId) } } },
        populate: ['wallet'],
      });
      const categorieWallet = categorie.filter((c) => c.wallet?.documentId === walletId);

      if (!categorie.length) {
        return ctx.badRequest('Nessuna categoria trovata');
      }

      // 4. Carico le transazioni del mese, di tutti i portafogli
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
          // Perché il parser non l'ha riconosciuto? Senza queste righe il
          // fallback all'AI è invisibile: l'analisi "funziona" ma ci mette
          // minuti e legge meno movimenti, e non si capisce da dove venga.
          // Le prime righe bastano a riconoscere il formato.
          const campione = testo
            .split('\n')
            .map((r) => r.trim())
            .filter(Boolean)
            .slice(1, 6) // la [0] è l'intestazione "### Documento: ..."
            .map((r) => r.slice(0, 90));
          strapi.log.warn(
            `Analisi: nessun parser riconosce questo documento, passo all'AI. Prime righe:\n  ${campione.join('\n  ')}`
          );
          avvisiExtra.push(
            'Un documento non è in un formato riconosciuto: letto dall\'AI, che può saltare movimenti.'
          );

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
      // L'addebito della carta sul conto è il riepilogo di spese già contate
      // riga per riga nell'estratto della carta: tenerlo raddoppia un mese
      // intero di acquisti. Si toglie, ma lo si scrive nel report — un
      // movimento che sparisce in silenzio è peggio di uno di troppo.
      const giroconti = transazioniBanca.filter((t) => t.addebitoCarta);
      if (giroconti.length) {
        const elenco = giroconti.map((g) => `${g.descrizione} (${g.importo}€)`).join(', ');
        avvisiExtra.push(
          `Escluso l'addebito della carta di credito: ${elenco}. ` +
            `Sono spese già presenti nell'estratto della carta.`
        );
      }
      const transazioniConto = transazioniBanca.filter((t) => !t.addebitoCarta);

      const fonte = [...new Set(fonti)].join('+') || 'nessuna';
      strapi.log.info(
        `Analisi: ${transazioniConto.length} movimenti da ${testi.length} documento/i (${fonte})` +
          (giroconti.length ? `, ${giroconti.length} addebiti carta esclusi` : '')
      );

      // 6. Diff e sforamenti
      // I contanti non passano dal conto: escluderli dal confronto, altrimenti
      // rubano il match a un movimento bancario vero e lo nascondono dai mancanti.
      // Restano invece negli sforamenti: sono spesa a tutti gli effetti.
      const daConfrontare = transazioniDB.filter((t) => !t.Contanti);
      let { mancanti } = diffEngine.confronta(transazioniConto, daConfrontare);
      // Solo le categorie del portafoglio scelto: calcolaSforamenti filtra già
      // le transazioni per categoria, quindi passargliele tutte è innocuo.
      const sforamenti = diffEngine.calcolaSforamenti(transazioniDB, categorieWallet);

      // Il parser estrae i numeri ma non sa cosa siano: la categoria va deciso
      // in due passaggi, dal più economico al più costoso.
      //
      // 6a. Prima lo storico: se quel negozio l'hai già categorizzato, la
      // risposta è nel database e costa una query. Gratis, immediato,
      // deterministico, e migliora ogni volta che correggi un suggerimento.
      if (mancanti.some((m) => !m.categoriaSuggerita)) {
        try {
          const dalloStorico = new Date(Date.UTC(
            Number(mese.slice(0, 4)),
            Number(mese.slice(5, 7)) - 1 - MESI_STORICO,
            1,
          )).toISOString().slice(0, 10);

          const storiche = await strapi.documents('api::transazioni.transazioni').findMany({
            filters: {
              categorie: { documentId: { $in: idsCategorie } },
              Data: { $gte: dalloStorico, $lt: primoGiorno },
            },
            populate: ['categorie'],
            limit: -1,
          });

          const esito = autoCategoria.suggerisci(mancanti, storiche);
          mancanti = esito.movimenti;
          if (esito.indovinati) {
            strapi.log.info(
              `Analisi: ${esito.indovinati}/${mancanti.length} categorie dedotte dallo storico (${storiche.length} transazioni), senza AI`
            );
          }
        } catch (e) {
          // Se lo storico non si carica si passa all'LLM come prima: è una
          // scorciatoia, non un requisito.
          strapi.log.warn(`Analisi: storico non consultato (${e.message})`);
        }
      }

      // 6b. Poi l'LLM, ma solo su quello che è rimasto scoperto — i negozi
      // mai visti. Il passo è una rifinitura: i numeri del report li ha già
      // prodotti il parser, quindi se il modello è lento o giù si consegna il
      // report senza suggerimenti invece di buttare via tutto il lavoro.
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
        // Tutte le categorie dell'utente, col portafoglio di appartenenza:
        // servono all'app per registrare un movimento mancante nella categoria
        // giusta anche quando sta in un altro portafoglio.
        categorie: categorie.map((c) => ({
          documentId: c.documentId,
          nome: c.Nome,
          icona: c.icona,
          wallet: c.wallet?.Nome || '',
        })),
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
        chiave: chiave || llmFactory.chiaveDiUtente(ctx.state.user, motore),
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
