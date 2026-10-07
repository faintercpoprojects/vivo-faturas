#!/usr/bin/env node
'use strict';
/**
 * Envia ao Google Drive os PDFs de contas que ainda não estão lá.
 *   node scripts/sincronizar-drive.js
 * Saída: 0 = ok | 1 = alguns arquivos falharam | 2 = sem acesso ao Drive
 * (autorização do Google expirada: rode  npm run google:token ).
 */
const { sincronizarDrive } = require('../src/syncDrive');
const { logger } = require('../src/logger');

sincronizarDrive()
  .then((r) => { process.exitCode = r.falhas ? 1 : 0; })
  .catch((e) => {
    const auth = /invalid_grant|unauthorized|invalid_client|refresh token/i.test(e.message);
    logger.error(`Drive: ${e.message}${auth ? ' — a autorização do Google expirou. Rode "npm run google:token" neste computador para autorizar de novo.' : ''}`);
    process.exitCode = 2;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode), 1500));
