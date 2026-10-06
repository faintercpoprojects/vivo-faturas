'use strict';

/**
 * Login da versão na nuvem — mesmo formato de senha (scrypt) e de sessão do
 * dashboard local, para os usuários migrarem sem recriar senhas.
 * Diferenças da nuvem: o bloqueio por tentativas fica no banco (as funções
 * da Vercel não guardam memória) e o 1º administrador é criado pelo
 * computador do escritório (scripts/nuvem.js admin), nunca pela internet.
 */
const crypto = require('crypto');
const { q, um } = require('./db');

const COOKIE = 'cp_sessao';
const DURACAO_MS = 7 * 24 * 3600 * 1000;
const MAX_TENTATIVAS = 8;
const BLOQUEIO_MS = 15 * 60 * 1000;

const segredo = () => {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw new Error('SESSION_SECRET ausente ou curto na Vercel (mín. 32 caracteres).');
  return s;
};

// ---------------------------------------------------------------- senhas
const hashSenha = (senha) => {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
};
const conferirSenha = (senha, guardado) => {
  const [alg, s, h] = String(guardado).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const esperado = Buffer.from(h, 'base64');
  const calc = crypto.scryptSync(String(senha), Buffer.from(s, 'base64'), esperado.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calc, esperado);
};
const senhaFraca = (s) => {
  s = String(s || '');
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return null;
};
const senhaTemporaria = () => crypto.randomBytes(9).toString('base64url');

// ---------------------------------------------------------------- sessão
const assinar = (dados) => crypto.createHmac('sha256', segredo()).update(dados).digest('base64url');
const emitir = (u) => {
  const dados = Buffer.from(JSON.stringify({ i: u.id, v: u.sessao_versao, e: Date.now() + DURACAO_MS })).toString('base64url');
  return `${dados}.${assinar(dados)}`;
};
const lerCookie = (req) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const gravarCookie = (res, valor, maxAge) => {
  // Na Vercel é sempre HTTPS: cookie Secure.
  const local = process.env.NUVEM_LOCAL === '1';
  const partes = [`${COOKIE}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge / 1000)}`];
  if (!local) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
};
async function usuarioDaSessao(req) {
  const tok = lerCookie(req);
  if (!tok || !tok.includes('.')) return null;
  const [dados, sig] = tok.split('.');
  const esperado = assinar(dados);
  if (!sig || sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  let s; try { s = JSON.parse(Buffer.from(dados, 'base64url').toString()); } catch { return null; }
  if (!s || s.e < Date.now()) return null;
  const u = await um('SELECT * FROM usuarios WHERE id = $1', [s.i]);
  if (!u || !u.ativo || u.sessao_versao !== s.v) return null;
  return u;
}
const publico = (u) => u && ({ id: u.id, usuario: u.usuario, nome: u.nome, admin: !!u.admin, deveTrocarSenha: !!u.deve_trocar_senha });

// ---------------------------------------------------------------- tentativas
const ipDe = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
async function bloqueado(ip) {
  const t = await um('SELECT n, ate FROM tentativas WHERE ip = $1', [ip]);
  return !!(t && Number(t.ate) > Date.now() && t.n >= MAX_TENTATIVAS);
}
async function falhou(ip) {
  const agora = Date.now();
  await q(`INSERT INTO tentativas (ip, n, ate) VALUES ($1, 1, $2)
           ON CONFLICT (ip) DO UPDATE SET
             n   = CASE WHEN tentativas.ate < $3 THEN 1 ELSE tentativas.n + 1 END,
             ate = CASE WHEN tentativas.ate < $3 THEN $2 ELSE tentativas.ate END`, [ip, agora + BLOQUEIO_MS, agora]);
}

/** Grava no histórico quem fez o quê numa conta. */
async function registrar(usuario, contaId, acao, detalhes) {
  await q('INSERT INTO historico (conta_id, usuario, acao, detalhes, em) VALUES ($1,$2,$3,$4,$5)',
    [contaId ?? null, usuario ? usuario.nome : null, acao, detalhes ? JSON.stringify(detalhes) : null, new Date().toISOString()]);
  if (contaId && usuario && acao !== 'excluir') await q('UPDATE contas SET alterado_por = $1 WHERE id = $2', [usuario.nome, contaId]);
}

module.exports = {
  COOKIE, DURACAO_MS, hashSenha, conferirSenha, senhaFraca, senhaTemporaria,
  emitir, gravarCookie, usuarioDaSessao, publico, ipDe, bloqueado, falhou, registrar,
};
