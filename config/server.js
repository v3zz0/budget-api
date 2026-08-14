module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // Senza questo Strapi ignora i cron registrati in src/index.js
  // (salvadanaio mensile + materializzazione transazioni ricorrenti).
  cron: {
    enabled: true,
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});
