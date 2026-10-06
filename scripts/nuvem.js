#!/usr/bin/env node
'use strict';
/**
 * Comandos do dashboard na nuvem (rodar neste computador):
 *
 *   node scripts/nuvem.js esquema        cria/atualiza as tabelas no Postgres
 *   node scripts/nuvem.js enviar         envia contas e PDFs agora
 *   node scripts/nuvem.js admin <usuario> <Nome completo>
 *                                        cria/redefine um administrador na nuvem
 *                                        (a senha é digitada aqui, sem aparecer)
 *   node scripts/nuvem.js status         mostra o último sinal do agente e pedidos
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const readline = require('readline');
const nuvem = require('../src/nuvem');
const { hashSenha, senhaFraca } = require('../nuvem/lib/auth');

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

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'esquema') { await nuvem.esquema(); console.log('Tabelas prontas.'); }
  else if (cmd === 'enviar') { await nuvem.esquema(); await nuvem.migrarUsuarios({ log: console.log }); await nuvem.enviar({ log: console.log }); }
  else if (cmd === 'admin') {
    const [usuario, ...nome] = args;
    if (!/^[a-z0-9._-]{3,32}$/i.test(usuario || '') || !nome.length) {
      console.log('Uso: node scripts/nuvem.js admin <usuario> <Nome completo>'); process.exit(2);
    }
    await nuvem.esquema();
    const s1 = await perguntarOculto('Senha (mín. 10, letras e números): ');
    const fraca = senhaFraca(s1); if (fraca) { console.log(fraca); process.exit(2); }
    const s2 = await perguntarOculto('Repita a senha: ');
    if (s1 !== s2) { console.log('As senhas não conferem.'); process.exit(2); }
    await nuvem.criarAdmin({ usuario, nome: nome.join(' '), senhaHash: hashSenha(s1) });
    console.log(`Administrador "${usuario}" pronto na nuvem.`);
  }
  else if (cmd === 'status') {
    await nuvem.esquema();
    const pg = require('pg'); const cu = new URL(process.env.NUVEM_DATABASE_URL); cu.searchParams.delete('sslmode'); const c = new pg.Client({ connectionString: cu.toString(), ssl: { rejectUnauthorized: true } }); await c.connect();
    const a = (await c.query('SELECT * FROM agente WHERE id = 1')).rows[0];
    const n = (await c.query('SELECT COUNT(*)::int n FROM contas')).rows[0].n;
    const u = (await c.query('SELECT COUNT(*)::int n FROM usuarios')).rows[0].n;
    const cmds = (await c.query('SELECT id, tipo, pedido_por, criado_em, iniciado_em, fim_em, codigo FROM comandos ORDER BY id DESC LIMIT 5')).rows;
    await c.end();
    console.log({ contas: n, usuarios: u, agente: a, ultimosPedidos: cmds });
  }
  else { console.log('Comandos: esquema | enviar | admin <usuario> <Nome> | status'); }
  fecharLeitor();
  await nuvem.fechar();
})().catch(async (e) => { console.error('Erro:', e.message); fecharLeitor(); await nuvem.fechar(); process.exit(1); });
