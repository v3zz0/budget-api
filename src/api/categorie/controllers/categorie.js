'use strict';

/**
 * categorie controller
 *
 * Owner-aware: una categoria appartiene all'utente se il suo wallet padre
 * appartiene all'utente. Il filtro è applicato lato server.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::categorie.categorie';
const WALLET_UID = 'api::wallet.wallet';

// Helper: verifica che una categoria (by documentId) appartenga all'utente
async function categoriaDelloUtente(strapi, documentId, userId) {
  const entry = await strapi.documents(UID).findOne({
    documentId,
    populate: { wallet: { populate: { users_permissions_user: true } } },
  });
  if (!entry || !entry.wallet || !entry.wallet.users_permissions_user) return null;
  if (entry.wallet.users_permissions_user.id !== userId) return null;
  return entry;
}

// Helper: verifica che un wallet (by documentId) appartenga all'utente
async function walletDelloUtente(strapi, documentId, userId) {
  const entry = await strapi.documents(WALLET_UID).findOne({
    documentId,
    populate: { users_permissions_user: true },
  });
  if (!entry || !entry.users_permissions_user) return null;
  if (entry.users_permissions_user.id !== userId) return null;
  return entry;
}

module.exports = createCoreController(UID, ({ strapi }) => ({
  async find(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    // `$and` evita che il filtro server-side sovrascriva quello del client
    // (es. il client filtra per wallet.documentId).
    ctx.query = ctx.query || {};
    const filtroClient = ctx.query.filters || {};
    ctx.query.filters = {
      $and: [
        filtroClient,
        { wallet: { users_permissions_user: { id: { $eq: userId } } } },
      ],
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await categoriaDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();
    return super.findOne(ctx);
  },

  async create(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const walletRef = ctx.request.body && ctx.request.body.data && ctx.request.body.data.wallet;
    if (!walletRef) return ctx.badRequest('Wallet mancante');

    const wallet = await walletDelloUtente(strapi, walletRef, userId);
    if (!wallet) return ctx.forbidden('Wallet non accessibile');

    return super.create(ctx);
  },

  async update(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await categoriaDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();

    // Se l'utente tenta di riassegnare la categoria a un wallet altrui, blocca
    const nuovoWallet = ctx.request.body && ctx.request.body.data && ctx.request.body.data.wallet;
    if (nuovoWallet && nuovoWallet !== ok.wallet.documentId) {
      const target = await walletDelloUtente(strapi, nuovoWallet, userId);
      if (!target) return ctx.forbidden('Wallet di destinazione non accessibile');
    }

    return super.update(ctx);
  },

  async delete(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const ok = await categoriaDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();
    return super.delete(ctx);
  },
}));
