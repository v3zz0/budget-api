"use strict";

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
    });
  },
  bootstrap(/*{ strapi }*/) {},
};
