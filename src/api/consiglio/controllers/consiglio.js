'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::consiglio.consiglio';
const CAT_UID = 'api::categorie.categorie';

// Un consiglio è dell'utente se lo è la categoria a cui punta.
async function consiglioDelloUtente(documentId, userId) {
  const c = await strapi.documents(UID).findOne({
    documentId,
    populate: { categorie: { populate: { wallet: { populate: { users_permissions_user: true } } } } },
  });
  const proprietario = c?.categorie?.wallet?.users_permissions_user?.id;
  return proprietario === userId ? c : null;
}

module.exports = createCoreController(UID, ({ strapi }) => ({
  // Solo i consigli dei propri wallet, mai quelli altrui.
  async find(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    ctx.query = ctx.query || {};
    ctx.query.filters = {
      $and: [
        ctx.query.filters || {},
        { categorie: { wallet: { users_permissions_user: { id: { $eq: userId } } } } },
      ],
    };
    return super.find(ctx);
  },

  /**
   * Applica il consiglio: scrive il nuovo budget sulla categoria.
   * È il motivo per cui la feature esiste — senza questo tap resta un commento.
   */
  async applica(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const consiglio = await consiglioDelloUtente(ctx.params.id, userId);
    if (!consiglio) return ctx.notFound();
    if (consiglio.stato === 'applicato') return ctx.badRequest('Già applicato');

    await strapi.documents(CAT_UID).update({
      documentId: consiglio.categorie.documentId,
      data: { Budget_categoria: consiglio.budgetProposto },
    });
    await strapi.documents(UID).update({
      documentId: consiglio.documentId,
      data: { stato: 'applicato' },
    });

    return { ok: true, budget: consiglio.budgetProposto };
  },

  // "letto" spegne il pallino, "ignorato" toglie il consiglio dalla lista e
  // impedisce che venga rigenerato identico il mese dopo.
  async segna(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const stato = ctx.request.body?.stato;
    if (!['letto', 'ignorato'].includes(stato)) {
      return ctx.badRequest('stato deve essere "letto" o "ignorato"');
    }
    const consiglio = await consiglioDelloUtente(ctx.params.id, userId);
    if (!consiglio) return ctx.notFound();

    await strapi.documents(UID).update({
      documentId: consiglio.documentId,
      data: { stato },
    });
    return { ok: true, stato };
  },
}));
