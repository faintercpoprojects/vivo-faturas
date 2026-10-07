'use strict';

/**
 * Envia para o Google Drive todos os PDFs de contas (Vivo, Desktop, AONet,
 * Vero...) que ainda não estão lá.
 *
 * Estrutura no Drive (a mesma de antes):
 *   <pasta raiz> / <Empresa> / <CNPJ> / <Ano> / <MM - Mês> / arquivo.pdf
 *
 * Regra de "já existe": se a pasta de destino já tem um arquivo com o mesmo
 * nome, NÃO reenvia (nem sobrescreve). Além disso, guarda em
 * .state/drive-enviados.json o MD5 de cada PDF já enviado, para nem consultar
 * o Drive de novo nas próximas execuções.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { config } = require('./config');
const { logger } = require('./logger');
const { md5 } = require('./utils');
const drv = require('./uploadDrive');

const REGISTRO = path.join(config.paths.state, 'drive-enviados.json');

function lerRegistro() {
  try { return JSON.parse(fs.readFileSync(REGISTRO, 'utf8')); } catch { return {}; }
}
function gravarRegistro(r) {
  fs.mkdirSync(path.dirname(REGISTRO), { recursive: true });
  fs.writeFileSync(REGISTRO, JSON.stringify(r, null, 2));
}

/** Nome "oficial" da empresa por CNPJ (o das contas Vivo, que trazem a razão social). */
function nomesPorCnpj(contas) {
  const m = new Map();
  for (const c of contas) {
    if (!c.cnpj || !c.empresa) continue;
    if (/^(movel|fixo)$/i.test(c.produto || '') || /LTDA|S\.?A\.?|ME\b|EIRELI/i.test(c.empresa)) {
      if (!m.has(c.cnpj) || /LTDA|S\.?A\.?/i.test(c.empresa)) m.set(c.cnpj, c.empresa);
    }
  }
  return m;
}

/** Ano/mês da pasta: competência da conta; senão, o mês do vencimento. */
function anoMes(c) {
  if (c.ano && c.mes) return { ano: c.ano, mes: c.mes };
  const m = String(c.data_vencimento || '').match(/^(\d{4})-(\d{2})/);
  return m ? { ano: Number(m[1]), mes: Number(m[2]) } : { ano: new Date().getFullYear(), mes: new Date().getMonth() + 1 };
}

/**
 * @returns {Promise<{enviados:number, jaExistiam:number, falhas:number, total:number}>}
 */
async function sincronizarDrive({ dbFile, log = (m) => logger.info(m) } = {}) {
  if (!config.drive.rootFolderId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID não configurado no .env');
  await drv.verificarConexao(); // falha cedo se a autorização do Google expirou

  const arquivoDb = dbFile || (process.env.DB_PATH ? path.resolve(config.ROOT, process.env.DB_PATH) : path.join(config.paths.state, 'contas.db'));
  const d = new DatabaseSync(arquivoDb, { readOnly: true });
  const contas = d.prepare('SELECT * FROM contas').all();
  d.close();

  const nomes = nomesPorCnpj(contas);
  const registro = lerRegistro();
  const pastas = new Map(); // cache: "empresa|cnpj|ano|mes" -> id da pasta
  let enviados = 0, jaExistiam = 0, falhas = 0, total = 0;

  for (const c of contas) {
    for (const arq of [c.pdf_path, c.boleto_pdf_path]) {
      if (!arq || !fs.existsSync(arq)) continue;
      total++;
      const hash = await md5(arq);
      if (registro[hash]) { jaExistiam++; continue; } // já enviado antes (registro local)

      const { ano, mes } = anoMes(c);
      const empresa = nomes.get(c.cnpj) || c.empresa || 'Sem Empresa';
      const cnpj = c.cnpj || 'Sem CNPJ';
      const chave = `${empresa}|${cnpj}|${ano}|${mes}`;
      try {
        if (!pastas.has(chave)) pastas.set(chave, await drv.garantirArvore({ empresa, cnpjFormatado: cnpj, ano, mes }));
        const pastaId = pastas.get(chave);
        const nome = path.basename(arq);
        const existente = await drv.buscarArquivo(nome, pastaId);
        if (existente) {
          jaExistiam++;
          registro[hash] = { id: existente.id, nome, pasta: `${empresa}/${cnpj}/${ano}/${String(mes).padStart(2, '0')}`, em: new Date().toISOString(), origem: 'ja-existia' };
          continue;
        }
        const r = await drv.enviarArquivo(arq, pastaId);
        registro[hash] = { id: r.id, nome, pasta: `${empresa}/${cnpj}/${ano}/${String(mes).padStart(2, '0')}`, em: new Date().toISOString() };
        enviados++;
        log(`Drive: enviado ${nome} -> ${empresa}/${cnpj}/${ano}/${String(mes).padStart(2, '0')}`);
      } catch (e) {
        falhas++;
        logger.warn(`Drive: falha ao enviar ${path.basename(arq)}: ${e.message}`);
      }
      gravarRegistro(registro); // grava a cada arquivo: se cair no meio, não repete
    }
  }
  gravarRegistro(registro);
  log(`Drive: ${enviados} PDF(s) enviado(s), ${jaExistiam} já estavam lá, ${falhas} falha(s) — ${total} PDF(s) conferido(s).`);
  return { enviados, jaExistiam, falhas, total };
}

module.exports = { sincronizarDrive, nomesPorCnpj, anoMes };
