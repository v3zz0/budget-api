'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

// Router standard (find/findOne/...) più le due azioni sui consigli.
module.exports = createCoreRouter('api::consiglio.consiglio', {
  config: {},
  only: ['find', 'findOne'],
});
