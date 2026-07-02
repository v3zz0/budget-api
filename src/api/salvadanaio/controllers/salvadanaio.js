'use strict';

/**
 * salvadanaio controller
 *
 * Owner-aware: l'utente vede e modifica solo i salvadanai dei propri wallet.
 * `risparmiato` è il valore inserito a mano dall'utente; il cron a fine mese
 * crea il record del nuovo mese a 0 (il record del mese che finisce resta
 * com'è e diventa parte dello storico).
 * `delete` resta disabilitato: lo storico non si cancella dal client.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::salvadanaio.salvadanaio';
const WALLET_UID = 'api::wallet.wallet';

async function salvadanaioDelloUtente(strapi, documentId, userId) {
  const entry = await strapi.documents(UID).findOne({
    documentId,
    populate: { wallet: { populate: { users_permissions_user: true } } },
  });
  if (!entry || !entry.wallet || !entry.wallet.users_permissions_user) return null;
  if (entry.wallet.users_permissions_user.id !== userId) return null;
  return entry;
}

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

    // Componiamo il filtro server-side con `$and` per non sovrascrivere
    // eventuali filtri del client sulla stessa relazione `wallet`.
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

    const ok = await salvadanaioDelloUtente(strapi, ctx.params.id, userId);
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

    const ok = await salvadanaioDelloUtente(strapi, ctx.params.id, userId);
    if (!ok) return ctx.notFound();

    // Impedisci di riassegnare il record a un wallet altrui via update
    if (ctx.request.body && ctx.request.body.data) {
      delete ctx.request.body.data.wallet;
    }
    return super.update(ctx);
  },

  async delete(ctx) {
    return ctx.methodNotAllowed('Gli snapshot non sono eliminabili');
  },
}));
