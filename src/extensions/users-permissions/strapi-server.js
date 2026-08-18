'use strict';

// L'app modifica il profilo con `PUT /api/users/:id` (nome, email, orario delle
// notifiche, impostazioni AI), e per farlo il permesso `update` dev'essere
// acceso sul ruolo Authenticated.
//
// Il problema è che quel permesso, così com'è in users-permissions, NON è
// legato al proprietario: un qualunque utente autenticato può passare l'id di
// un altro e riscrivergli email e password. Con un utente solo è teorico, ma
// questo repository è pubblico e chiunque lo self-hosti in due si porta dietro
// il buco senza saperlo.
//
// Stessa filosofia dei controller di wallet/categorie/transazioni: il filtro sta
// sul server, non nel client.
module.exports = (plugin) => {
  const updateOriginale = plugin.controllers.user.update;

  plugin.controllers.user.update = async (ctx) => {
    const utente = ctx.state.user;
    if (!utente) return ctx.unauthorized();

    // `id` può arrivare come stringa dalla rotta: confronto lasco voluto.
    if (String(ctx.params.id) !== String(utente.id)) {
      return ctx.forbidden('Puoi modificare solo il tuo profilo');
    }

    // Ruolo, blocco e conferma non si toccano dall'app: sono la serratura, e
    // non ha senso lasciarne la chiave dentro. Restano modificabili solo dal
    // pannello di amministrazione.
    for (const campo of ['role', 'blocked', 'confirmed', 'provider']) {
      delete ctx.request.body[campo];
    }

    return updateOriginale(ctx);
  };

  return plugin;
};
