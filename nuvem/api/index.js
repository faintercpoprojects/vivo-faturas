'use strict';

/**
 * API do dashboard na nuvem — UMA função só (o plano gratuito da Vercel
 * limita o número de funções). O vercel.json manda /api/<rota> para cá com
 * ?rota=<rota>. Mesmas rotas do dashboard local, para o front ser o mesmo.
 */
const { q, um } = require('../lib/db');
const A = require('../lib/auth');
const E = require('../lib/email');
const crypto = require('crypto');

const MINUTOS_LINK = 30;
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
/** Endereço do site para o link do e-mail (APP_URL; senão o próprio domínio da Vercel). */
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (/^[a-z0-9.-]+\.vercel\.app$/i.test(host)) return `https://${host}`;
  if (/^localhost(:\d+)?$/i.test(host)) return `http://${host}`;
  return 'https://contas-cpo.vercel.app';
}

const hoje = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // horário de Brasília
const agora = () => new Date().toISOString();

// ---------------------------------------------------------------- regras (iguais ao local)
function situacao(c) {
  const interno = (c.status_interno || '').toLowerCase();
  if (interno.includes('pag') || interno.includes('baix')) return c.status_interno;
  if ((c.status_portal || '').toLowerCase().includes('pag')) return 'Paga (portal)';
  if (c.data_vencimento && c.data_vencimento < hoje()) return 'Vencida';
  return 'A vencer';
}
function relevante(c) {
  if ((c.origem || '') === 'manual') return true;
  return /pag|pronta|pendente|atrasad|vencid/.test((c.status_portal || '').toLowerCase());
}
const EDITAVEIS = ['status_interno', 'valor_pago', 'data_pagamento', 'data_baixa', 'forma_pagamento', 'banco_conta', 'comprovante', 'observacoes'];

const SELECT_CONTAS = `
  SELECT c.*,
    EXISTS (SELECT 1 FROM arquivos a WHERE a.conta_hash = c.hash_dedup AND a.tipo = 'fatura') AS tem_fatura,
    EXISTS (SELECT 1 FROM arquivos a WHERE a.conta_hash = c.hash_dedup AND a.tipo = 'boleto') AS tem_boleto
  FROM contas c`;
/** Formato que o front espera (mesmos campos do dashboard local). */
const paraFront = (c) => ({
  ...c,
  pdf_baixado: c.tem_fatura ? 1 : 0,
  boleto_pdf_path: c.tem_boleto ? 'nuvem' : null,
  boleto_disponivel: c.tem_boleto ? 1 : 0,
  situacao: situacao(c),
});

// ---------------------------------------------------------------- utilidades HTTP
const json = (res, status, corpo) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(corpo)); };
async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  const partes = []; for await (const p of req) partes.push(p);
  try { return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'); } catch { return {}; }
}
function origemValida(req) {
  const origem = req.headers.origin;
  if (!origem) return true;
  try { return new URL(origem).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}

// ---------------------------------------------------------------- rotas
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const rota = String((req.query && req.query.rota) || url.searchParams.get('rota') || url.pathname.replace(/^\/api\/?/, ''))
      .replace(/^\/+|\/+$/g, '');
    const partes = rota.split('/').filter(Boolean);
    const metodo = req.method;
    if (!['GET', 'HEAD'].includes(metodo) && !origemValida(req)) return json(res, 403, { erro: 'origem não permitida' });
    const corpo = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(metodo) ? await lerCorpo(req) : {};

    // ---- rotas sem login
    if (rota === 'sessao' && metodo === 'GET') {
      try {
        const n = Number((await um('SELECT COUNT(*)::int AS n FROM usuarios')).n);
        return json(res, 200, { logado: !!(await A.usuarioDaSessao(req)), semUsuarios: n === 0, local: false, nuvem: true, esqueci: E.configurado() });
      } catch (e) {
        // Banco ainda não conectado: a tela de login abre normalmente e avisa.
        console.error('sessao:', e.message);
        return json(res, 200, { logado: false, semUsuarios: false, local: false, nuvem: true, esqueci: E.configurado(), configurando: true });
      }
    }
    if (rota === 'primeiro-acesso') {
      return json(res, 403, { erro: 'Na versão online, o primeiro administrador é criado no computador do escritório: node scripts/nuvem.js admin' });
    }
    if (rota === 'login' && metodo === 'POST') {
      const ip = A.ipDe(req);
      if (await A.bloqueado(ip)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos.' });
      const u = await um('SELECT * FROM usuarios WHERE lower(usuario) = lower($1)', [String(corpo.usuario || '').trim()]);
      if (!u || !u.ativo || !A.conferirSenha(corpo.senha || '', u.senha_hash)) { await A.falhou(ip); return json(res, 401, { erro: 'Usuário ou senha incorretos.' }); }
      await q('UPDATE usuarios SET ultimo_login = $1 WHERE id = $2', [agora(), u.id]);
      await q('DELETE FROM tentativas WHERE ip = $1', [ip]);
      A.gravarCookie(res, A.emitir(u), A.DURACAO_MS);
      return json(res, 200, A.publico(u));
    }
    if (rota === 'logout' && metodo === 'POST') { A.gravarCookie(res, '', 0); return json(res, 200, { ok: true }); }

    // ---- "Esqueci minha senha": envia link por e-mail (resposta sempre igual,
    //      para não revelar quais usuários/e-mails existem).
    if (rota === 'esqueci' && metodo === 'POST') {
      const generica = { ok: true, mensagem: 'Se existir um usuário com esse login ou e-mail cadastrado, enviamos um link para criar uma nova senha. Confira sua caixa de entrada (e o spam).' };
      if (!E.configurado()) return json(res, 503, { erro: 'Recuperação por e-mail ainda não configurada. Peça ao administrador para redefinir sua senha.' });
      const ip = A.ipDe(req);
      const chave = 'esqueci:' + ip;
      if (await A.bloqueado(chave)) return json(res, 429, { erro: 'Muitos pedidos. Aguarde 15 minutos.' });
      await A.falhou(chave); // conta cada pedido (limite por IP)
      const id = String(corpo.identificador || '').trim();
      if (!id) return json(res, 400, { erro: 'Informe seu usuário ou e-mail.' });
      const u = await um('SELECT * FROM usuarios WHERE ativo = 1 AND (lower(usuario) = lower($1) OR lower(email) = lower($1)) LIMIT 1', [id]);
      if (!u || !u.email) return json(res, 200, generica);
      // No máximo 1 link a cada 2 minutos por usuário.
      const recente = await um('SELECT 1 FROM redefinicoes WHERE usuario_id = $1 AND criado_em > $2', [u.id, new Date(Date.now() - 2 * 60 * 1000).toISOString()]);
      if (recente) return json(res, 200, generica);
      const token = crypto.randomBytes(32).toString('base64url');
      await q('INSERT INTO redefinicoes (token_hash, usuario_id, expira, criado_em, ip) VALUES ($1,$2,$3,$4,$5)',
        [hashToken(token), u.id, Date.now() + MINUTOS_LINK * 60 * 1000, agora(), ip]);
      const msg = E.emailRedefinicao({ nome: u.nome, usuario: u.usuario, link: `${baseUrl(req)}/login.html#redefinir=${token}`, minutos: MINUTOS_LINK });
      try {
        await E.enviarEmail({ para: u.email, ...msg });
      } catch (e) {
        console.error('esqueci: falha ao enviar e-mail:', e.message);
        return json(res, 502, { erro: 'Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos.' });
      }
      return json(res, 200, generica);
    }
    if (rota === 'redefinir' && metodo === 'POST') {
      const ip = A.ipDe(req);
      if (await A.bloqueado('redefinir:' + ip)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos.' });
      const r = await um('SELECT * FROM redefinicoes WHERE token_hash = $1', [hashToken(corpo.token || '')]);
      if (!r || r.usado || Number(r.expira) < Date.now()) {
        await A.falhou('redefinir:' + ip);
        return json(res, 400, { erro: 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".' });
      }
      const fraca = A.senhaFraca(corpo.nova); if (fraca) return json(res, 400, { erro: fraca });
      await q('UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = 0, sessao_versao = sessao_versao + 1 WHERE id = $2', [A.hashSenha(corpo.nova), r.usuario_id]);
      await q('UPDATE redefinicoes SET usado = 1 WHERE usuario_id = $1', [r.usuario_id]); // invalida todos os links desse usuário
      const u = await um('SELECT usuario FROM usuarios WHERE id = $1', [r.usuario_id]);
      await A.registrar({ nome: u ? u.usuario : null }, null, 'redefiniu-senha-por-email');
      return json(res, 200, { ok: true, usuario: u ? u.usuario : null });
    }

    // ---- daqui para baixo, só logado
    const eu = await A.usuarioDaSessao(req);
    if (!eu) return json(res, 401, { erro: 'faça login' });
    if (eu.deve_trocar_senha && !['senha', 'me', 'logout'].includes(rota)) return json(res, 403, { erro: 'troque a senha para continuar', trocarSenha: true });

    if (rota === 'me') return json(res, 200, { ...A.publico(eu), email: eu.email || null, nuvem: true, esqueci: E.configurado() });
    if (rota === 'meu-email' && metodo === 'POST') {
      const email = String(corpo.email || '').trim();
      if (email && !emailValido(email)) return json(res, 400, { erro: 'E-mail inválido.' });
      await q('UPDATE usuarios SET email = $1 WHERE id = $2', [email || null, eu.id]);
      return json(res, 200, { ok: true, email: email || null });
    }

    if (rota === 'senha' && metodo === 'POST') {
      if (!A.conferirSenha(corpo.atual || '', eu.senha_hash)) return json(res, 400, { erro: 'Senha atual incorreta.' });
      const fraca = A.senhaFraca(corpo.nova); if (fraca) return json(res, 400, { erro: fraca });
      await q('UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = 0, sessao_versao = sessao_versao + 1 WHERE id = $2', [A.hashSenha(corpo.nova), eu.id]);
      A.gravarCookie(res, A.emitir(await um('SELECT * FROM usuarios WHERE id = $1', [eu.id])), A.DURACAO_MS);
      return json(res, 200, { ok: true });
    }

    // ---- usuários (admin)
    if (partes[0] === 'usuarios') {
      if (!eu.admin) return json(res, 403, { erro: 'apenas administradores' });
      if (partes.length === 1 && metodo === 'GET') {
        return json(res, 200, await q('SELECT id, usuario, nome, email, admin, ativo, deve_trocar_senha, ultimo_login, created_at FROM usuarios ORDER BY nome'));
      }
      if (partes.length === 1 && metodo === 'POST') {
        if (!/^[a-z0-9._-]{3,32}$/i.test(corpo.usuario || '')) return json(res, 400, { erro: 'usuário: 3 a 32 letras, números, ponto, hífen ou _' });
        if (!String(corpo.nome || '').trim()) return json(res, 400, { erro: 'informe o nome' });
        if (corpo.email && !emailValido(corpo.email)) return json(res, 400, { erro: 'E-mail inválido.' });
        if (await um('SELECT 1 FROM usuarios WHERE lower(usuario) = lower($1)', [corpo.usuario.trim()])) return json(res, 409, { erro: 'esse usuário já existe' });
        const temp = A.senhaTemporaria();
        await q('INSERT INTO usuarios (usuario, nome, email, senha_hash, admin, deve_trocar_senha, created_at) VALUES ($1,$2,$3,$4,$5,1,$6)',
          [corpo.usuario.trim(), corpo.nome.trim(), String(corpo.email || '').trim() || null, A.hashSenha(temp), corpo.admin ? 1 : 0, agora()]);
        return json(res, 200, { ok: true, usuario: corpo.usuario.trim(), senhaTemporaria: temp });
      }
      if (partes.length === 2 && metodo === 'PATCH') {
        const id = Number(partes[1]);
        if (id === eu.id && (corpo.ativo === false || corpo.admin === false)) return json(res, 400, { erro: 'você não pode tirar o próprio acesso de administrador' });
        let temp = null;
        if (typeof corpo.ativo === 'boolean') await q('UPDATE usuarios SET ativo = $1, sessao_versao = sessao_versao + 1 WHERE id = $2', [corpo.ativo ? 1 : 0, id]);
        if (typeof corpo.admin === 'boolean') await q('UPDATE usuarios SET admin = $1 WHERE id = $2', [corpo.admin ? 1 : 0, id]);
        if (typeof corpo.email === 'string') {
          if (corpo.email.trim() && !emailValido(corpo.email)) return json(res, 400, { erro: 'E-mail inválido.' });
          await q('UPDATE usuarios SET email = $1 WHERE id = $2', [corpo.email.trim() || null, id]);
        }
        if (corpo.redefinirSenha) {
          temp = A.senhaTemporaria();
          await q('UPDATE usuarios SET senha_hash = $1, deve_trocar_senha = 1, sessao_versao = sessao_versao + 1 WHERE id = $2', [A.hashSenha(temp), id]);
        }
        return json(res, 200, { ok: true, senhaTemporaria: temp });
      }
    }

    // ---- contas
    if (rota === 'contas' && metodo === 'GET') {
      const rows = await q(`${SELECT_CONTAS} ORDER BY c.data_vencimento IS NULL, c.data_vencimento`);
      return json(res, 200, rows.filter(relevante).map(paraFront));
    }
    if (rota === 'resumo' && metodo === 'GET') {
      const rows = (await q('SELECT * FROM contas')).filter(relevante);
      const t = hoje();
      const pago = (c) => /pag|baix/i.test(c.status_interno || '') || /pag/i.test(c.status_portal || '');
      let valorTotal = 0, valorPendente = 0, valorVencido = 0, valorAVencer = 0, emAberto = 0, pagas = 0, vencidas = 0, aVencer = 0;
      const prox = [];
      for (const c of rows) {
        const v = c.valor_original || 0; valorTotal += v;
        if (pago(c)) { pagas++; continue; }
        emAberto++; valorPendente += v;
        if (c.data_vencimento && c.data_vencimento < t) { vencidas++; valorVencido += v; } else { aVencer++; valorAVencer += v; prox.push(c); }
      }
      prox.sort((a, b) => String(a.data_vencimento).localeCompare(String(b.data_vencimento)));
      return json(res, 200, {
        total: rows.length, emAberto, pagas, vencidas, aVencer, valorTotal, valorPendente, valorVencido, valorAVencer,
        proximosVencimentos: prox.slice(0, 5).map((c) => ({ empresa: c.empresa, linha: c.linha, valor: c.valor_original, vencimento: c.data_vencimento })),
      });
    }
    if (rota === 'contas' && metodo === 'POST') {
      if (!corpo.empresa && !corpo.cnpj) return json(res, 400, { erro: 'informe ao menos a empresa ou o CNPJ' });
      const mv = String(corpo.data_vencimento || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const comp = corpo.competencia || (mv ? `${mv[2]}/${mv[1]}` : null);
      const [r] = await q(`INSERT INTO contas (hash_dedup, cnpj, empresa, produto, linha, competencia, ano, mes, numero_documento,
          data_vencimento, valor_original, status_portal, origem, status_interno, observacoes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Pendente','manual','Em aberto',$12,$13,$13) RETURNING id`,
        ['manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), corpo.cnpj || null, corpo.empresa || null, corpo.produto || 'Movel',
          corpo.linha || null, comp, mv ? Number(mv[1]) : null, mv ? Number(mv[2]) : null, corpo.numero_documento || null,
          corpo.data_vencimento || null, corpo.valor_original != null && corpo.valor_original !== '' ? Number(corpo.valor_original) : null,
          corpo.observacoes || null, agora()]);
      await A.registrar(eu, r.id, 'criar', { empresa: corpo.empresa, valor: corpo.valor_original, vencimento: corpo.data_vencimento });
      return json(res, 200, paraFront(await um(`${SELECT_CONTAS} WHERE c.id = $1`, [r.id])));
    }
    if (partes[0] === 'contas' && partes.length >= 2) {
      const id = Number(partes[1]);
      if (partes.length === 2 && metodo === 'PATCH') {
        const campos = Object.keys(corpo).filter((k) => EDITAVEIS.includes(k));
        if (!campos.length) return json(res, 400, { erro: 'nada para atualizar' });
        const sets = campos.map((c, i) => `${c} = $${i + 1}`).join(', ');
        await q(`UPDATE contas SET ${sets}, updated_at = $${campos.length + 1} WHERE id = $${campos.length + 2}`, [...campos.map((c) => corpo[c]), agora(), id]);
        await A.registrar(eu, id, 'editar', Object.fromEntries(campos.map((c) => [c, corpo[c]])));
        return json(res, 200, paraFront(await um(`${SELECT_CONTAS} WHERE c.id = $1`, [id])));
      }
      if (partes.length === 2 && metodo === 'DELETE') {
        const c = await um('SELECT hash_dedup, empresa, produto, linha, competencia, data_vencimento, valor_original FROM contas WHERE id = $1', [id]);
        if (!c) return json(res, 200, { ok: true, removidas: 0 });
        await q('INSERT INTO excluidas (hash_dedup, em) VALUES ($1,$2) ON CONFLICT (hash_dedup) DO NOTHING', [c.hash_dedup, agora()]);
        await q('DELETE FROM arquivos WHERE conta_hash = $1', [c.hash_dedup]);
        await q('DELETE FROM contas WHERE id = $1', [id]);
        const { hash_dedup, ...antes } = c;
        await A.registrar(eu, id, 'excluir', antes);
        return json(res, 200, { ok: true, removidas: 1 });
      }
      if (partes.length === 3 && partes[2] === 'historico' && metodo === 'GET') {
        const rows = await q('SELECT usuario, acao, detalhes, em FROM historico WHERE conta_id = $1 ORDER BY id DESC LIMIT 50', [id]);
        return json(res, 200, rows.map((r) => ({ ...r, detalhes: r.detalhes ? JSON.parse(r.detalhes) : null })));
      }
      if (partes.length === 3 && ['fatura', 'boleto'].includes(partes[2]) && metodo === 'GET') {
        const a = await um(`SELECT a.nome, a.conteudo_b64, c.linha, c.competencia FROM arquivos a JOIN contas c ON c.hash_dedup = a.conta_hash
                            WHERE c.id = $1 AND a.tipo = $2`, [id, partes[2]]);
        if (!a) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('PDF não disponível para esta conta.'); }
        const rotulo = partes[2] === 'fatura' ? 'Fatura' : 'Boleto';
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Disposition', `inline; filename="${rotulo}-${String(a.linha || id).replace(/[^\w.-]+/g, '_').slice(0, 40)}-${String(a.competencia || '').replace('/', '-')}.pdf"`);
        return res.end(Buffer.from(a.conteudo_b64, 'base64'));
      }
    }

    // ---- coleta: o botão vira um pedido para o computador do escritório
    if (rota === 'run' && metodo === 'POST') {
      const modo = String((req.query && req.query.modo) || url.searchParams.get('modo') || corpo.modo || '') === 'status' ? 'status' : 'completo';
      const aberto = await um('SELECT id, tipo FROM comandos WHERE fim_em IS NULL ORDER BY id DESC LIMIT 1');
      if (aberto) return json(res, 200, { ok: true, jaRodando: true, modo: aberto.tipo });
      await q('INSERT INTO comandos (tipo, pedido_por, criado_em) VALUES ($1,$2,$3)', [modo, eu.nome, agora()]);
      await A.registrar(eu, null, modo === 'status' ? 'atualizar-status' : 'baixar-contas');
      return json(res, 200, { ok: true, iniciado: true, modo, pedido: true });
    }
    if (rota === 'run/status' && metodo === 'GET') {
      const ag = await um('SELECT * FROM agente WHERE id = 1');
      const aberto = await um('SELECT * FROM comandos WHERE fim_em IS NULL ORDER BY id DESC LIMIT 1');
      const online = !!(ag && ag.ultimo_ping && Date.now() - Date.parse(ag.ultimo_ping) < 3 * 60 * 1000);
      return json(res, 200, {
        rodando: !!aberto, modo: aberto ? aberto.tipo : null,
        inicio: aberto ? (aberto.iniciado_em || aberto.criado_em) : null,
        aguardandoComputador: !!(aberto && !aberto.iniciado_em),
        agenteOnline: online,
        ultima: ag && (ag.ultima_coleta_fim || ag.ultima_sincronia) ? { fim: ag.ultima_coleta_fim || ag.ultima_sincronia } : null,
        resultado: ag && ag.ultima_coleta_ok === 0 ? { ok: false } : null,
        driveOk: ag ? ag.drive_ok !== 0 : true,
      });
    }
    if (rota === 'config' && metodo === 'GET') return json(res, 200, { driveFolderUrl: process.env.DRIVE_FOLDER_URL || '' });

    return json(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    console.error('api:', e);
    if (/DATABASE_URL|connect|ECONNREFUSED|ENOTFOUND|password authentication/i.test(String(e && e.message))) {
      return json(res, 503, { erro: 'O dashboard online ainda está sendo configurado (banco de dados). Tente novamente mais tarde.' });
    }
    return json(res, 500, { erro: 'erro interno' });
  }
};
