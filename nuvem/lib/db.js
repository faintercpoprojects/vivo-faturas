'use strict';

/**
 * Acesso ao Postgres. Na Vercel usa o driver HTTP da Neon (DATABASE_URL).
 * Nos testes, `usarBanco()` injeta outra implementação (PGlite).
 * Interface única: q(sql, params) -> linhas.
 * Na 1ª chamada de cada instância, garante as tabelas (esquema.sql, idempotente).
 */
const fs = require('fs');
const path = require('path');

let impl = null;
let preparo = null;

function usarBanco(fn) { impl = fn; preparo = null; }

function conexao() {
  if (!impl) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL não configurada na Vercel.');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    impl = (t, p) => sql.query(t, p);
  }
  return impl;
}

/** Cria/atualiza as tabelas uma vez por instância (comandos IF NOT EXISTS). */
function garantirEsquema() {
  if (!preparo) {
    const exec = conexao();
    const comandos = fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    preparo = (async () => { for (const c of comandos) await exec(c, []); })().catch((e) => { preparo = null; throw e; });
  }
  return preparo;
}

async function q(texto, params = []) {
  const exec = conexao();
  await garantirEsquema();
  return exec(texto, params);
}

const um = async (texto, params) => (await q(texto, params))[0] || null;

module.exports = { q, um, usarBanco, garantirEsquema };
