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
async function capturarDownload(page, acaoClicar, destino, timeoutMs) {
  const context = page.context();
  const timeout = timeoutMs || config.browser.downloadTimeout;
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

/**
 * Abre o menu da conta #indice e clica no link do documento, capturando o PDF.
 * Re-tenta quando o portal não dispara o download (geração lenta do PDF é
 * intermitente); NÃO re-tenta quando o documento simplesmente não existe no menu.
 */
async function baixarDocumentoDaConta(page, indice, regexDoc, destino) {
  const tentativas = Math.max(2, config.run.maxRetries);
  // Timeout por tentativa menor que o global, para caber várias tentativas.
  const timeoutTentativa = Math.min(config.browser.downloadTimeout, 60000);
  let ultimoMotivo = 'sem tentativa';

  for (let t = 1; t <= tentativas; t++) {
    // (re)abre o menu do n-ésimo "Baixar fatura"
    const abriu = await shadow.clicar(page, BTN_BAIXAR, { nth: indice, tags: ['button'] });
    if (!abriu) {
      ultimoMotivo = `botão "Baixar fatura" #${indice} não encontrado`;
      await sleep(1000);
      continue;
    }
    await sleep(1800);

    // o documento está disponível? (ausência é definitiva — não re-tenta)
    if (!(await shadow.existe(page, regexDoc, { tags: ['a', 'button'] }))) {
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: false, ausente: true, motivo: 'documento não disponível no menu' };
    }

    const r = await capturarDownload(
      page,
      () => shadow.clicar(page, regexDoc, { nth: 0, tags: ['a', 'button'] }),
      destino,
      timeoutTentativa
    );

    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);

    if (r.ok) return r;
    ultimoMotivo = r.motivo;
    if (t < tentativas) {
      logger.debug(`Download não veio (tentativa ${t}/${tentativas}: ${r.motivo}); reabrindo menu...`);
      await esperarEstabilizar(page, { timeout: 6000 });
    }
  }
  return { ok: false, motivo: ultimoMotivo };
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

// Produtos conferidos por empresa. A página /sec/invoices mostra um produto
// por vez, controlado por um seletor (li.context-menu-item). Trocar o produto
// recarrega a lista de contas/faturas.
const PRODUTOS = [
  { key: 'Movel', rotulo: 'Vivo Móvel', re: '^vivo m[oó]vel$' },
  { key: 'Fixo', rotulo: 'Vivo Fixo', re: '^vivo fixo$' },
];

/** Lê o produto atualmente ativo no seletor (Movel|Fixo|null). */
async function produtoAtivo(page) {
  return page.evaluate(() => {
    function* deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* deep(el.shadowRoot);}}
    for (const el of deep(document)) {
      const cls = (el.className || '').toString();
      if (/context-menu-item\b/.test(cls) && /\bactive\b/.test(cls)) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/vivo fixo/i.test(t)) return 'Fixo';
        if (/vivo m[oó]vel/i.test(t)) return 'Movel';
      }
    }
    return null;
  });
}

/**
 * Troca o seletor de produto para `alvo` ('Movel'|'Fixo').
 * @returns {Promise<boolean>} true se o produto ficou ativo, false se indisponível.
 */
async function selecionarProduto(page, alvo) {
  if ((await produtoAtivo(page)) === alvo) return true;

  const alvoDef = PRODUTOS.find((p) => p.key === alvo);
  // Abre o menu clicando no produto atualmente ativo (tenta ambos os rótulos).
  for (const p of PRODUTOS) {
    if (await shadow.clicar(page, p.re, { tags: ['li', 'button', 'a'] })) break;
  }
  await sleep(1200);

  const ok = await shadow.clicar(page, alvoDef.re, { tags: ['li', 'button', 'a'] });
  await esperarEstabilizar(page, { timeout: 12000 });
  await sleep(1500);

  // Confirma pela marca "active" (se o produto existir para a empresa).
  return (await produtoAtivo(page)) === alvo || Boolean(ok);
}

/**
 * Lê o status de cada conta (fatura) visível, alinhado com a ordem dos botões
 * "Baixar fatura". O status fica em `span.invoice-due-date-label-<estado>`:
 *   -in-arrears = Atrasada | -due = A vencer | -paid/-settled = Paga.
 * Detecção conservadora: só marca `paga` quando há sinal claro de pagamento —
 * qualquer outro/desconhecido é tratado como pendente (baixa).
 * @returns {Promise<Array<{paga:boolean, status:string}>>}
 */
async function statusDasContas(page) {
  return page.evaluate(() => {
    function* deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* deep(el.shadowRoot);}}
    const vis = el => !!(el.offsetParent || el.getClientRects().length);

    // 1) coleta os marcadores de status de cada fatura (badges) com posição Y.
    //    badge success = paga | badge warning ("Pronta pra pagar") = pendente |
    //    badge danger = atrasada/vencida. Também aceita invoice-due-date-label.
    const marcadores = [];
    for (const el of deep(document)) {
      if (!vis(el)) continue;
      const cls = (el.className || '').toString();
      const ehBadge = /\bbadge\b/.test(cls) && !/badge__icon/.test(cls);
      const ehLabel = /invoice-due-date-label/i.test(cls);
      if (!ehBadge && !ehLabel) continue;

      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 32) continue; // ignora badges numéricos / blocos grandes

      const temPalavraStatus = /pag|vencer|vencid|atrasad|aberto|pronta|contestad|autorizad|processand|liquidad/i.test(txt);
      const temClasseStatus = /success|warning|danger|paid|arrears|-due\b/i.test(cls);
      if (!temPalavraStatus && !temClasseStatus) continue;

      // "pagar"/"pronta pra pagar" NÃO é paga; "paga"/"pago"/"...paga" é.
      const paga = /\bsuccess\b|paid|settled|liquidad/i.test(cls) ||
                   /\bpag[oa]\b/i.test(txt) ||
                   /pagamento\s+(confirmad|efetuad|realizad)/i.test(txt);

      let status;
      if (paga) status = 'Paga';
      else if (/danger|arrears|atrasad|vencid/i.test(cls + ' ' + txt)) status = 'Atrasada';
      else if (/warning|pronta|a vencer|-due|aberto|pendente/i.test(cls + ' ' + txt)) status = 'Pendente';
      else status = txt.slice(0, 25) || 'desconhecido';

      marcadores.push({ y: el.getBoundingClientRect().top, paga, status });
    }

    // 2) pareia cada botão "Baixar fatura" com o marcador mais próximo em Y.
    const botoesY = [...deep(document)]
      .filter(el => el.tagName.toLowerCase() === 'button' && /^baixar fatura$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()) && vis(el))
      .map(el => el.getBoundingClientRect().top);

    return botoesY.map((by) => {
      let best = null, bestDist = Infinity;
      for (const m of marcadores) {
        const d = Math.abs(m.y - by);
        if (d < bestDist) { bestDist = d; best = m; }
      }
      // Só considera pago se o marcador PAGO estiver claramente no card do botão.
      // Caso contrário (longe/ausente/desconhecido) => trata como pendente (baixa).
      if (!best || bestDist > 220) return { paga: false, status: 'desconhecido' };
      return { paga: best.paga, status: best.status };
    });
  });
}

/**
 * Baixa as contas VISÍVEIS do produto atual (Fatura + Boleto por conta),
 * PULANDO faturas com status "Paga". Só baixa as pendentes.
 * @returns {Promise<{faturas:number, boletos:number, pagasIgnoradas:number}>}
 */
async function baixarContasDoProduto(page, contrato, contas, rotulo, onDocumento) {
  const hoje = new Date();
  let faturas = 0;
  let boletos = 0;
  let pagasIgnoradas = 0;

  const status = await statusDasContas(page);

  for (let i = 0; i < contas; i++) {
    const st = status[i];
    if (st && st.paga) {
      pagasIgnoradas++;
      logger.info(`  • ${rotulo} conta ${i}: fatura PAGA — ignorada.`);
      continue;
    }
    logger.debug(`${contrato.cnpjFormatado} [${rotulo}] conta ${i}: status ${st ? st.status : 'n/d'}`);

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

  return { faturas, boletos, pagasIgnoradas };
}

/**
 * Processa a empresa ativa conferindo AMBOS os produtos (Vivo Móvel e Vivo Fixo).
 * Para cada produto: seleciona no seletor, e para cada conta baixa Fatura e
 * Boleto (quando existir). "Sem botão Baixar fatura" = produto sem fatura
 * emitida no momento -> pula. Chama `onDocumento` para cada PDF baixado.
 *
 * @param {import('playwright').Page} page
 * @param {import('./selecionarCNPJ').Contrato} contrato
 * @param {(doc:object) => Promise<void>} onDocumento
 * @returns {Promise<{contas:number, faturas:number, boletos:number, semFatura:boolean}>}
 */
async function processarEmpresa(page, contrato, onDocumento) {
  await abrirAreaFaturas(page);

  let faturas = 0;
  let boletos = 0;
  let totalContas = 0;
  let pagasIgnoradas = 0;

  for (const produto of PRODUTOS) {
    // Seleciona o produto (Móvel já é o padrão; Fixo exige a troca).
    const disponivel = await selecionarProduto(page, produto.key);
    if (!disponivel) {
      logger.debug(`${contrato.cnpjFormatado}: seletor "${produto.rotulo}" indisponível — pulando produto.`);
      continue;
    }

    const contas = await contarContas(page);
    if (contas === 0) {
      logger.info(`${contrato.cnpjFormatado} [${produto.rotulo}]: sem fatura emitida — pulando.`);
      continue;
    }

    logger.info(`${contrato.cnpjFormatado} [${produto.rotulo}]: ${contas} conta(s) com fatura.`);
    totalContas += contas;
    const r = await baixarContasDoProduto(page, contrato, contas, produto.rotulo, onDocumento);
    faturas += r.faturas;
    boletos += r.boletos;
    pagasIgnoradas += r.pagasIgnoradas;
  }

  // limpa staging vazio
  await fsp.rmdir(path.join(config.paths.downloads, '_tmp')).catch(() => {});

  return { contas: totalContas, faturas, boletos, pagasIgnoradas, semFatura: totalContas === 0 };
}

module.exports = {
  abrirAreaFaturas,
  contarContas,
  processarEmpresa,
  selecionarProduto,
  produtoAtivo,
  capturarDownload,
  metaDoNome,
  caminhoDestino,
  validarPDF,
};
