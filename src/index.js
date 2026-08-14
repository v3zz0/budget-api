"use strict";

// Il testo del consiglio lo scrive l'LLM, ma i numeri glieli passiamo noi già
// calcolati: il modello non deve MAI decidere un importo. Se non risponde o non
// è configurato, resta una frase costruita dai numeri — il consiglio è valido
// lo stesso, cambia solo la forma.
async function testoConsiglio(llm, p, strapi) {
  const storico = p.mesiAnalizzati.map((m) => `${m.mese}: ${m.speso}€`).join(", ");
  const base =
    p.tipo === "alza"
      ? `Su "${p.categoria.Nome}" spendi regolarmente più del budget di ${p.budgetAttuale}€. Un budget di ${p.budgetProposto}€ sarebbe più realistico.`
      : `Su "${p.categoria.Nome}" resti sempre molto sotto il budget di ${p.budgetAttuale}€. Portandolo a ${p.budgetProposto}€ liberi ${(p.budgetAttuale - p.budgetProposto).toFixed(0)}€ per altro.`;

  try {
    const raw = await llm.giudizioLibero(
      `Sei un assistente finanziario personale. Scrivi UNA frase (max 25 parole) in italiano colloquiale su questa categoria di spesa.\n\n` +
        `Categoria: ${p.categoria.Nome}\n` +
        `Budget attuale: ${p.budgetAttuale}€\n` +
        `Spese degli ultimi mesi: ${storico}\n` +
        `Proposta: portare il budget a ${p.budgetProposto}€\n\n` +
        `Non inventare numeri diversi da questi. Niente preamboli.\n` +
        `Rispondi con JSON: { "testo": "..." }`,
    );
    return raw && raw.trim() ? raw.trim() : base;
  } catch (e) {
    strapi.log.warn(`Consigli: LLM non disponibile, uso il testo di base (${e.message})`);
    return base;
  }
}

module.exports = {
  register({ strapi }) {
    strapi.cron.add({
      // A fine mese (ultimo giorno alle 23) creiamo il record del mese
      // successivo a 0 per ogni wallet, così l'utente lo trova vuoto
      // pronto per essere modificato a mano. Il record del mese che sta
      // finendo resta com'è ed entra a far parte dello storico.
      apriMeseSuccessivo: {
        task: async ({ strapi }) => {
          strapi.log.info("Cron apriMeseSuccessivo avviato");

          // Verifica che sia davvero l'ultimo giorno del mese
          const oggi = new Date();
          const domani = new Date(oggi);
          domani.setDate(domani.getDate() + 1);
          if (domani.getDate() !== 1) return;

          // Primo giorno del mese successivo (chiave del nuovo record)
          const primoMeseProssimo = new Date(domani.getFullYear(), domani.getMonth(), 1);
          const meseISO = primoMeseProssimo.toISOString().split("T")[0];

          const wallets = await strapi.entityService.findMany("api::wallet.wallet");

          for (const wallet of wallets) {
            // Se già esiste un record per quel mese, non ricreare
            const esistente = await strapi.entityService.findMany(
              "api::salvadanaio.salvadanaio",
              { filters: { wallet: wallet.id, mese: meseISO } },
            );
            if (esistente.length > 0) continue;

            await strapi.entityService.create("api::salvadanaio.salvadanaio", {
              data: {
                mese: meseISO,
                budgetAllocato: wallet.Budget || 0,
                speso: 0,
                risparmiato: 0,
                wallet: wallet.id,
              },
            });
            strapi.log.info(
              `Record salvadanaio creato per wallet "${wallet.Nome}" - Mese ${meseISO} (risparmiato=0)`,
            );
          }
        },
        options: { rule: "0 23 28-31 * *" },
      },

      // Sempre a fine mese: rigenera i consigli sul budget.
      // Qui e non all'apertura della home perché i consigli guardano gli ultimi
      // 6 mesi: sono mensili per natura. Così l'app legge una lista già pronta
      // e l'LLM lavora una volta al mese invece che a ogni apertura.
      generaConsigli: {
        task: async ({ strapi }) => {
          const oggi = new Date();
          const domani = new Date(oggi);
          domani.setDate(domani.getDate() + 1);
          if (domani.getDate() !== 1) return;

          strapi.log.info("Cron generaConsigli avviato");
          const motore = require("./api/consiglio/services/motore-consigli")();
          const llmFactory = require("./api/analisi/services/llm-client");

          const wallets = await strapi.entityService.findMany("api::wallet.wallet", {
            populate: ["users_permissions_user"],
          });

          for (const wallet of wallets) {
            const proposte = await motore.calcola(wallet.documentId, oggi);
            if (!proposte.length) continue;

            // Il motore AI è quello scelto dal proprietario del wallet.
            const utente = wallet.users_permissions_user;
            const llm = llmFactory({
              motore: utente?.aiMotore,
              url: utente?.aiUrl,
              modello: utente?.aiModello,
              chiave: utente?.aiChiave,
            });

            for (const p of proposte) {
              // Un consiglio ignorato non si ripresenta identico il mese dopo:
              // altrimenti la campanella diventa rumore e si smette di guardarla.
              const scartati = await strapi.entityService.findMany(
                "api::consiglio.consiglio",
                {
                  filters: {
                    categorie: p.categoria.id,
                    tipo: p.tipo,
                    stato: { $in: ["ignorato", "nuovo"] },
                  },
                  limit: 1,
                },
              );
              if (scartati.length > 0) continue;

              await strapi.entityService.create("api::consiglio.consiglio", {
                data: {
                  tipo: p.tipo,
                  budgetAttuale: p.budgetAttuale,
                  budgetProposto: p.budgetProposto,
                  mesiAnalizzati: p.mesiAnalizzati,
                  testo: await testoConsiglio(llm, p, strapi),
                  stato: "nuovo",
                  categorie: p.categoria.id,
                },
              });
              strapi.log.info(
                `Consiglio ${p.tipo} per "${p.categoria.Nome}": ${p.budgetAttuale} -> ${p.budgetProposto}`,
              );
            }
          }
        },
        options: { rule: "5 23 28-31 * *" },
      },

      // Ogni giorno all'alba: crea automaticamente le transazioni ricorrenti
      // "in scadenza" oggi. Per ogni template (TransazioneRicorrente=true) genera
      // un'istanza del mese corrente, se non esiste già.
      materializzaRicorrenti: {
        task: async ({ strapi }) => {
          const oggi = new Date();
          const giornoOggi = oggi.getDate();
          const anno = oggi.getFullYear();
          const mese = String(oggi.getMonth() + 1).padStart(2, "0");
          const lastDay = new Date(anno, oggi.getMonth() + 1, 0).getDate();
          const primo = `${anno}-${mese}-01`;
          const ultimo = `${anno}-${mese}-${String(lastDay).padStart(2, "0")}`;

          const templates = await strapi
            .documents("api::transazioni.transazioni")
            .findMany({
              filters: { TransazioneRicorrente: true },
              populate: ["categorie"],
            });

          for (const t of templates) {
            if (!t.categorie) continue;
            const rif = t.RicorrenzaTemporale || t.Data;
            if (!rif) continue;

            // Scade oggi? Se il giorno non esiste nel mese (es. 31 a febbraio),
            // scatta l'ultimo giorno del mese.
            const giornoRic = new Date(rif).getDate();
            const inScadenza =
              giornoRic === giornoOggi ||
              (giornoOggi === lastDay && giornoRic > lastDay);
            if (!inScadenza) continue;

            // Anti-duplicato: c'è già una transazione con stessi categoria,
            // importo e descrizione in questo mese? (istanza già creata, oppure
            // il template nel suo mese d'origine) → salta.
            // ponytail: match per categoria+importo+descrizione; due ricorrenti
            //   identiche verrebbero fuse. Per precisione: aggiungere un campo
            //   che colleghi l'istanza al template.
            const esistenti = await strapi
              .documents("api::transazioni.transazioni")
              .findMany({
                filters: {
                  categorie: { documentId: t.categorie.documentId },
                  Importo: t.Importo,
                  Descrizione: t.Descrizione,
                  Data: { $gte: primo, $lte: ultimo },
                },
              });
            if (esistenti.length > 0) continue;

            const giorno = String(Math.min(giornoRic, lastDay)).padStart(2, "0");
            await strapi.documents("api::transazioni.transazioni").create({
              data: {
                Importo: t.Importo,
                Descrizione: t.Descrizione,
                Data: `${anno}-${mese}-${giorno}`,
                TransazioneRicorrente: false, // istanza materializzata, non un nuovo template
                Contanti: t.Contanti || false, // una ricorrente in contanti resta in contanti
                categorie: t.categorie.documentId,
              },
            });
            strapi.log.info(
              `Ricorrente materializzata: "${t.Descrizione}" ${t.Importo}€ (${anno}-${mese})`,
            );
          }
        },
        options: { rule: "0 6 * * *" },
      },
    });
  },
  bootstrap(/*{ strapi }*/) {},
};
