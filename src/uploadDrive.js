'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const { config } = require('./config');
const { logger } = require('./logger');
const { retry, md5, sanitizarNome, NOME_MES, pad2 } = require('./utils');

const ESCOPOS = ['https://www.googleapis.com/auth/drive'];
const MIME_PASTA = 'application/vnd.google-apps.folder';

let driveClient = null;
/** cache: "parentId/nome" -> folderId (evita centenas de chamadas repetidas) */
const cachePastas = new Map();

// ---------------------------------------------------------------------------
// Autenticacao
// ---------------------------------------------------------------------------

function criarAuth() {
  if (config.drive.serviceAccountFile && fs.existsSync(config.drive.serviceAccountFile)) {
    const credenciais = JSON.parse(fs.readFileSync(config.drive.serviceAccountFile, 'utf8'));
    logger.debug(`Google Drive: service account ${credenciais.client_email}`);
    return new google.auth.JWT({
      email: credenciais.client_email,
      key: credenciais.private_key,
      scopes: ESCOPOS,
      subject: config.drive.impersonateUser || undefined,
    });
  }

  if (config.drive.clientId && config.drive.clientSecret && config.drive.refreshToken) {
    logger.debug('Google Drive: OAuth2 com refresh token');
    const oauth = new google.auth.OAuth2(config.drive.clientId, config.drive.clientSecret);
    oauth.setCredentials({ refresh_token: config.drive.refreshToken });
    return oauth;
  }

  throw new Error('Credenciais do Google Drive não configuradas.');
}

/** Cliente singleton do Drive. */
function drive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: criarAuth() });
  }
  return driveClient;
}

/** Opções comuns para funcionar tanto em My Drive quanto em Shared Drives. */
function opcoesDrive(extra = {}) {
  const base = { supportsAllDrives: true, ...extra };
  return base;
}

function opcoesListagem(extra = {}) {
  const base = {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...extra,
  };
  if (config.drive.driveId) {
    base.driveId = config.drive.driveId;
    base.corpora = 'drive';
  }
  return base;
}

/** Valida credenciais e acesso à pasta raiz logo no início da execução. */
async function verificarConexao() {
  const resp = await retry(
    () =>
      drive().files.get(
        opcoesDrive({ fileId: config.drive.rootFolderId, fields: 'id, name, mimeType' })
      ),
    { descricao: 'validação da pasta raiz do Drive' }
  );
  logger.info(`Google Drive conectado. Pasta raiz: "${resp.data.name}" (${resp.data.id})`);
  return resp.data;
}

// ---------------------------------------------------------------------------
// Pastas
// ---------------------------------------------------------------------------

const escapar = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Retorna o id da subpasta `nome` dentro de `paiId`, criando-a se preciso.
 * Resultado memoizado por execução.
 */
async function garantirPasta(nome, paiId) {
  const limpo = sanitizarNomeDrive(nome);
  const chave = `${paiId}/${limpo}`;
  if (cachePastas.has(chave)) return cachePastas.get(chave);

  const id = await retry(
    async () => {
      const q = `name='${escapar(limpo)}' and '${paiId}' in parents and mimeType='${MIME_PASTA}' and trashed=false`;
      const lista = await drive().files.list(
        opcoesListagem({ q, fields: 'files(id, name)', pageSize: 10 })
      );
      if (lista.data.files && lista.data.files.length) return lista.data.files[0].id;

      const criada = await drive().files.create(
        opcoesDrive({
          requestBody: { name: limpo, mimeType: MIME_PASTA, parents: [paiId] },
          fields: 'id',
        })
      );
      logger.debug(`Pasta criada no Drive: ${limpo}`);
      return criada.data.id;
    },
    { descricao: `pasta "${limpo}" no Drive` }
  );

  cachePastas.set(chave, id);
  return id;
}

/**
 * O Drive aceita "/" em nomes, mas ele confunde ferramentas de sincronização.
 * Mantemos o CNPJ legível trocando a barra por hífen.
 */
function sanitizarNomeDrive(nome) {
  return sanitizarNome(String(nome).replace(/\//g, '-'));
}

/**
 * Cria/obtém a árvore:  Empresa / CNPJ / Ano / Mês
 * (ano primeiro, com os meses dentro do ano)
 * @returns {Promise<string>} id da pasta folha (o mês)
 */
async function garantirArvore({ empresa, cnpjFormatado, ano, mes }) {
  const raiz = config.drive.rootFolderId;
  const idEmpresa = await garantirPasta(empresa || 'Sem Empresa', raiz);
  const idCnpj = await garantirPasta(cnpjFormatado, idEmpresa);
  const idAno = await garantirPasta(String(ano), idCnpj);
  const idMes = await garantirPasta(`${pad2(mes)} - ${NOME_MES[mes] || 'Indefinido'}`, idAno);
  return idMes;
}

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

/**
 * Procura um arquivo por nome dentro da pasta.
 * @returns {Promise<{id:string, md5Checksum?:string, size?:string}|null>}
 */
async function buscarArquivo(nome, paiId) {
  const q = `name='${escapar(nome)}' and '${paiId}' in parents and trashed=false`;
  const lista = await retry(
    () =>
      drive().files.list(
        opcoesListagem({ q, fields: 'files(id, name, md5Checksum, size)', pageSize: 10 })
      ),
    { descricao: `busca de "${nome}" no Drive` }
  );
  return lista.data.files && lista.data.files.length ? lista.data.files[0] : null;
}

function mimeDe(arquivo) {
  const ext = path.extname(arquivo).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

/**
 * Envia um arquivo para a pasta, pulando se já existir com o mesmo conteúdo.
 *
 * @returns {Promise<{id:string, nome:string, status:'enviado'|'ja-existia'|'atualizado'}>}
 */
async function enviarArquivo(caminhoLocal, pastaId) {
  const nome = path.basename(caminhoLocal);
  const existente = await buscarArquivo(nome, pastaId);

  if (existente) {
    // Compara MD5: idêntico -> não reenvia; diferente -> atualiza a mesma versão.
    const hashLocal = await md5(caminhoLocal);
    if (existente.md5Checksum && existente.md5Checksum === hashLocal) {
      logger.debug(`Já existe no Drive (idêntico), pulando: ${nome}`);
      return { id: existente.id, nome, status: 'ja-existia' };
    }

    const atualizado = await retry(
      () =>
        drive().files.update(
          opcoesDrive({
            fileId: existente.id,
            media: { mimeType: mimeDe(caminhoLocal), body: fs.createReadStream(caminhoLocal) },
            fields: 'id',
          })
        ),
      { descricao: `atualização de "${nome}" no Drive` }
    );
    logger.info(`Arquivo atualizado no Drive: ${nome}`);
    return { id: atualizado.data.id, nome, status: 'atualizado' };
  }

  const criado = await retry(
    () =>
      drive().files.create(
        opcoesDrive({
          requestBody: { name: nome, parents: [pastaId] },
          media: { mimeType: mimeDe(caminhoLocal), body: fs.createReadStream(caminhoLocal) },
          fields: 'id, name',
        })
      ),
    { descricao: `upload de "${nome}" para o Drive` }
  );

  logger.info(`Enviado ao Drive: ${nome}`);
  return { id: criado.data.id, nome, status: 'enviado' };
}

/**
 * Envia um conjunto de arquivos (PDF + JSON) para a árvore correta.
 *
 * @param {string[]} arquivos caminhos locais
 * @param {{empresa:string, cnpjFormatado:string, ano:number, mes:number}} destino
 * @returns {Promise<Array<{arquivo:string, id:string, status:string}>>}
 */
async function uploadLote(arquivos, destino) {
  if (!config.drive.enabled) {
    logger.debug('Upload desabilitado (--no-upload ou GOOGLE_DRIVE_ENABLED=false).');
    return arquivos.map((a) => ({ arquivo: a, id: null, status: 'ignorado' }));
  }

  const pastaId = await garantirArvore(destino);
  const resultados = [];
  for (const arquivo of arquivos) {
    if (!fs.existsSync(arquivo)) continue;
    const r = await enviarArquivo(arquivo, pastaId);
    resultados.push({ arquivo, id: r.id, status: r.status });
  }
  return resultados;
}

module.exports = {
  drive,
  verificarConexao,
  garantirPasta,
  garantirArvore,
  buscarArquivo,
  enviarArquivo,
  uploadLote,
};
