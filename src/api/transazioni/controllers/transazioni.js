'use strict';

/**
 * transazioni controller
 *
 * Owner-aware: una transazione appartiene all'utente se la sua categoria
 * appartiene a un wallet dell'utente.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::transazioni.transazioni';
const CATEGORIA_UID = 'api::categorie.categorie';

async function transazioneDelloUtente(strapi, documentId, userId) {
  const entry = await strapi.documents(UID).findOne({
    documentId,
    populate: {
      categorie: { populate: { wallet: { populate: { users_permissions_user: true } } } },
    },
  });
  if (
    !entry ||
    !entry.categorie ||
    !entry.categorie.wallet ||
    !entry.categorie.wallet.users_permissions_user
  ) return null;
  if (entry.categorie.wallet.users_permissions_user.id !== userId) return null;
  return entry;
}

async function categoriaDelloUtente(strapi, documentId, userId) {
  const entry = await strapi.documents(CATEGORIA_UID).findOne({
    documentId,
    populate: { wallet: { populate: { users_permissions_user: true } } },
  });
  if (!entry || !entry.wallet || !entry.wallet.users_permissions_user) return null;
  if (entry.wallet.users_permissions_user.id !== userId) return null;
  return entry;
}

module.exports = createCoreController(UID, ({ strapi }) => ({
  async find(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    // `$and` per coesistere col filtro client (es. filtro per categoria).
    ctx.query = ctx.query || {};
    const filtroClient = ctx.query.filters || {};
    ctx.query.filters = {
      $and: [
        filtroClient,
        { categorie: { wallet: { users_permissions_user: { id: { $eq: userId } } } } },
      ],
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await transazioneDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();
    return super.findOne(ctx);
  },

  async create(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const catRef = ctx.request.body && ctx.request.body.data && ctx.request.body.data.categorie;
    if (!catRef) return ctx.badRequest('Categoria mancante');

    const cat = await categoriaDelloUtente(strapi, catRef, userId);
    if (!cat) return ctx.forbidden('Categoria non accessibile');

    return super.create(ctx);
  },

  async update(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await transazioneDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();

    // Riassegnazione a categoria altrui: blocca
    const nuovaCat = ctx.request.body && ctx.request.body.data && ctx.request.body.data.categorie;
    if (nuovaCat && nuovaCat !== ok.categorie.documentId) {
      const target = await categoriaDelloUtente(strapi, nuovaCat, userId);
      if (!target) return ctx.forbidden('Categoria di destinazione non accessibile');
    }

    return super.update(ctx);
  },

  async delete(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await transazioneDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();
    return super.delete(ctx);
  },
}));
