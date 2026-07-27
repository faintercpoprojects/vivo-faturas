'use strict';

const { config } = require('./config');
const { logger } = require('./logger');
const {
  onlyDigits,
  formatarCNPJ,
  cnpjValido,
  esperarEstabilizar,
  fecharOverlays,
  retry,
  sleep,
} = require('./utils');
const shadow = require('./shadow');

const DASHBOARD = 'https://mve.vivo.com.br/sec/dashboard';

/**
 * @typedef {Object} Contrato
 * @property {string} cnpj            somente digitos
 * @property {string} cnpjFormatado   00.000.000/0000-00
 * @property {string} empresa         razao social
 */

/** CNPJ da empresa atualmente ativa (lido do cabeçalho). */
async function empresaAtiva(page) {
  const texto = await shadow.textoPorClasse(page, 'customer-document');
  return texto ? onlyDigits(texto) : null;
}

/** Abre o slider de seleção de empresa (clica no nome da empresa no header). */
async function abrirSeletor(page) {
  // Já aberto?
  const cnpjs = await shadow.listarCnpjsSlider(page);
  const algumVisivel = await page.evaluate(() => {
    function* d(r){for(const e of r.querySelectorAll('*')){yield e; if(e.shadowRoot) yield* d(e.shadowRoot);}}
    for (const el of d(document)) if (/list-item-wrapper/i.test(el.className||'') && el.getAttribute('role')==='button' && (el.offsetParent||el.getClientRects().length)) return true;
    return false;
  });
  if (algumVisivel) return true;

  const abriu = await shadow.clicarPorClasse(page, 'customer-name');
  if (!abriu) {
    // fallback: às vezes o gatilho tem outra classe
    await shadow.clicarPorClasse(page, 'selected-company|company-name|customer-selector');
  }
  await sleep(2000);
  return true;
}

/** Clica em "Ver mais" no slider até carregar todos os CNPJs. */
async function carregarTodosCnpjs(page) {
  for (let i = 0; i < 60; i++) {
    const clicou = await page.evaluate(() => {
      const b = document.querySelector('#see-more-button');
      if (b && (b.offsetParent || b.getClientRects().length)) { b.click(); return true; }
      return false;
    });
    if (!clicou) break;
    await sleep(1200);
  }
}

/**
 * Enumera todos os CNPJs/empresas disponíveis na conta.
 * @param {import('playwright').Page} page
 * @returns {Promise<Contrato[]>}
 */
async function listarContratos(page) {
  return retry(
    async () => {
      // Garante estar no dashboard (onde o seletor de empresa existe).
      if (!/\/sec\//.test(page.url())) {
        await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
        await esperarEstabilizar(page, { timeout: 20000 });
      }
      await fecharOverlays(page);

      await abrirSeletor(page);
      await carregarTodosCnpjs(page);

      const itens = await shadow.listarCnpjsSlider(page);
      const vistos = new Set();
      /** @type {Contrato[]} */
      const contratos = [];

      for (const it of itens) {
        const cnpj = onlyDigits(it.cnpj);
        if (!cnpj || cnpj.length !== 14 || vistos.has(cnpj)) continue;
        vistos.add(cnpj);
        // texto = "RAZAO SOCIAL<cnpj>" -> nome é o que vem antes do CNPJ
        const empresa = it.texto.split(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)[0].replace(/[-–|]+$/, '').trim() || 'Empresa';
        contratos.push({ cnpj, cnpjFormatado: formatarCNPJ(cnpj), empresa: empresa.slice(0, 100) });
      }

      // Fecha o slider para não atrapalhar navegação seguinte.
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);

      if (!contratos.length) {
        throw new Error('Nenhum CNPJ encontrado no slider de empresas. Verifique src/shadow.js (listarCnpjsSlider).');
      }
      logger.info(`${contratos.length} empresa(s)/CNPJ(s) encontrada(s) na conta.`);
      return contratos;
    },
    { descricao: 'listagem de empresas' }
  );
}

/** Aplica CNPJ_IGNORAR e CNPJ_SOMENTE. */
function filtrarContratos(contratos) {
  const resultado = [];
  for (const c of contratos) {
    if (config.cnpj.ignorar.has(c.cnpj)) {
      logger.info(`IGNORADO por configuração: ${c.cnpjFormatado} (${c.empresa})`);
      continue;
    }
    if (config.cnpj.somente.size && !config.cnpj.somente.has(c.cnpj)) {
      logger.debug(`Fora do filtro CNPJ_SOMENTE: ${c.cnpjFormatado}`);
      continue;
    }
    resultado.push(c);
  }
  return resultado;
}

/**
 * Seleciona a empresa informada e aguarda o portal recarregar no contexto dela.
 * @param {import('playwright').Page} page
 * @param {Contrato} contrato
 */
async function selecionarContrato(page, contrato) {
  const jaAtiva = await empresaAtiva(page);
  if (jaAtiva === contrato.cnpj) {
    logger.debug(`Empresa ${contrato.cnpjFormatado} já está ativa.`);
    return true;
  }

  return retry(
    async () => {
      if (!/\/sec\//.test(page.url())) {
        await page.goto(DASHBOARD, { waitUntil: 'domcontentloaded' });
        await esperarEstabilizar(page, { timeout: 20000 });
      }
      await fecharOverlays(page);

      await abrirSeletor(page);
      await carregarTodosCnpjs(page);

      const clicou = await shadow.clicarItemEmpresa(page, contrato.cnpjFormatado);
      if (!clicou) {
        throw new Error(`Empresa ${contrato.cnpjFormatado} não localizada no slider.`);
      }

      // Aguarda o cabeçalho refletir a nova empresa.
      const ok = await aguardarEmpresa(page, contrato.cnpj, 20000);
      if (!ok) throw new Error(`Troca para ${contrato.cnpjFormatado} não confirmada.`);

      await esperarEstabilizar(page, { timeout: 15000 });

      // Razão social autoritativa: cabeçalho (.customer-name) ou variável global.
      let nome = await shadow.textoPorClasse(page, 'customer-name');
      if (!nome || !nome.trim()) {
        nome = await page
          .evaluate(() => window.dashboardCompanyName || (window.top && window.top.dashboardCompanyName) || null)
          .catch(() => null);
      }
      if (nome && nome.trim() && !/\d{2}\.\d{3}\.\d{3}/.test(nome)) {
        contrato.empresa = nome.trim().slice(0, 100);
      }

      logger.info(`Empresa ativa: ${contrato.cnpjFormatado} — ${contrato.empresa}`);
      return true;
    },
    { descricao: `seleção da empresa ${contrato.cnpjFormatado}` }
  );
}

async function aguardarEmpresa(page, cnpjDigitos, timeout) {
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((await empresaAtiva(page)) === cnpjDigitos) return true;
    await sleep(800);
  }
  return false;
}

module.exports = {
  listarContratos,
  filtrarContratos,
  selecionarContrato,
  empresaAtiva,
  abrirSeletor,
};
