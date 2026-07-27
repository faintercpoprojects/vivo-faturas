'use strict';

const path = require('path');

const { config } = require('./config');
const { logger } = require('./logger');
const { FATURAS } = require('./selectors');
const {
  existe,
  primeiroVisivel,
  clicarSeguro,
  retry,
} = require('./utils');
const {
  capturarDownload,
  baixarPorRequisicao,
  expandirLinha,
  validarPDF,
} = require('./baixarFaturas');

/**
 * Baixa o boleto bancário de uma linha de fatura, quando existir.
 *
 * Boleto é opcional: faturas em débito automático, já pagas ou emitidas por
 * outro meio de cobrança simplesmente não oferecem o botão. Nesses casos a
 * função retorna { ok:false, ausente:true } — não é erro.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} linha
 * @param {string} destino
 * @returns {Promise<{ok: boolean, arquivo?: string, ausente?: boolean, motivo?: string}>}
 */
async function baixarBoleto(page, linha, destino) {
  if (existe(destino)) {
    logger.debug(`Boleto já existe localmente: ${destino}`);
    return { ok: true, arquivo: destino, jaExistia: true };
  }

  await expandirLinha(page, linha);

  const botao = await primeiroVisivel(linha, FATURAS.baixarBoleto, 3500);
  if (!botao) {
    logger.debug('Boleto não disponível para esta fatura (débito automático, paga ou sem cobrança bancária).');
    return { ok: false, ausente: true, motivo: 'boleto não disponível' };
  }

  return retry(
    async () => {
      const href = await botao.getAttribute('href').catch(() => null);
      if (href && /\.pdf(\?|$)/i.test(href)) {
        const url = new URL(href, page.url()).toString();
        await baixarPorRequisicao(page.context(), url, destino);
      } else {
        await capturarDownload(page, () => clicarSeguro(botao), destino);
      }

      await validarPDF(destino);
      logger.info(`Boleto salvo: ${path.relative(config.paths.downloads, destino)}`);
      return { ok: true, arquivo: destino };
    },
    { descricao: 'download do boleto', tentativas: config.run.maxRetries }
  );
}

module.exports = { baixarBoleto };
