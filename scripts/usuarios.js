#!/usr/bin/env node
'use strict';
/**
 * Usuários do dashboard (local e, se configurado, também na nuvem):
 *
 *   node scripts/usuarios.js listar
 *   node scripts/usuarios.js redefinir <usuario>          nova senha (digitada aqui, sem aparecer)
 *   node scripts/usuarios.js redefinir <usuario> <novo>   troca também o nome de usuário
 *
 * A troca derruba as sessões abertas desse usuário em outros aparelhos.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { hashSenha, senhaFraca } = require('../nuvem/lib/auth');

const DB = process.env.DB_PATH ? path.resolve(__dirname, '..', process.env.DB_PATH) : path.resolve(__dirname, '..', '.state', 'contas.db');

// Um único leitor, com fila de linhas (nenhuma resposta se perde) e sem eco da senha.
let rl = null;
let prompt = '';
const fila = [];
const esperando = [];
function perguntarOculto(texto) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.on('line', (l) => { const w = esperando.shift(); if (w) w(l); else fila.push(l); });
    rl.on('close', () => { while (esperando.length) esperando.shift()(''); });
  }
  prompt = texto;
  rl.setPrompt(texto); rl.prompt();
  return new Promise((resolve) => {
    const fim = (r) => { process.stdout.write('\n'); resolve(r); };
    if (fila.length) fim(fila.shift()); else esperando.push(fim);
  });
}
const fecharLeitor = () => { if (rl) { rl.close(); rl = null; } };

async function nuvemQuery(sql, params) {
  if (!process.env.NUVEM_DATABASE_URL) return null;
  const { Client } = require('pg');
  const u = new URL(process.env.NUVEM_DATABASE_URL); u.searchParams.delete('sslmode');
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: true } });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

(async () => {
  const [cmd, usuario, novo] = process.argv.slice(2);
  const d = new DatabaseSync(DB);

  if (cmd === 'listar' || !cmd) {
    const us = d.prepare('SELECT usuario, nome, admin, ativo, ultimo_login FROM usuarios ORDER BY nome').all();
    if (!us.length) console.log('Nenhum usuário. Crie o primeiro em http://localhost:4599 neste computador.');
    for (const u of us) console.log(`- ${u.usuario} | ${u.nome} | ${u.admin ? 'admin' : 'comum'} | ${u.ativo ? 'ativo' : 'DESATIVADO'} | último acesso: ${u.ultimo_login || 'nunca'}`);
    if (!cmd) console.log('\nUso: node scripts/usuarios.js redefinir <usuario> [novo_usuario]');
    return;
  }

  if (cmd === 'redefinir') {
    const u = d.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(String(usuario || ''));
    if (!u) { console.log(`Usuário "${usuario}" não encontrado. Use: node scripts/usuarios.js listar`); process.exitCode = 2; return; }
    if (novo && !/^[a-z0-9._-]{3,32}$/i.test(novo)) { console.log('Novo usuário: 3 a 32 letras, números, ponto, hífen ou _'); process.exitCode = 2; return; }
    if (novo && novo.toLowerCase() !== u.usuario.toLowerCase() && d.prepare('SELECT 1 FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(novo)) {
      console.log(`Já existe o usuário "${novo}".`); process.exitCode = 2; return;
    }
    console.log(`Redefinindo ${u.nome} (${u.usuario})${novo ? ` -> novo usuário: ${novo}` : ''}`);
    const s1 = await perguntarOculto('Nova senha (mín. 10, letras e números): ');
    const fraca = senhaFraca(s1); if (fraca) { console.log(fraca); process.exitCode = 2; return; }
    const s2 = await perguntarOculto('Repita a nova senha: ');
    if (s1 !== s2) { console.log('As senhas não conferem. Nada foi alterado.'); process.exitCode = 2; return; }
    const hash = hashSenha(s1);
    const final = novo || u.usuario;

    d.prepare('UPDATE usuarios SET usuario = ?, senha_hash = ?, deve_trocar_senha = 0, ativo = 1, sessao_versao = sessao_versao + 1 WHERE id = ?')
      .run(final, hash, u.id);
    console.log(`✓ Dashboard local: usuário "${final}" com a nova senha.`);

    try {
      const r = await nuvemQuery(
        `UPDATE usuarios SET usuario = $1, senha_hash = $2, deve_trocar_senha = 0, ativo = 1, sessao_versao = sessao_versao + 1
         WHERE lower(usuario) = lower($3) RETURNING id`, [final, hash, u.usuario]);
      if (r === null) console.log('  (nuvem ainda não configurada — quando conectar, os usuários são copiados com esta senha)');
      else if (r.length) console.log(`✓ Nuvem: usuário "${final}" atualizado.`);
      else console.log('  (usuário ainda não existe na nuvem — será copiado na primeira sincronização)');
    } catch (e) {
      console.log(`  Atenção: não consegui atualizar na nuvem (${e.message}). O dashboard local já está com a nova senha.`);
    }
    return;
  }
  console.log('Comandos: listar | redefinir <usuario> [novo_usuario]');
})().catch((e) => { console.error('Erro:', e.message); process.exitCode = 1; }).finally(fecharLeitor);
