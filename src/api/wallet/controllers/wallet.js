'use strict';

/**
 * wallet controller
 *
 * Override owner-aware: ogni utente autenticato vede e modifica solo i propri
 * wallet. Il filtro è applicato lato server: il client non può aggirarlo
 * passando filtri custom.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::wallet.wallet';

module.exports = createCoreController(UID, ({ strapi }) => ({
  async find(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    // Componiamo il filtro server-side con `$and` per non sovrascrivere
    // eventuali filtri del client che insistono sullo stesso campo.
    ctx.query = ctx.query || {};
    const filtroClient = ctx.query.filters || {};
    ctx.query.filters = {
      $and: [
        filtroClient,
        { users_permissions_user: { id: { $eq: userId } } },
      ],
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const { id: documentId } = ctx.params;
    const entry = await strapi.documents(UID).findOne({
      documentId,
      populate: { users_permissions_user: true },
    });
    if (!entry || !entry.users_permissions_user || entry.users_permissions_user.id !== userId) {
      return ctx.notFound();
    }
    return super.findOne(ctx);
  },

  async create(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    // Forziamo l'owner: ignoriamo qualunque users_permissions_user passato dal client
    ctx.request.body = ctx.request.body || {};
    ctx.request.body.data = {
      ...(ctx.request.body.data || {}),
      users_permissions_user: userId,
    };
    return super.create(ctx);
  },

  async update(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const { id: documentId } = ctx.params;
    const entry = await strapi.documents(UID).findOne({
      documentId,
      populate: { users_permissions_user: true },
    });
    if (!entry || !entry.users_permissions_user || entry.users_permissions_user.id !== userId) {
      return ctx.notFound();
    }

    // Impedisci al client di cambiare owner via update
    if (ctx.request.body && ctx.request.body.data) {
      delete ctx.request.body.data.users_permissions_user;
    }
    return super.update(ctx);
  },

  async delete(ctx) {
    const userId = ctx.state.user && ctx.state.user.id;
    if (!userId) return ctx.unauthorized();

    const { id: documentId } = ctx.params;
    const entry = await strapi.documents(UID).findOne({
      documentId,
      populate: { users_permissions_user: true },
    });
    if (!entry || !entry.users_permissions_user || entry.users_permissions_user.id !== userId) {
      return ctx.notFound();
    }
    return super.delete(ctx);
  },
}));
