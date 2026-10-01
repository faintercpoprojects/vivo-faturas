'use strict';

/**
 * Outras operadoras (além da Vivo) cujo portal de 2ª via abre só com o CNPJ:
 *
 *   Desktop  https://central.desktop.com.br/bill   ("Boleto Fácil")
 *            A tela chama /api/integrator/unpaid_bill/ e devolve as faturas
 *            (abertas e pagas) com valor, vencimento, linha digitável e Pix.
 *            Não há PDF para baixar (o portal só envia a 2ª via por e-mail/SMS).
 *   AONet    https://minhaaonet.com.br/pagamento
 *            Tela Livewire: CNPJ -> contratos -> faturas em aberto, com linha
 *            digitável, Pix e link direto do PDF do boleto.
 *
 * Usamos o navegador como uma pessoa usaria (digita o CNPJ e clica). Se o
 * portal mostrar um desafio "não sou robô" visível, a coleta daquela operadora
 * para e registra o erro — não tentamos burlar.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { config } = require('./config');
const { logger } = require('./logger');

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const fmtCnpj = (c) => soDigitos(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const numBR = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const dataBR = (s) => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const hoje = () => new Date().toISOString().slice(0, 10);

/** Competência a partir do vencimento (AAAA-MM-DD -> MM/AAAA). */
function competenciaDe(venc) {
  const m = String(venc || '').match(/^(\d{4})-(\d{2})/);
  return m ? { competencia: `${m[2]}/${m[1]}`, ano: Number(m[1]), mes: Number(m[2]) } : {};
}

function statusDe({ paga, vencimento }) {
  if (paga) return 'Paga';
  if (vencimento && vencimento < hoje()) return 'Atrasada';
  return 'Pendente';
}

async function abrirNavegador() {
  const browser = await chromium.launch({ headless: config.browser.headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(30000);
  return { browser, context };
}

// ---------------------------------------------------------------- Desktop
async function coletarDesktop(context, cnpj) {
  const page = await context.newPage();
  const doc = soDigitos(cnpj);
  const faturas = [];
  const contratos = {};
  page.on('response', async (r) => {
    const u = r.url();
    try {
      if (u.includes('/api/integrator/unpaid_bill/')) faturas.push(...((await r.json()).data || []));
      else if (u.includes('/api/integrator/contract/')) {
        for (const c of (await r.json()).data || []) contratos[c.id] = c.attributes?.contract_name || c.id;
      }
    } catch { /* resposta não-JSON */ }
  });

  await page.goto('https://central.desktop.com.br/bill', { waitUntil: 'domcontentloaded' });
  const campo = page.getByPlaceholder('XXX.XXX.XXX-XX');
  await campo.waitFor();
  await campo.fill(doc);
  const resposta = page.waitForResponse((r) => r.url().includes('/api/integrator/unpaid_bill/'), { timeout: 45000 });
  await page.getByText('Avançar', { exact: true }).click();
  try {
    await resposta;
  } catch {
    const texto = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
    throw new Error(`Desktop: faturas não carregaram para ${fmtCnpj(cnpj)}. Tela: ${texto.replace(/\s+/g, ' ')}`);
  }
  await page.waitForTimeout(2000); // vários contratos -> várias respostas
  await page.close();

  return faturas.map(({ id, attributes: a }) => {
    const vencimento = a.vencimento || null;
    return {
      produto: 'Desktop',
      linha: a.contract_id,
      contrato: contratos[a.contract_id] || null,
      numeroDocumento: a.code_fatura || id,
      dataVencimento: vencimento,
      valor: a.valor != null ? Number(a.valor) : null,
      statusPortal: statusDe({ paga: a.is_paid || a.status === 'Paid', vencimento }),
      linhaDigitavel: a.barcode || null,
      pixCode: a.pix_code || null,
      ...competenciaDe(vencimento),
    };
  });
}

// ---------------------------------------------------------------- AONet
/** Acha, em qualquer profundidade do snapshot Livewire, as faturas. */
function faturasDoSnapshot(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach((x) => faturasDoSnapshot(x, out));
  else if (obj && typeof obj === 'object') {
    if ('billetDigitableLine' in obj || 'invoicePDFURL' in obj) out.push(obj);
    else Object.values(obj).forEach((x) => faturasDoSnapshot(x, out));
  }
  return out;
}

async function coletarAonet(context, cnpj, pastaBase) {
  const page = await context.newPage();
  await page.goto('https://minhaaonet.com.br/pagamento', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Digite seu CPF ou CNPJ').fill(soDigitos(cnpj));
  await page.getByRole('button', { name: /Buscar Faturas/i }).click();

  const cards = page.locator('[wire\\:click^="selectContrato"]');
  try {
    await cards.first().waitFor({ timeout: 30000 });
  } catch {
    const texto = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (/nenhum|não encontrad/i.test(texto)) { await page.close(); return []; }
    throw new Error(`AONet: contratos não carregaram para ${fmtCnpj(cnpj)}. Tela: ${texto.slice(0, 300)}`);
  }

  const total = await cards.count();
  const resultado = [];
  for (let i = 0; i < total; i++) {
    const card = page.locator(`[wire\\:click="selectContrato(${i})"]`);
    const contrato = (await card.innerText()).replace(/\s+/g, ' ').replace(/^Ativo\s+/i, '').trim();
    const resp = page.waitForResponse((r) => r.url().includes('/livewire/update') && r.request().method() === 'POST');
    await card.click();
    const json = await (await resp).json();
    let faturas = [];
    for (const c of json.components || []) {
      try { faturas.push(...faturasDoSnapshot(JSON.parse(c.snapshot).data)); } catch { /* snapshot ilegível */ }
    }
    for (const f of faturas) {
      const vencimento = dataBR(f.data);
      const comp = competenciaDe(vencimento);
      let boletoPdfPath = null;
      if (f.invoicePDFURL) {
        try {
          const r = await context.request.get(f.invoicePDFURL);
          const tipo = r.headers()['content-type'] || '';
          if (r.ok() && /pdf/i.test(tipo)) {
            const pasta = path.join(pastaBase, String(comp.ano || 'sem-data'), String(comp.mes || '').padStart(2, '0'));
            fs.mkdirSync(pasta, { recursive: true });
            boletoPdfPath = path.join(pasta, `Boleto-AONet-${(vencimento || 'sem-data').replace(/-/g, '')}.pdf`);
            fs.writeFileSync(boletoPdfPath, await r.body());
          } else {
            logger.warn(`AONet: PDF do boleto não veio como PDF (${r.status()} ${tipo}).`);
          }
        } catch (e) {
          logger.warn(`AONet: falha ao baixar o PDF do boleto: ${e.message}`);
        }
      }
      resultado.push({
        produto: 'AONet',
        linha: contrato.slice(0, 80),
        contrato,
        numeroDocumento: null,
        dataVencimento: vencimento,
        valor: f.valor_total ? numBR(f.valor_total) : null,
        statusPortal: statusDe({ paga: false, vencimento }), // o portal só lista faturas em aberto
        linhaDigitavel: soDigitos(f.billetDigitableLine) || null,
        pixCode: f.pixCode || null,
        boletoPdfPath,
        ...comp,
      });
    }
    if (i < total - 1) {
      await page.locator('[wire\\:click="voltarParaContratos"]').click();
      await cards.first().waitFor();
    }
  }
  await page.close();
  return resultado;
}

const COLETORES = { desktop: coletarDesktop, aonet: coletarAonet };

module.exports = { COLETORES, abrirNavegador, fmtCnpj, soDigitos, faturasDoSnapshot, statusDe };
