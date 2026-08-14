'use strict';

// Azioni sui consigli: applicare la proposta o archiviarla.
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/consiglios/:id/applica',
      handler: 'consiglio.applica',
      config: { policies: [] },
    },
    {
      method: 'POST',
      path: '/consiglios/:id/segna',
      handler: 'consiglio.segna',
      config: { policies: [] },
    },
  ],
};
