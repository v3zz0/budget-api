'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/analisi-estratto-conto',
      handler: 'analisi.analizza',
      config: {
        // Lasciamo autenticato come tutti gli endpoint dell'app
        auth: false,
        policies: [],
      },
    },
  ],
};
