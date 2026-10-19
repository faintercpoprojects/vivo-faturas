#!/usr/bin/env node
'use strict';
/**
 * Acessos das operadoras por empresa (rodar neste computador):
 *
 *   node scripts/credenciais.js adicionar                pergunta tudo
 *   node scripts/credenciais.js adicionar claro 68165786000130
 *   node scripts/credenciais.js listar                   o que está cadastrado (sem senhas)
 *   node scripts/credenciais.js remover claro 68165786000130
 *
 * AONet e Desktop: só o CNPJ. Vero, Claro e Embratel: login e senha
 * (a senha é digitada sem aparecer e guardada criptografada pelo Windows).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const readline = require('readline');
const C = require('../src/credenciais');

// Leitor único com fila de linhas; "oculto" não mostra o que é digitado.
let rl = null; let prompt = ''; let oculto = false;
const fila = []; const esperando = [];
function perguntar(texto, { esconder = false } = {}) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    rl._writeToOutput = (s) => { if (!oculto || s.includes(prompt)) rl.output.write(oculto ? prompt : s); };
    rl.on('line', (l) => { const w = esperando.shift(); if (w) w(l); else fila.push(l); });
    rl.on('close', () => { while (esperando.length) esperando.shift()(''); });
  }
  prompt = texto; oculto = esconder;
  rl.setPrompt(texto); rl.prompt();
  return new Promise((resolve) => {
    const fim = (r) => { if (esconder) process.stdout.write('\n'); oculto = false; resolve(String(r).trim()); };
    if (fila.length) fim(fila.shift()); else esperando.push(fim);
  });
}
const fechar = () => { if (rl) { rl.close(); rl = null; } };

function mostrarLista() {
  const lista = C.listar();
  if (!lista.length) { console.log('Nenhum acesso cadastrado ainda.'); return; }
  console.log('\nOperadora                 | CNPJ                | Empresa                 | Acesso');
  console.log('--------------------------+---------------------+-------------------------+--------------------------');
  for (const a of lista) {
    const acesso = C.OPERADORAS[a.operadora].login ? (a.temLogin ? `login ${a.usuario}` : 'SEM LOGIN') : 'só CNPJ';
    const robo = a.robo ? '' : '  (robô em construção)';
    console.log(`${a.nome.padEnd(25)} | ${String(a.cnpj).padEnd(19)} | ${String(a.empresa || '-').slice(0, 23).padEnd(23)} | ${acesso}${robo}`);
  }
  console.log('\nVivo: login único da conta MVE (no .env), cobre todas as empresas.');
}

(async () => {
  const [cmd, opArg, cnpjArg] = process.argv.slice(2);
  // Na 1ª vez, traz o que já existia no .env (CNPJ da Desktop/AONet e login da Vero).
  const importados = C.importarDoEnv();
  if (importados) console.log(`(${importados} acesso(s) trazido(s) do .env para o cadastro)`);

  if (!cmd || cmd === 'listar') {
    mostrarLista();
    if (!cmd) console.log('\nComandos: adicionar [operadora] [cnpj] | listar | remover <operadora> <cnpj>');
    return;
  }

  if (cmd === 'remover') {
    if (!opArg || !cnpjArg) { console.log('Uso: node scripts/credenciais.js remover <operadora> <cnpj>'); process.exitCode = 2; return; }
    console.log(C.remover(opArg, cnpjArg) ? 'Removido.' : 'Não havia esse acesso.');
    return;
  }

  if (cmd === 'adicionar') {
    let op = opArg;
    if (!op) {
      const ops = Object.entries(C.OPERADORAS);
      ops.forEach(([k, v], i) => console.log(`  ${i + 1}) ${v.nome}${v.login ? ' (login e senha)' : ' (só CNPJ)'}`));
      const r = await perguntar('Operadora (número ou nome): ');
      op = /^\d+$/.test(r) ? (ops[Number(r) - 1] || [])[0] : r.toLowerCase();
    }
    const info = C.OPERADORAS[String(op || '').toLowerCase()];
    if (!info) { console.log(`Operadora inválida. Use: ${Object.keys(C.OPERADORAS).join(', ')}`); process.exitCode = 2; return; }
    const cnpj = cnpjArg || await perguntar('CNPJ da empresa: ');
    const empresa = await perguntar('Nome da empresa (opcional, Enter para pular): ');
    let usuario, senha;
    if (info.login) {
      usuario = await perguntar(`Login no site da ${info.nome}: `);
      senha = await perguntar('Senha (não aparece enquanto digita): ', { esconder: true });
      const conf = await perguntar('Repita a senha: ', { esconder: true });
      if (!usuario || !senha) { console.log('Login e senha são obrigatórios. Nada foi salvo.'); process.exitCode = 2; return; }
      if (senha !== conf) { console.log('As senhas não conferem. Nada foi salvo.'); process.exitCode = 2; return; }
    }
    try {
      const e = C.adicionar({ operadora: op, cnpj, empresa: empresa || null, usuario, senha });
      console.log(`✓ ${info.nome} · ${e.cnpj}${e.empresa ? ' · ' + e.empresa : ''} cadastrado${info.login ? ' (senha guardada criptografada neste computador)' : ''}.`);
      if (!info.robo) console.log(`  O robô da ${info.nome} ainda está em construção: o acesso fica guardado para quando ele estiver pronto.`);
    } catch (e) {
      console.log('Não foi possível salvar:', e.message); process.exitCode = 2;
    }
    return;
  }
  console.log('Comandos: adicionar [operadora] [cnpj] | listar | remover <operadora> <cnpj>');
})().catch((e) => { console.error('Erro:', e.message); process.exitCode = 1; }).finally(fechar);
