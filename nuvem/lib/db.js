'use strict';

/**
 * Acesso ao Postgres. Na Vercel usa o driver HTTP da Neon (DATABASE_URL).
 * Nos testes, `usarBanco()` injeta outra implementação (PGlite).
 * Interface única: q(sql, params) -> linhas.
 */
let impl = null;

function usarBanco(fn) { impl = fn; }

async function q(texto, params = []) {
  if (!impl) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL não configurada na Vercel.');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    impl = (t, p) => sql.query(t, p);
  }
  return impl(texto, params);
}

const um = async (texto, params) => (await q(texto, params))[0] || null;

module.exports = { q, um, usarBanco };
