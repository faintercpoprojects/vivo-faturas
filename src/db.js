'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { config } = require('./config');
const { logger } = require('./logger');

let db = null;

/** Chave lógica de uma conta: uma fatura por (CNPJ, produto, linha, competência). */
function hashConta({ cnpj, produto, linha, competencia }) {
  return crypto
    .createHash('sha1')
    .update(`${cnpj}|${produto}|${linha || ''}|${competencia}`)
    .digest('hex');
}

/** Abre (e cria) o banco SQLite local e garante o schema. Idempotente. */
function abrir() {
  if (db) return db;
  const file = process.env.DB_PATH
    ? path.resolve(config.ROOT, process.env.DB_PATH)
    : path.join(config.paths.state, 'contas.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash_dedup TEXT UNIQUE NOT NULL,
      cnpj TEXT NOT NULL,
      empresa TEXT,
      produto TEXT,
      linha TEXT,
      competencia TEXT,
      ano INTEGER,
      mes INTEGER,
      numero_documento TEXT,
      data_emissao TEXT,
      data_vencimento TEXT,
      valor_original REAL,
      status_portal TEXT,
      boleto_disponivel INTEGER DEFAULT 0,
      pdf_baixado INTEGER DEFAULT 0,
      pdf_path TEXT,
      drive_file_id TEXT,
      drive_link TEXT,
      data_download TEXT,
      boleto_pdf_path TEXT,
      boleto_drive_link TEXT,
      disponivel_em TEXT,
      -- campos controlados pelo FINANCEIRO (nunca sobrescritos pela automação)
      status_interno TEXT DEFAULT 'Em aberto',
      valor_pago REAL,
      data_pagamento TEXT,
      data_baixa TEXT,
      forma_pagamento TEXT,
      banco_conta TEXT,
      comprovante TEXT,
      observacoes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contas_venc ON contas(data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_status ON contas(status_portal);
    CREATE INDEX IF NOT EXISTS idx_contas_cnpj ON contas(cnpj);

    CREATE TABLE IF NOT EXISTS execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inicio TEXT, fim TEXT,
      contas_novas INTEGER, contas_atualizadas INTEGER,
      faturas INTEGER, boletos INTEGER, erros INTEGER,
      status TEXT
    );
  `);
  logger.info(`Banco SQLite: ${file}`);
  return db;
}

const agora = () => new Date().toISOString();

/**
 * Insere/atualiza a conta a partir de uma FATURA baixada.
 * Só toca colunas da automação/portal — os campos do financeiro ficam intactos.
 * @returns {{nova:boolean}}
 */
function registrarFatura(d) {
  abrir();
  const hash = hashConta(d);
  const jaExiste = db.prepare('SELECT 1 FROM contas WHERE hash_dedup = ?').get(hash);

  db.prepare(`
    INSERT INTO contas
      (hash_dedup, cnpj, empresa, produto, linha, competencia, ano, mes,
       numero_documento, data_emissao, data_vencimento, valor_original,
       status_portal, boleto_disponivel, pdf_baixado, pdf_path, drive_file_id, drive_link,
       data_download, disponivel_em, status_interno, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?, ?,?,?,?, ?,0,1,?,?,?, ?,?, 'Em aberto', ?,?)
    ON CONFLICT(hash_dedup) DO UPDATE SET
      empresa          = excluded.empresa,
      numero_documento = COALESCE(excluded.numero_documento, contas.numero_documento),
      data_emissao     = COALESCE(excluded.data_emissao,     contas.data_emissao),
      data_vencimento  = COALESCE(excluded.data_vencimento,  contas.data_vencimento),
      valor_original   = COALESCE(excluded.valor_original,   contas.valor_original),
      status_portal    = excluded.status_portal,
      pdf_baixado      = 1,
      pdf_path         = excluded.pdf_path,
      drive_file_id    = COALESCE(excluded.drive_file_id, contas.drive_file_id),
      drive_link       = COALESCE(excluded.drive_link,    contas.drive_link),
      data_download    = excluded.data_download,
      updated_at       = excluded.updated_at
  `).run(
    hash, d.cnpj, d.empresa || null, d.produto || null, d.linha || null, d.competencia || null,
    d.ano || null, d.mes || null,
    d.numeroDocumento || null, d.dataEmissao || null, d.dataVencimento || null,
    d.valor != null ? d.valor : null,
    d.statusPortal || null, d.pdfPath || null, d.driveFileId || null, d.driveLink || null,
    agora(), agora(), agora(), agora()
  );

  return { nova: !jaExiste };
}

/** Atualiza a conta (mesma chave) com os dados do BOLETO. */
function registrarBoleto(d) {
  abrir();
  const hash = hashConta(d);
  const r = db.prepare(`
    UPDATE contas SET
      boleto_disponivel = 1,
      boleto_pdf_path   = COALESCE(?, boleto_pdf_path),
      boleto_drive_link = COALESCE(?, boleto_drive_link),
      updated_at        = ?
    WHERE hash_dedup = ?
  `).run(d.pdfPath || null, d.driveLink || null, agora(), hash);
  // Fallback: a competência do boleto pode divergir da fatura. Tenta anexar à
  // fatura mais recente da MESMA linha que ainda não tem boleto. Se nada casar,
  // ignora (não cria linha vazia no dashboard).
  if (r.changes === 0 && d.linha) {
    db.prepare(`
      UPDATE contas SET
        boleto_disponivel = 1,
        boleto_pdf_path   = COALESCE(?, boleto_pdf_path),
        boleto_drive_link = COALESCE(?, boleto_drive_link),
        updated_at        = ?
      WHERE id = (
        SELECT id FROM contas
        WHERE cnpj = ? AND produto = ? AND linha = ? AND boleto_pdf_path IS NULL
        ORDER BY data_vencimento DESC LIMIT 1
      )
    `).run(d.pdfPath || null, d.driveLink || null, agora(), d.cnpj, d.produto || null, d.linha);
  }
}

/**
 * Registra uma conta VIVO FIXO a partir do BOLETO (o Fixo não expõe o PDF da
 * fatura pelo mesmo caminho). Os dados financeiros (valor/vencimento/status)
 * vêm do card da tela, não do PDF. Preserva os campos do financeiro no upsert.
 * @returns {{nova:boolean}}
 */
function registrarContaFixo(d) {
  abrir();
  const hash = hashConta({ cnpj: d.cnpj, produto: 'Fixo', linha: d.linha, competencia: d.competencia });
  const jaExiste = db.prepare('SELECT 1 FROM contas WHERE hash_dedup = ?').get(hash);

  db.prepare(`
    INSERT INTO contas
      (hash_dedup, cnpj, empresa, produto, linha, competencia, ano, mes,
       numero_documento, data_vencimento, valor_original, status_portal,
       boleto_disponivel, boleto_pdf_path, boleto_drive_link, pdf_baixado,
       disponivel_em, status_interno, created_at, updated_at)
    VALUES (?,?,?, 'Fixo', ?,?,?,?, ?,?,?,?, 1,?,?,0, ?, 'Em aberto', ?,?)
    ON CONFLICT(hash_dedup) DO UPDATE SET
      empresa           = excluded.empresa,
      numero_documento  = COALESCE(excluded.numero_documento, contas.numero_documento),
      data_vencimento   = COALESCE(excluded.data_vencimento,  contas.data_vencimento),
      valor_original    = COALESCE(excluded.valor_original,   contas.valor_original),
      status_portal     = excluded.status_portal,
      boleto_disponivel = 1,
      boleto_pdf_path   = COALESCE(excluded.boleto_pdf_path, contas.boleto_pdf_path),
      boleto_drive_link = COALESCE(excluded.boleto_drive_link, contas.boleto_drive_link),
      updated_at        = excluded.updated_at
  `).run(
    hash, d.cnpj, d.empresa || null, d.linha || null, d.competencia || null, d.ano || null, d.mes || null,
    d.numeroDocumento || null, d.dataVencimento || null, d.valor != null ? d.valor : null, d.statusPortal || null,
    d.boletoPdfPath || null, d.boletoDriveLink || null, agora(), agora(), agora()
  );
  return { nova: !jaExiste };
}

/** Registra o resumo de uma execução da automação. */
function registrarExecucao(e) {
  abrir();
  db.prepare(`
    INSERT INTO execucoes (inicio, fim, contas_novas, contas_atualizadas, faturas, boletos, erros, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(e.inicio || null, e.fim || agora(), e.contasNovas || 0, e.contasAtualizadas || 0,
    e.faturas || 0, e.boletos || 0, e.erros || 0, e.status || 'ok');
}

function fechar() {
  if (db) { try { db.close(); } catch { /* noop */ } db = null; }
}

module.exports = { abrir, hashConta, registrarFatura, registrarBoleto, registrarContaFixo, registrarExecucao, fechar };
