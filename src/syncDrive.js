'use strict';

/**
 * Envia para o Google Drive todos os PDFs de contas (Vivo, Desktop, AONet,
 * Vero...) que ainda não estão lá.
 *
 * Estrutura no Drive (a mesma que o financeiro já usa):
 *   <pasta raiz> / <Mês> - <Ano> / arquivo.pdf      (ex.: "Outubro - 2026")
 * O mês é o do VENCIMENTO da conta.
 *
 * Regra de "já existe": se o MESMO arquivo (mesmo conteúdo/MD5) já está em
 * qualquer pasta do Drive — inclusive com outro nome, nas pastas organizadas à
 * mão — ou se a pasta do mês já tem um arquivo com o mesmo nome, NÃO reenvia
 * (nem sobrescreve). O MD5 de cada PDF já tratado fica em
 * .state/drive-enviados.json, para não consultar de novo.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { config } = require('./config');
const { logger } = require('./logger');
const { md5 } = require('./utils');
const drv = require('./uploadDrive');

const REGISTRO = () => path.join(config.paths.state, 'drive-enviados.json');
const MESES = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function lerRegistro() {
  try { return JSON.parse(fs.readFileSync(REGISTRO(), 'utf8')); } catch { return {}; }
}
function gravarRegistro(r) {
  fs.mkdirSync(path.dirname(REGISTRO()), { recursive: true });
  fs.writeFileSync(REGISTRO(), JSON.stringify(r, null, 2));
}

/** Ano/mês da pasta: mês do VENCIMENTO; sem vencimento, a competência. */
function anoMes(c) {
  const m = String(c.data_vencimento || '').match(/^(\d{4})-(\d{2})/);
  if (m) return { ano: Number(m[1]), mes: Number(m[2]) };
  if (c.ano && c.mes) return { ano: c.ano, mes: c.mes };
  return { ano: new Date().getFullYear(), mes: new Date().getMonth() + 1 };
}

/** O documento que vai para o Drive: o boleto; sem boleto, a fatura. */
function documentoDaConta(c) {
  if (c.boleto_pdf_path && fs.existsSync(c.boleto_pdf_path)) return c.boleto_pdf_path;
  if (c.pdf_path && fs.existsSync(c.pdf_path)) return c.pdf_path;
  return null;
}

/** Nome da pasta do mês, no padrão do financeiro: "Outubro - 2026". */
const nomePastaMes = ({ ano, mes }) => `${MESES[mes]} - ${ano}`;

/** MD5 de todos os arquivos sob a pasta (recursivo). @returns {Promise<Map<string,{id,nome,pasta}>>} */
async function md5sNoDrive(raizId) {
  const d = drv.drive();
  const mapa = new Map();
  const visitar = async (id, caminho) => {
    let pageToken;
    do {
      const r = await d.files.list({
        q: `'${id}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType, md5Checksum)',
        pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const f of r.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') await visitar(f.id, `${caminho}/${f.name}`);
        else if (f.md5Checksum && !mapa.has(f.md5Checksum)) mapa.set(f.md5Checksum, { id: f.id, nome: f.name, pasta: caminho.slice(1) });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  };
  await visitar(raizId, '');
  return mapa;
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

  const registro = lerRegistro();
  const noDrive = await md5sNoDrive(config.drive.rootFolderId);
  const pastas = new Map(); // cache: "Outubro - 2026" -> id da pasta
  let enviados = 0, jaExistiam = 0, falhas = 0, total = 0;

  for (const c of contas) {
    // Um documento por conta: o BOLETO; a fatura só quando não há boleto
    // (evita "duplicidade" de boleto + fatura da mesma conta na pasta).
    for (const arq of [documentoDaConta(c)]) {
      if (!arq) continue;
      total++;
      const hash = await md5(arq);
      if (registro[hash]) { jaExistiam++; continue; }   // já tratado antes (registro local)
      if (noDrive.has(hash)) {                           // mesmo conteúdo já está no Drive
        jaExistiam++;
        registro[hash] = { ...noDrive.get(hash), em: new Date().toISOString(), origem: 'ja-existia-no-drive' };
        gravarRegistro(registro);
        continue;
      }
      const nomePasta = nomePastaMes(anoMes(c));
      const nome = path.basename(arq);
      try {
        if (!pastas.has(nomePasta)) pastas.set(nomePasta, await drv.garantirPasta(nomePasta, config.drive.rootFolderId));
        const pastaId = pastas.get(nomePasta);
        const existente = await drv.buscarArquivo(nome, pastaId);
        if (existente) {
          jaExistiam++;
          registro[hash] = { id: existente.id, nome, pasta: nomePasta, em: new Date().toISOString(), origem: 'ja-existia' };
        } else {
          const r = await drv.enviarArquivo(arq, pastaId);
          registro[hash] = { id: r.id, nome, pasta: nomePasta, em: new Date().toISOString() };
          noDrive.set(hash, { id: r.id, nome, pasta: nomePasta });
          enviados++;
          log(`Drive: enviado ${nome} -> ${nomePasta}`);
        }
      } catch (e) {
        falhas++;
        logger.warn(`Drive: falha ao enviar ${nome}: ${e.message}`);
      }
      gravarRegistro(registro); // grava a cada arquivo: se cair no meio, não repete
    }
  }
  gravarRegistro(registro);
  log(`Drive: ${enviados} PDF(s) enviado(s), ${jaExistiam} já estavam lá, ${falhas} falha(s) — ${total} PDF(s) conferido(s).`);
  return { enviados, jaExistiam, falhas, total };
}

module.exports = { sincronizarDrive, anoMes, nomePastaMes, documentoDaConta, md5sNoDrive, lerRegistro, gravarRegistro };
