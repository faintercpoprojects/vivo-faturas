'use strict';

/**
 * Login do dashboard: um usuário e senha por pessoa.
 *
 * - Senhas guardadas com scrypt (hash + salt), nunca em texto.
 * - Sessão em cookie HttpOnly assinado (HMAC com SESSION_SECRET), 7 dias.
 *   Trocar a senha ou desativar o usuário derruba as sessões abertas.
 * - 8 tentativas erradas por IP -> bloqueio de 15 min.
 * - O PRIMEIRO administrador só pode ser criado neste computador (localhost),
 *   nunca pela rede nem pelo link público.
 * - Registro de quem alterou cada conta (tabela historico).
 */

const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const COOKIE = 'cp_sessao';
const DURACAO_MS = 7 * 24 * 3600 * 1000;
const MAX_TENTATIVAS = 8;
const BLOQUEIO_MS = 15 * 60 * 1000;

function criarAuth({ dbFile, segredo }) {
  if (!segredo || segredo.length < 32) throw new Error('SESSION_SECRET ausente ou curto (mín. 32 caracteres).');

  const abrir = () => {
    const d = new DatabaseSync(dbFile);
    d.exec(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE NOT NULL COLLATE NOCASE,
        nome TEXT NOT NULL,
        senha_hash TEXT NOT NULL,
        admin INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        deve_trocar_senha INTEGER NOT NULL DEFAULT 0,
        sessao_versao INTEGER NOT NULL DEFAULT 1,
        ultimo_login TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conta_id INTEGER,
        usuario TEXT,
        acao TEXT NOT NULL,
        detalhes TEXT,
        em TEXT NOT NULL
      );
    `);
    try { d.exec('ALTER TABLE contas ADD COLUMN alterado_por TEXT'); } catch { /* já existe */ }
    return d;
  };
  { const d = abrir(); d.close(); } // garante as tabelas

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
  const senhaTemporaria = () => crypto.randomBytes(9).toString('base64url'); // 12 caracteres

  // ---------------------------------------------------------------- sessão
  const assinar = (dados) => crypto.createHmac('sha256', segredo).update(dados).digest('base64url');
  const emitir = (u) => {
    const dados = Buffer.from(JSON.stringify({ i: u.id, v: u.sessao_versao, e: Date.now() + DURACAO_MS })).toString('base64url');
    return `${dados}.${assinar(dados)}`;
  };
  const lerCookie = (req) => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const viaHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  const gravarCookie = (req, res, valor, maxAge) => {
    const partes = [`${COOKIE}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge / 1000)}`];
    if (viaHttps(req)) partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
  };
  const usuarioDaSessao = (req) => {
    const tok = lerCookie(req);
    if (!tok || !tok.includes('.')) return null;
    const [dados, sig] = tok.split('.');
    const esperado = assinar(dados);
    if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
    let s; try { s = JSON.parse(Buffer.from(dados, 'base64url').toString()); } catch { return null; }
    if (!s || s.e < Date.now()) return null;
    const d = abrir();
    const u = d.prepare('SELECT * FROM usuarios WHERE id = ?').get(s.i);
    d.close();
    if (!u || !u.ativo || u.sessao_versao !== s.v) return null;
    return u;
  };
  const publico = (u) => u && ({ id: u.id, usuario: u.usuario, nome: u.nome, admin: !!u.admin, deveTrocarSenha: !!u.deve_trocar_senha });

  // ---------------------------------------------------------------- proteções
  const tentativas = new Map(); // ip -> { n, ate }
  const ipDe = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const bloqueado = (ip) => { const t = tentativas.get(ip); return t && t.ate > Date.now() && t.n >= MAX_TENTATIVAS; };
  const falhou = (ip) => { const t = tentativas.get(ip); const agora = Date.now(); if (!t || t.ate < agora) tentativas.set(ip, { n: 1, ate: agora + BLOQUEIO_MS }); else t.n++; };
  /** Requisição feita NESTE computador (não pela rede nem pelo túnel). */
  const ehLocal = (req) => {
    const ra = String(req.socket.remoteAddress || '');
    const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    return loop && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
  };
  const totalUsuarios = () => { const d = abrir(); const n = d.prepare('SELECT COUNT(*) n FROM usuarios').get().n; d.close(); return n; };

  /** Middleware: exige login em tudo, menos na tela de login. */
  const LIVRES = new Set(['/login.html', '/api/login', '/api/sessao', '/api/primeiro-acesso', '/favicon.ico']);
  function exigirLogin(req, res, next) {
    // Mutações só da própria página (bloqueia formulários de outros sites).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origem = req.headers.origin;
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (origem && (() => { try { return new URL(origem).host !== host; } catch { return true; } })()) {
        return res.status(403).json({ erro: 'origem não permitida' });
      }
    }
    if (LIVRES.has(req.path)) return next();
    const u = usuarioDaSessao(req);
    if (u) {
      req.usuario = u;
      // Quem precisa trocar a senha só acessa a troca de senha e o "quem sou eu".
      if (u.deve_trocar_senha && req.path.startsWith('/api/') && !['/api/senha', '/api/me', '/api/logout'].includes(req.path)) {
        return res.status(403).json({ erro: 'troque a senha para continuar', trocarSenha: true });
      }
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'faça login' });
    return res.redirect('/login.html');
  }
  const soAdmin = (req, res, next) => (req.usuario && req.usuario.admin ? next() : res.status(403).json({ erro: 'apenas administradores' }));

  // ---------------------------------------------------------------- rotas
  function rotas(app) {
    // Estado da tela de login: precisa criar o 1º admin? Este PC pode criar?
    app.get('/api/sessao', (req, res) => {
      res.json({ logado: !!usuarioDaSessao(req), semUsuarios: totalUsuarios() === 0, local: ehLocal(req) });
    });

    app.post('/api/primeiro-acesso', (req, res) => {
      if (totalUsuarios() > 0) return res.status(409).json({ erro: 'já existe usuário cadastrado' });
      if (!ehLocal(req)) return res.status(403).json({ erro: 'o primeiro administrador só pode ser criado no computador do servidor' });
      const { usuario, nome, senha } = req.body || {};
      if (!/^[a-z0-9._-]{3,32}$/i.test(usuario || '')) return res.status(400).json({ erro: 'usuário: 3 a 32 letras, números, ponto, hífen ou _' });
      const fraca = senhaFraca(senha); if (fraca) return res.status(400).json({ erro: fraca });
      const d = abrir();
      const info = d.prepare('INSERT INTO usuarios (usuario, nome, senha_hash, admin, created_at) VALUES (?,?,?,1,?)')
        .run(usuario.trim(), String(nome || usuario).trim(), hashSenha(senha), new Date().toISOString());
      const u = d.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(info.lastInsertRowid));
      d.close();
      gravarCookie(req, res, emitir(u), DURACAO_MS);
      res.json(publico(u));
    });

    app.post('/api/login', (req, res) => {
      const ip = ipDe(req);
      if (bloqueado(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
      const { usuario, senha } = req.body || {};
      const d = abrir();
      const u = d.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(String(usuario || '').trim());
      const ok = u && u.ativo && conferirSenha(senha || '', u.senha_hash);
      if (!ok) { d.close(); falhou(ip); return res.status(401).json({ erro: 'Usuário ou senha incorretos.' }); }
      d.prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
      d.close();
      tentativas.delete(ip);
      gravarCookie(req, res, emitir(u), DURACAO_MS);
      res.json(publico(u));
    });

    app.post('/api/logout', (req, res) => { gravarCookie(req, res, '', 0); res.json({ ok: true }); });
    app.get('/api/me', (req, res) => res.json(publico(req.usuario)));

    app.post('/api/senha', (req, res) => {
      const { atual, nova } = req.body || {};
      const u = req.usuario;
      if (!conferirSenha(atual || '', u.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
      const fraca = senhaFraca(nova); if (fraca) return res.status(400).json({ erro: fraca });
      const d = abrir();
      d.prepare('UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = 0, sessao_versao = sessao_versao + 1 WHERE id = ?').run(hashSenha(nova), u.id);
      const novo = d.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
      d.close();
      gravarCookie(req, res, emitir(novo), DURACAO_MS); // outras sessões caem; esta continua
      res.json({ ok: true });
    });

    // ---- administração de usuários
    app.get('/api/usuarios', soAdmin, (req, res) => {
      const d = abrir();
      const lista = d.prepare('SELECT id, usuario, nome, admin, ativo, deve_trocar_senha, ultimo_login, created_at FROM usuarios ORDER BY nome').all();
      d.close();
      res.json(lista);
    });
    app.post('/api/usuarios', soAdmin, (req, res) => {
      const { usuario, nome, admin } = req.body || {};
      if (!/^[a-z0-9._-]{3,32}$/i.test(usuario || '')) return res.status(400).json({ erro: 'usuário: 3 a 32 letras, números, ponto, hífen ou _' });
      if (!String(nome || '').trim()) return res.status(400).json({ erro: 'informe o nome' });
      const temp = senhaTemporaria();
      const d = abrir();
      try {
        d.prepare('INSERT INTO usuarios (usuario, nome, senha_hash, admin, deve_trocar_senha, created_at) VALUES (?,?,?,?,1,?)')
          .run(usuario.trim(), nome.trim(), hashSenha(temp), admin ? 1 : 0, new Date().toISOString());
      } catch (e) {
        d.close();
        return res.status(409).json({ erro: /UNIQUE/.test(e.message) ? 'esse usuário já existe' : e.message });
      }
      d.close();
      // A senha temporária aparece UMA vez para o administrador repassar.
      res.json({ ok: true, usuario: usuario.trim(), senhaTemporaria: temp });
    });
    app.patch('/api/usuarios/:id', soAdmin, (req, res) => {
      const id = Number(req.params.id);
      const { ativo, admin, redefinirSenha } = req.body || {};
      if (id === req.usuario.id && (ativo === false || admin === false)) return res.status(400).json({ erro: 'você não pode tirar o próprio acesso de administrador' });
      const d = abrir();
      let temp = null;
      if (typeof ativo === 'boolean') d.prepare('UPDATE usuarios SET ativo = ?, sessao_versao = sessao_versao + 1 WHERE id = ?').run(ativo ? 1 : 0, id);
      if (typeof admin === 'boolean') d.prepare('UPDATE usuarios SET admin = ? WHERE id = ?').run(admin ? 1 : 0, id);
      if (redefinirSenha) {
        temp = senhaTemporaria();
        d.prepare('UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = 1, sessao_versao = sessao_versao + 1 WHERE id = ?').run(hashSenha(temp), id);
      }
      d.close();
      res.json({ ok: true, senhaTemporaria: temp });
    });
  }

  /** Grava no histórico quem fez o quê numa conta. */
  function registrar(req, contaId, acao, detalhes) {
    const d = abrir();
    d.prepare('INSERT INTO historico (conta_id, usuario, acao, detalhes, em) VALUES (?,?,?,?,?)')
      .run(contaId ?? null, req.usuario ? req.usuario.nome : null, acao, detalhes ? JSON.stringify(detalhes) : null, new Date().toISOString());
    if (contaId && req.usuario && acao !== 'excluir') d.prepare('UPDATE contas SET alterado_por = ? WHERE id = ?').run(req.usuario.nome, contaId);
    d.close();
  }

  return { exigirLogin, rotas, registrar, soAdmin, hashSenha, conferirSenha, senhaFraca, abrir };
}

module.exports = { criarAuth };
