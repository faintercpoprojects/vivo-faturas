'use strict';

/**
 * Cadastro de acessos às operadoras, por empresa (CNPJ).
 *
 *  - Operadoras que consultam só pelo CNPJ (AONet, Desktop): guarda só o CNPJ.
 *  - Operadoras com login (Vero, Claro, Embratel): guarda o login e a SENHA
 *    criptografada pelo Windows (DPAPI, ligada ao usuário do Windows): só este
 *    usuário, neste computador, consegue ler. A senha nunca vai para a nuvem,
 *    o git ou os logs.
 *  - Vivo: login único da conta MVE (VIVO_USER/VIVO_PASS no .env), cobre todas as empresas.
 *
 * Arquivo: .state/credenciais.json (a pasta .state não vai para o git).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARQUIVO = () => process.env.CREDENCIAIS_PATH || path.join(ROOT, '.state', 'credenciais.json');

const OPERADORAS = {
  desktop:  { nome: 'Desktop',  login: false, robo: true },
  aonet:    { nome: 'AONet',    login: false, robo: true },
  vero:     { nome: 'Vero',     login: true,  robo: true },
  claro:    { nome: 'Claro',    login: true,  robo: false },
  embratel: { nome: 'Embratel (Claro antiga)', login: true, robo: false },
};

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const fmtCnpj = (c) => {
  const d = soDigitos(c);
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
};

// ---------------------------------------------------------------- DPAPI (Windows)
// A senha passa pela entrada padrão do PowerShell (nunca pela linha de comando).
function ps(script, entrada) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: entrada, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('Falha na proteção do Windows: ' + String(r.stderr || '').trim().split('\n')[0]);
  return String(r.stdout || '').trim();
}
const criptografar = (texto) => ps(
  '$t=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString', texto);
const descriptografar = (protegido) => ps(
  '$h=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString $h; ' +
  '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
  protegido);

// ---------------------------------------------------------------- arquivo
function ler() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8')); } catch { return {}; }
}
function gravar(dados) {
  fs.mkdirSync(path.dirname(ARQUIVO()), { recursive: true });
  fs.writeFileSync(ARQUIVO(), JSON.stringify(dados, null, 2));
}

function validarOperadora(op) {
  const k = String(op || '').toLowerCase().trim();
  if (!OPERADORAS[k]) throw new Error(`Operadora desconhecida "${op}". Use: ${Object.keys(OPERADORAS).join(', ')}`);
  return k;
}

/** Cadastra/atualiza o acesso de uma empresa numa operadora. */
function adicionar({ operadora, cnpj, empresa, usuario, senha }) {
  const op = validarOperadora(operadora);
  const doc = soDigitos(cnpj);
  if (doc.length !== 14 && doc.length !== 11) throw new Error('CNPJ/CPF inválido.');
  const info = OPERADORAS[op];
  if (info.login && (!usuario || !senha)) throw new Error(`${info.nome} precisa de login e senha.`);
  const dados = ler();
  dados[op] = dados[op] || {};
  const antes = dados[op][doc] || {};
  dados[op][doc] = {
    cnpj: fmtCnpj(doc),
    empresa: empresa || antes.empresa || null,
    ...(info.login ? { usuario: String(usuario).trim(), senha_protegida: criptografar(String(senha)) } : {}),
    atualizado_em: new Date().toISOString(),
  };
  gravar(dados);
  return dados[op][doc];
}

function remover(operadora, cnpj) {
  const op = validarOperadora(operadora);
  const dados = ler();
  const doc = soDigitos(cnpj);
  if (!dados[op] || !dados[op][doc]) return false;
  delete dados[op][doc];
  gravar(dados);
  return true;
}

/** Lista sem senhas: [{operadora, nome, cnpj, empresa, temLogin, usuario, robo}] */
function listar() {
  const dados = ler();
  const out = [];
  for (const [op, info] of Object.entries(OPERADORAS)) {
    for (const [, e] of Object.entries(dados[op] || {})) {
      out.push({ operadora: op, nome: info.nome, cnpj: e.cnpj, empresa: e.empresa, temLogin: !!e.senha_protegida, usuario: e.usuario || null, robo: info.robo });
    }
  }
  return out;
}

/** CNPJs (só dígitos) cadastrados numa operadora. */
function cnpjsDe(operadora) {
  return Object.keys(ler()[validarOperadora(operadora)] || {});
}

/** Login + senha (em texto) de uma empresa numa operadora — uso só em memória, pelo robô. */
function acesso(operadora, cnpj) {
  const e = (ler()[validarOperadora(operadora)] || {})[soDigitos(cnpj)];
  if (!e || !e.senha_protegida) return null;
  return { usuario: e.usuario, senha: descriptografar(e.senha_protegida) };
}

/**
 * Traz para o cadastro o que hoje está no .env (uma vez, sem sobrescrever):
 * OPERADORAS_CNPJS -> Desktop/AONet; VERO_USUARIO/VERO_SENHA -> Vero.
 */
function importarDoEnv(env = process.env) {
  const dados = ler();
  let n = 0;
  const cnpjs = String(env.OPERADORAS_CNPJS || '').split(',').map(soDigitos).filter((c) => c.length === 14 || c.length === 11);
  for (const op of ['desktop', 'aonet']) {
    for (const c of cnpjs) {
      if ((dados[op] || {})[c]) continue;
      dados[op] = dados[op] || {};
      dados[op][c] = { cnpj: fmtCnpj(c), empresa: null, atualizado_em: new Date().toISOString(), origem: '.env' };
      n++;
    }
  }
  const vu = soDigitos(env.VERO_USUARIO);
  if (vu && env.VERO_SENHA && !(dados.vero || {})[vu]) {
    dados.vero = dados.vero || {};
    dados.vero[vu] = { cnpj: fmtCnpj(vu), empresa: null, usuario: String(env.VERO_USUARIO).trim(), senha_protegida: criptografar(env.VERO_SENHA), atualizado_em: new Date().toISOString(), origem: '.env' };
    n++;
  }
  if (n) gravar(dados);
  return n;
}

module.exports = { OPERADORAS, adicionar, remover, listar, cnpjsDe, acesso, importarDoEnv, fmtCnpj, soDigitos, criptografar, descriptografar };
