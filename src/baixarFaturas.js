'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { config } = require('./config');
const { logger } = require('./logger');
const {
  ensureDir,
  existe,
  ehPDF,
  esperarEstabilizar,
  fecharOverlays,
  pad2,
  sleep,
  onlyDigits,
} = require('./utils');
const shadow = require('./shadow');

const INVOICES = 'https://mve.vivo.com.br/sec/invoices';

// Rótulos reais dos itens do menu "Baixar fatura" no MVE.
const DOC_FATURA = 'Conta detalhada e nota fiscal';
const DOC_BOLETO = 'Boleto \\(\\.pdf\\)';
const BTN_BAIXAR = '^\\s*baixar fatura\\s*$';

/**
 * Vai para a área de faturas da empresa ativa e aguarda a página assentar.
 * NÃO clica em links de menu — apenas navega. A página é escopada pela empresa
 * atualmente selecionada no cabeçalho.
 */
async function abrirAreaFaturas(page) {
  await page.goto(INVOICES, { waitUntil: 'domcontentloaded', timeout: config.browser.navTimeout });
  await esperarEstabilizar(page, { timeout: 20000 });
  await fecharOverlays(page);
}

/**
 * Espera (limitado) os botões "Baixar fatura" aparecerem e rola a página para
 * carregar todas as contas (lazy loading). Se nenhum botão surgir dentro do
 * limite, a fatura ainda não foi emitida -> retorna 0 (o chamador pula).
 *
 * @returns {Promise<number>} quantidade de botões "Baixar fatura" (contas)
 */
async function contarContas(page, { esperaMax = 18000 } = {}) {
  const fim = Date.now() + esperaMax;
  let qtd = 0;
  while (Date.now() < fim) {
    qtd = await shadow.contar(page, BTN_BAIXAR, { tags: ['button'] });
    if (qtd > 0) break;
    await page.mouse.wheel(0, 900).catch(() => {});
    await sleep(1500);
  }
  if (qtd === 0) return 0;

  // Rola até o fim para materializar todas as contas, depois volta ao topo.
  let anterior = -1;
  for (let i = 0; i < 25; i++) {
    const atual = await shadow.contar(page, BTN_BAIXAR, { tags: ['button'] });
    if (atual === anterior) break;
    anterior = atual;
    await page.mouse.wheel(0, 1500).catch(() => {});
    await sleep(1000);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(800);
  return shadow.contar(page, BTN_BAIXAR, { tags: ['button'] });
}

/**
 * Captura o arquivo produzido por `acaoClicar`, cobrindo download nativo,
 * popup com download e popup que renderiza o PDF (baixado via HTTP com a sessão).
 *
 * @returns {Promise<{ok:boolean, suggested?:string, motivo?:string}>}
 */
async function capturarDownload(page, acaoClicar, destino) {
  const context = page.context();
  const timeout = config.browser.downloadTimeout;
  await ensureDir(path.dirname(destino));

  const dl = page.waitForEvent('download', { timeout }).catch(() => null);
  const pop = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);

  await acaoClicar();

  const res = await Promise.race([
    dl.then((d) => (d ? { t: 'dl', d } : null)),
    pop.then((p) => (p ? { t: 'pop', p } : null)),
    sleep(timeout).then(() => null),
  ]);

  if (res && res.t === 'dl') {
    const falha = await res.d.failure();
    if (falha) return { ok: false, motivo: `download falhou: ${falha}` };
    await res.d.saveAs(destino);
    return { ok: true, suggested: res.d.suggestedFilename() };
  }

  if (res && res.t === 'pop') {
    const p = res.p;
    try {
      const pdl = await p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      if (pdl) {
        await pdl.saveAs(destino);
        return { ok: true, suggested: pdl.suggestedFilename() };
      }
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      const url = p.url();
      if (/^https?:/i.test(url)) {
        const r = await context.request.get(url, { timeout });
        if (r.ok()) {
          const buf = await r.body();
          if (buf && buf.length > 1024) {
            await fsp.writeFile(destino, buf);
            return { ok: true, suggested: path.basename(new URL(url).pathname) };
          }
        }
      }
      return { ok: false, motivo: `popup sem PDF: ${url}` };
    } finally {
      await p.close().catch(() => {});
    }
  }

  return { ok: false, motivo: 'sem evento de download/popup' };
}

/**
 * Extrai metadados do nome sugerido pelo portal.
 * Ex.: "072026-0443307515-vivomovel-fatura.pdf"
 *      -> { ano:2026, mes:7, linha:'0443307515', produto:'Movel' }
 */
function metaDoNome(suggested, fallback = {}) {
  const nome = String(suggested || '').toLowerCase();
  const meta = { ...fallback };

  const mComp = nome.match(/(?:^|[^\d])(\d{2})(\d{4})[-_]/);
  if (mComp) {
    meta.mes = Number(mComp[1]);
    meta.ano = Number(mComp[2]);
  }
  const mLinha = nome.match(/[-_](\d{6,})[-_]/);
  if (mLinha) meta.linha = mLinha[1];

  if (/vivofixo|vivo-fixo|_fixo|-fixo/.test(nome)) meta.produto = 'Fixo';
  else if (/vivomovel|vivo-movel|_movel|-movel/.test(nome)) meta.produto = 'Movel';

  return meta;
}

/** Abre o menu da conta #indice e clica no link do documento, capturando o PDF. */
async function baixarDocumentoDaConta(page, indice, regexDoc, destino) {
  // (re)abre o menu do n-ésimo "Baixar fatura"
  const abriu = await shadow.clicar(page, BTN_BAIXAR, { nth: indice, tags: ['button'] });
  if (!abriu) return { ok: false, motivo: `botão "Baixar fatura" #${indice} não encontrado` };
  await sleep(1800);

  // o documento está disponível?
  if (!(await shadow.existe(page, regexDoc, { tags: ['a', 'button'] }))) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, ausente: true, motivo: 'documento não disponível no menu' };
  }

  const r = await capturarDownload(
    page,
    () => shadow.clicar(page, regexDoc, { nth: 0, tags: ['a', 'button'] }),
    destino
  );

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);
  return r;
}

/** Valida que o arquivo é um PDF real. */
async function validarPDF(arquivo) {
  if (!existe(arquivo)) throw new Error(`Arquivo não criado: ${arquivo}`);
  const { size } = await fsp.stat(arquivo);
  if (size < 1024) {
    await fsp.unlink(arquivo).catch(() => {});
    throw new Error(`Arquivo suspeito (${size} bytes).`);
  }
  if (!(await ehPDF(arquivo))) {
    await fsp.unlink(arquivo).catch(() => {});
    throw new Error('Arquivo baixado não é PDF válido.');
  }
  return true;
}

/** Monta o caminho local CNPJ/ANO/MES/arquivo.pdf */
function caminhoDestino({ cnpjFormatado, ano, mes, arquivo }) {
  return path.join(
    config.paths.downloads,
    cnpjFormatado.replace(/\//g, '-'),
    String(ano),
    pad2(mes),
    arquivo
  );
}

/**
 * Processa TODAS as contas da empresa ativa na página de faturas.
 * Para cada conta baixa a Fatura (Conta detalhada e nota fiscal) e o Boleto
 * (quando existir), organiza em CNPJ/ANO/MES e chama `onDocumento` para cada
 * arquivo baixado (para IA + upload + manifest a cargo do chamador).
 *
 * @param {import('playwright').Page} page
 * @param {import('./selecionarCNPJ').Contrato} contrato
 * @param {(doc:{tipo:string, produto:string, ano:number, mes:number, linha:string,
 *           arquivo:string, competencia:{ano:number,mes:number}}) => Promise<void>} onDocumento
 * @returns {Promise<{contas:number, faturas:number, boletos:number, semFatura:boolean}>}
 */
async function processarEmpresa(page, contrato, onDocumento) {
  await abrirAreaFaturas(page);
  const contas = await contarContas(page);

  if (contas === 0) {
    logger.info(`${contrato.cnpjFormatado}: nenhuma fatura emitida no momento — pulando.`);
    return { contas: 0, faturas: 0, boletos: 0, semFatura: true };
  }

  logger.info(`${contrato.cnpjFormatado}: ${contas} conta(s) com fatura disponível.`);
  const hoje = new Date();
  let faturas = 0;
  let boletos = 0;

  for (let i = 0; i < contas; i++) {
    const docs = [
      { regex: DOC_FATURA, tipo: 'Fatura' },
      { regex: DOC_BOLETO, tipo: 'Boleto' },
    ];

    // metadados descobertos ao baixar a Fatura (reaproveitados no Boleto)
    let metaConta = null;

    for (const d of docs) {
      // destino provisório: só sabemos ANO/MES após ler o nome sugerido
      const tmpDir = path.join(config.paths.downloads, '_tmp');
      const tmp = path.join(tmpDir, `${contrato.cnpj}-c${i}-${d.tipo}-${Date.now()}.pdf`);

      const r = await baixarDocumentoDaConta(page, i, d.regex, tmp);
      if (!r.ok) {
        if (r.ausente) {
          logger.debug(`${contrato.cnpjFormatado} conta ${i}: ${d.tipo} indisponível.`);
        } else {
          logger.warn(`${contrato.cnpjFormatado} conta ${i}: falha ao baixar ${d.tipo} (${r.motivo}).`);
        }
        continue;
      }

      try {
        await validarPDF(tmp);
      } catch (err) {
        logger.warn(`${contrato.cnpjFormatado} conta ${i}: ${d.tipo} inválido — ${err.message}`);
        continue;
      }

      const meta = metaDoNome(r.suggested, metaConta || {});
      if (!meta.ano || !meta.mes) {
        meta.ano = meta.ano || hoje.getFullYear();
        meta.mes = meta.mes || hoje.getMonth() + 1;
        logger.warn(`${contrato.cnpjFormatado} conta ${i}: competência indefinida no nome "${r.suggested}", usando ${meta.ano}/${pad2(meta.mes)}.`);
      }
      if (d.tipo === 'Fatura') metaConta = { ano: meta.ano, mes: meta.mes, linha: meta.linha, produto: meta.produto };

      const prod = meta.produto || 'Movel';
      const sufixoLinha = meta.linha ? `-${meta.linha}` : `-c${i}`;
      const destino = caminhoDestino({
        cnpjFormatado: contrato.cnpjFormatado,
        ano: meta.ano,
        mes: meta.mes,
        arquivo: `${d.tipo}-${prod}${sufixoLinha}.pdf`,
      });

      if (existe(destino)) {
        logger.debug(`Já existe localmente, sobrescrevendo staging: ${path.basename(destino)}`);
        await fsp.unlink(tmp).catch(() => {});
      } else {
        await ensureDir(path.dirname(destino));
        await fsp.rename(tmp, destino).catch(async () => {
          await fsp.copyFile(tmp, destino);
          await fsp.unlink(tmp).catch(() => {});
        });
      }

      if (d.tipo === 'Fatura') faturas++;
      else boletos++;

      logger.info(`  ✓ ${d.tipo} ${prod} ${pad2(meta.mes)}/${meta.ano} linha ${meta.linha || '?'} -> ${path.relative(config.paths.downloads, destino)}`);

      await onDocumento({
        tipo: d.tipo,
        produto: prod,
        ano: meta.ano,
        mes: meta.mes,
        linha: meta.linha || '',
        arquivo: destino,
        competencia: { ano: meta.ano, mes: meta.mes },
      });
    }
  }

  // limpa staging vazio
  await fsp.rmdir(path.join(config.paths.downloads, '_tmp')).catch(() => {});

  return { contas, faturas, boletos, semFatura: false };
}

module.exports = {
  abrirAreaFaturas,
  contarContas,
  processarEmpresa,
  capturarDownload,
  metaDoNome,
  caminhoDestino,
  validarPDF,
};
