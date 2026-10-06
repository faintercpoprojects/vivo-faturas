'use strict';
// Diagnóstico: abre Faturas > Vivo Fixo de um CNPJ e mostra o que o leitor de
// cards (src/cardsFixo.js) entende de cada card, em todas as páginas.
//   node scripts/probe-fixo-status.js --headless [--cnpj 68165786000130]
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { abrirNavegador, garantirSessao } = require('../src/login');
const { listarContratos, selecionarContrato } = require('../src/selecionarCNPJ');
const { abrirAreaFaturas, selecionarProduto, irProximaPagina } = require('../src/baixarFaturas');
const { lerCardsFixoNaPagina } = require('../src/cardsFixo');

const alvo = (() => { const i = process.argv.indexOf('--cnpj'); return i > 0 ? process.argv[i + 1] : '68165786000130'; })();

(async () => {
  const { browser, page } = await abrirNavegador();
  try {
    await garantirSessao(page);
    const contratos = await listarContratos(page);
    const contrato = contratos.find((c) => c.cnpj === alvo.replace(/\D/g, ''));
    if (!contrato) throw new Error('CNPJ não encontrado na conta');
    await selecionarContrato(page, contrato);
    await abrirAreaFaturas(page);
    if (!(await selecionarProduto(page, 'Fixo'))) throw new Error('aba Vivo Fixo indisponível');
    await page.waitForTimeout(6000);
    const paginas = [];
    do {
      await page.waitForTimeout(2500);
      paginas.push(await page.evaluate(lerCardsFixoNaPagina));
    } while (paginas.length < 6 && (await irProximaPagina(page)));
    fs.writeFileSync(path.join(config.paths.logs, 'probe-fixo-status.json'), JSON.stringify(paginas, null, 2));
    paginas.forEach((p, i) => {
      console.log(`--- página ${i + 1}: ${p.length} card(s)`);
      for (const c of p) console.log(`  R$ ${c.valor} | ${c.mes}/${c.ano} | status: ${c.rotuloStatus} -> ${c.status} | cliente ${c.codigoCliente} | ${c.endereco}`);
    });
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('Falha:', e.message); process.exit(1); }).finally(() => setTimeout(() => process.exit(), 1500));
