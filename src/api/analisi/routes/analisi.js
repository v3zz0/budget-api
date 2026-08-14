'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/analisi-estratto-conto',
      handler: 'analisi.analizza',
      config: {
        // Autenticato davvero: prima era auth:false e chiunque, passando un
        // walletId, poteva farsi restituire le transazioni di quel wallet.
        // Serve anche per sapere quale motore AI ha scelto l'utente.
        policies: [],
      },
    },
    {
      method: 'POST',
      path: '/analisi-test-ai',
      handler: 'analisi.testAi',
      config: {
        policies: [],
      },
    },
  ],
};
