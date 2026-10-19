'use strict';

/**
 * Ponte entre este computador e o dashboard na nuvem (Vercel + Postgres).
 *
 *  - enviar():       manda as contas (campos do portal) e os PDFs para a nuvem.
 *                    NUNCA sobrescreve o que o financeiro registrou lá
 *                    (pagamento, baixa, observações) e não recria contas
 *                    excluídas no dashboard online.
 *  - iniciarAgente(): a cada 30 s dá sinal de vida e executa os pedidos do
 *                    botão "Baixar contas"/"Atualizar status" feitos na nuvem.
 *
 * Configuração (.env): NUVEM_DATABASE_URL = a connection string do Postgres
 * (a mesma DATABASE_URL que a Vercel mostra em Storage).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const ESQUEMA = path.join(ROOT, 'nuvem', 'lib', 'esquema.sql');
const DB_LOCAL = process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : path.join(ROOT, '.state', 'contas.db');

let q = null;      // (sql, params) -> linhas
let exec = null;   // (sql com vários comandos)
let pool = null;

/** Injeta outro banco (testes com PGlite). */
function usarBanco({ query, executar }) { q = query; exec = executar; }

function ativo() { return !!(q || process.env.NUVEM_DATABASE_URL); }

function conectar() {
  if (q) return;
  const url = process.env.NUVEM_DATABASE_URL;
  if (!url) throw new Error('NUVEM_DATABASE_URL não configurada no .env');
  const { Pool } = require('pg');
  // TLS com verificação do certificado, explícito (evita o aviso do pg sobre sslmode).
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 20000, connectionTimeoutMillis: 20000 });
  pool.on('error', () => { /* conexão ociosa caiu; o pool reabre */ });
  q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  exec = async (sql) => { await pool.query(sql); };
}

async function esquema() {
  conectar();
  await exec(fs.readFileSync(ESQUEMA, 'utf8'));
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const agora = () => new Date().toISOString();

// Campos que vêm do PORTAL (a sincronização atualiza) x do FINANCEIRO (só no 1º envio).
const PORTAL = ['cnpj', 'empresa', 'produto', 'linha', 'competencia', 'ano', 'mes', 'numero_documento', 'data_emissao',
  'data_vencimento', 'valor_original', 'status_portal', 'linha_digitavel', 'pix_code', 'origem'];
const FINANCEIRO = ['status_interno', 'valor_pago', 'data_pagamento', 'data_baixa', 'forma_pagamento', 'banco_conta',
  'comprovante', 'observacoes', 'alterado_por'];

/** Envia contas e PDFs do banco local para a nuvem. */
async function enviar({ log = () => {} } = {}) {
  conectar();
  const local = new DatabaseSync(DB_LOCAL, { readOnly: true });
  const colsLocais = new Set(local.prepare('PRAGMA table_info(contas)').all().map((c) => c.name));
  const contas = local.prepare('SELECT * FROM contas').all();
  local.close();

  const excluidas = new Set((await q('SELECT hash_dedup FROM excluidas')).map((r) => r.hash_dedup));
  const existentes = new Map((await q('SELECT hash_dedup, updated_at FROM contas')).map((r) => [r.hash_dedup, r.updated_at]));
  const md5Nuvem = new Map((await q('SELECT conta_hash, tipo, md5 FROM arquivos')).map((r) => [`${r.conta_hash}|${r.tipo}`, r.md5]));

  const todas = [...PORTAL, ...FINANCEIRO];
  const valor = (c, k) => (colsLocais.has(k) && c[k] !== undefined ? c[k] : null);
  let novas = 0, atualizadas = 0, pdfs = 0;

  for (const c of contas) {
    if (excluidas.has(c.hash_dedup)) continue;
    const ja = existentes.has(c.hash_dedup);
    const cols = ['hash_dedup', ...todas, 'created_at', 'updated_at'];
    const vals = [c.hash_dedup, ...todas.map((k) => valor(c, k)), c.created_at || agora(), c.updated_at || agora()];
    const sets = PORTAL.map((k) => `${k} = EXCLUDED.${k}`).join(', ');
    await q(`INSERT INTO contas (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
             ON CONFLICT (hash_dedup) DO UPDATE SET ${sets},
               updated_at = CASE WHEN contas.status_portal IS DISTINCT FROM EXCLUDED.status_portal
                                   OR contas.valor_original IS DISTINCT FROM EXCLUDED.valor_original
                                   OR contas.data_vencimento IS DISTINCT FROM EXCLUDED.data_vencimento
                                 THEN EXCLUDED.updated_at ELSE contas.updated_at END`, vals);
    if (ja) atualizadas++; else novas++;

    // PDFs: só reenvia quando mudou (md5).
    for (const [tipo, arq] of [['fatura', c.pdf_path], ['boleto', c.boleto_pdf_path]]) {
      if (!arq || !fs.existsSync(arq)) continue;
      const buf = fs.readFileSync(arq);
      const h = md5(buf);
      if (md5Nuvem.get(`${c.hash_dedup}|${tipo}`) === h) continue;
      await q(`INSERT INTO arquivos (conta_hash, tipo, nome, md5, conteudo_b64, atualizado_em) VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (conta_hash, tipo) DO UPDATE SET nome = EXCLUDED.nome, md5 = EXCLUDED.md5,
                 conteudo_b64 = EXCLUDED.conteudo_b64, atualizado_em = EXCLUDED.atualizado_em`,
        [c.hash_dedup, tipo, path.basename(arq), h, buf.toString('base64'), agora()]);
      pdfs++;
    }
  }
  await q(`INSERT INTO agente (id, ultima_sincronia) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET ultima_sincronia = EXCLUDED.ultima_sincronia`, [agora()]);
  log(`Nuvem: ${novas} conta(s) nova(s), ${atualizadas} conferida(s), ${pdfs} PDF(s) enviado(s).`);
  return { novas, atualizadas, pdfs };
}

/** Copia os usuários do dashboard local para a nuvem (só se a nuvem não tiver nenhum). */
async function migrarUsuarios({ log = () => {} } = {}) {
  conectar();
  const n = Number((await q('SELECT COUNT(*)::int AS n FROM usuarios'))[0].n);
  if (n > 0) return 0;
  const local = new DatabaseSync(DB_LOCAL, { readOnly: true });
  let us = [];
  try { us = local.prepare('SELECT * FROM usuarios').all(); } catch { /* sem usuários locais */ }
  local.close();
  for (const u of us) {
    await q(`INSERT INTO usuarios (usuario, nome, senha_hash, admin, ativo, deve_trocar_senha, sessao_versao, ultimo_login, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (usuario) DO NOTHING`,
      [u.usuario, u.nome, u.senha_hash, u.admin, u.ativo, u.deve_trocar_senha, u.sessao_versao, u.ultimo_login, u.created_at]);
  }
  if (us.length) log(`Nuvem: ${us.length} usuário(s) do dashboard local copiado(s) (mesmas senhas).`);
  return us.length;
}

/** Cria um usuário administrador direto na nuvem (senha digitada no terminal). */
async function criarAdmin({ usuario, nome, senhaHash }) {
  conectar();
  await q(`INSERT INTO usuarios (usuario, nome, senha_hash, admin, created_at) VALUES ($1,$2,$3,1,$4)
           ON CONFLICT (usuario) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, admin = 1, ativo = 1,
             deve_trocar_senha = 0, sessao_versao = usuarios.sessao_versao + 1`, [usuario, nome, senhaHash, agora()]);
}

/**
 * Cria um pedido de coleta na nuvem (como o botão "Baixar contas") e espera
 * ele terminar. Se já houver um pedido em aberto, espera esse.
 * @returns {Promise<number>} código de saída da coleta
 */
async function pedirColetaEEsperar(tipo, pedidoPor, { maxMs = 3 * 3600 * 1000, intervaloMs = 20000 } = {}) {
  conectar();
  let cmd = (await q('SELECT id FROM comandos WHERE fim_em IS NULL ORDER BY id DESC LIMIT 1'))[0];
  if (!cmd) cmd = (await q('INSERT INTO comandos (tipo, pedido_por, criado_em) VALUES ($1,$2,$3) RETURNING id', [tipo, pedidoPor, agora()]))[0];
  const fim = Date.now() + maxMs;
  while (Date.now() < fim) {
    await new Promise((r) => setTimeout(r, intervaloMs));
    const c = (await q('SELECT fim_em, codigo FROM comandos WHERE id = $1', [cmd.id]))[0];
    if (c && c.fim_em) return c.codigo == null ? -1 : Number(c.codigo);
  }
  return -1;
}

/** Registra o fim de uma coleta (para o "Atualizado em" do dashboard online). */
async function registrarColeta(codigo, driveCodigo = null) {
  conectar();
  await q(`INSERT INTO agente (id, ultima_coleta_fim, ultima_coleta_ok) VALUES (1, $1, $2)
           ON CONFLICT (id) DO UPDATE SET ultima_coleta_fim = EXCLUDED.ultima_coleta_fim, ultima_coleta_ok = EXCLUDED.ultima_coleta_ok`,
    [agora(), codigo === 0 || codigo === 1 ? 1 : 0]);
  // Status do envio ao Drive (só nas coletas completas, que é quando ele roda).
  if (driveCodigo !== null) {
    await q('UPDATE agente SET drive_ok = $1, drive_em = $2 WHERE id = 1', [driveCodigo === 0 || driveCodigo === 1 ? 1 : 0, agora()]);
  }
}

/**
 * Laço do agente: sinal de vida + pedidos da nuvem.
 * @param {{iniciarColeta:(modo:string, aoTerminar:(codigo:number)=>void)=>boolean, rodando:()=>boolean, log?:Function}} o
 */
function iniciarAgente({ iniciarColeta, rodando, log = console.log, intervaloMs = 30000 }) {
  conectar();
  let ocupado = false;
  const tick = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await q(`INSERT INTO agente (id, ultimo_ping) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET ultimo_ping = EXCLUDED.ultimo_ping`, [agora()]);
      // Pedido que ficou "rodando" (computador desligou no meio): encerra após 2 h.
      await q(`UPDATE comandos SET fim_em = $1, codigo = -1 WHERE fim_em IS NULL AND iniciado_em IS NOT NULL AND iniciado_em < $2`,
        [agora(), new Date(Date.now() - 2 * 3600 * 1000).toISOString()]);
      if (rodando()) return;
      const cmd = (await q('SELECT * FROM comandos WHERE iniciado_em IS NULL AND fim_em IS NULL ORDER BY id LIMIT 1'))[0];
      if (!cmd) return;
      await q('UPDATE comandos SET iniciado_em = $1 WHERE id = $2', [agora(), cmd.id]);
      log(`Nuvem: pedido #${cmd.id} (${cmd.tipo}) de ${cmd.pedido_por || '?'} — iniciando coleta.`);
      const ok = iniciarColeta(cmd.tipo, async (codigo) => {
        try { await q('UPDATE comandos SET fim_em = $1, codigo = $2 WHERE id = $3', [agora(), codigo, cmd.id]); } catch (e) { log('Nuvem: falha ao fechar pedido: ' + e.message); }
      });
      if (!ok) await q('UPDATE comandos SET iniciado_em = NULL WHERE id = $1', [cmd.id]); // já havia coleta local; tenta de novo depois
    } catch (e) {
      log('Nuvem: ' + e.message);
    } finally {
      ocupado = false;
    }
  };
  tick();
  return setInterval(tick, intervaloMs);
}

async function fechar() { if (pool) await pool.end().catch(() => {}); pool = null; }

module.exports = { ativo, usarBanco, esquema, enviar, migrarUsuarios, criarAdmin, registrarColeta, pedirColetaEEsperar, iniciarAgente, fechar };
