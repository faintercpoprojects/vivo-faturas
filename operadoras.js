#!/usr/bin/env node
'use strict';

/**
 * Coleta as contas de OUTRAS OPERADORAS (Desktop, AONet) pelo CNPJ e grava no
 * mesmo banco do dashboard.
 *
 *   node operadoras.js                 # usa OPERADORAS e OPERADORAS_CNPJS do .env
 *   node operadoras.js --headed        # mostra o navegador
 *   node operadoras.js --cnpj 68165786000130
 *
 * .env:
 *   OPERADORAS=desktop,aonet
 *   OPERADORAS_CNPJS=68.165.786/0001-30          (vários: separados por vírgula)
 */

const path = require('path');
const { config } = require('./src/config');
const { logger } = require('./src/logger');
const db = require('./src/db');
const { COLETORES, abrirNavegador, fmtCnpj, soDigitos } = require('./src/operadoras');

const argv = process.argv.slice(2);
const valor = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

async function main() {
  const operadoras = (process.env.OPERADORAS || 'desktop,aonet').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cnpjs = (valor('--cnpj') || process.env.OPERADORAS_CNPJS || '68.165.786/0001-30')
    .split(',').map(soDigitos).filter((c) => c.length === 11 || c.length === 14);

  logger.info(`===== Outras operadoras: ${operadoras.join(', ')} | CNPJ(s): ${cnpjs.map(fmtCnpj).join(', ')} =====`);
  db.abrir();
  const { browser, context } = await abrirNavegador();
  let erros = 0, novas = 0, atualizadas = 0, pdfs = 0;

  try {
    for (const cnpj of cnpjs) {
      for (const op of operadoras) {
        const coletar = COLETORES[op];
        if (!coletar) { logger.warn(`Operadora desconhecida: ${op} (use: ${Object.keys(COLETORES).join(', ')})`); continue; }
        const inicio = Date.now();
        try {
          const pasta = path.join(config.paths.downloads, fmtCnpj(cnpj).replace(/\//g, '-'), op);
          const contas = await coletar(context, cnpj, pasta);
          for (const c of contas) {
            const r = db.registrarContaOperadora({ ...c, cnpj: fmtCnpj(cnpj), empresa: c.contrato || null });
            r.nova ? novas++ : atualizadas++;
            if (c.boletoPdfPath) pdfs++;
            logger.info(`${fmtCnpj(cnpj)} [${c.produto}] venc. ${c.dataVencimento} R$ ${c.valor} — ${c.statusPortal}${c.boletoPdfPath ? ' (PDF baixado)' : ''}`);
          }
          // AONet só lista faturas EM ABERTO: a que sumiu da lista foi paga.
          if (op === 'aonet') {
            const abertas = new Set(contas.map((c) => `${c.linha}|${c.dataVencimento}`));
            const d = db.abrir();
            const antigas = d.prepare(`SELECT id, linha, data_vencimento FROM contas
              WHERE cnpj = ? AND produto = 'AONet' AND status_portal IN ('Pendente','Atrasada')`).all(fmtCnpj(cnpj));
            for (const a of antigas) {
              if (!abertas.has(`${a.linha}|${a.data_vencimento}`)) {
                d.prepare(`UPDATE contas SET status_portal = 'Paga', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), a.id);
                logger.info(`${fmtCnpj(cnpj)} [AONet] venc. ${a.data_vencimento} saiu da lista de abertas — marcada como Paga.`);
                atualizadas++;
              }
            }
          }
          logger.info(`----- ${fmtCnpj(cnpj)} [${op}]: ${contas.length} fatura(s) em ${Math.round((Date.now() - inicio) / 1000)}s -----`);
        } catch (e) {
          erros++;
          logger.error(`${fmtCnpj(cnpj)} [${op}]: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    db.fechar();
  }
  logger.info(`Outras operadoras — novas: ${novas} | atualizadas: ${atualizadas} | PDFs: ${pdfs} | erros: ${erros}`);
  return erros;
}

main()
  .then((erros) => { process.exitCode = erros ? 1 : 0; })
  .catch((e) => { logger.error(`Outras operadoras — falha: ${e.message}`); process.exitCode = 2; })
  .finally(() => setTimeout(() => process.exit(process.exitCode), 2000));
