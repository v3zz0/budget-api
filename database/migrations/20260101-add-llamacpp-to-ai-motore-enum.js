'use strict';

// Aggiunge 'llamacpp' all'enum aiMotore della tabella up_users.
// Strapi 5 sincronizza il database dal JSON di schema, ma per MySQL
// i valori ENUM vanno alterati a mano con una migration dedicata.

module.exports = {
  async up(knex) {
    // MySQL permette di estendere un ENUM solo con ALTER TABLE ... MODIFY.
    // Knex non supporta nativamente MODIFY COLUMN per ENUM, quindi usiamo raw.
    await knex.raw(
      "ALTER TABLE up_users MODIFY COLUMN ai_motore ENUM('ollama', 'openrouter', 'llamacpp') DEFAULT 'ollama'"
    );
  },

  async down(knex) {
    await knex.raw(
      "ALTER TABLE up_users MODIFY COLUMN ai_motore ENUM('ollama', 'openrouter') DEFAULT 'ollama'"
    );
  },
};