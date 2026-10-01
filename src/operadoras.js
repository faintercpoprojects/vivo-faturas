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

// ---------------------------------------------------------------- Vero
/**
 * Minha Vero exige login (VERO_USUARIO / VERO_SENHA no .env). Usamos a mesma
 * API que o site chama (a tela de login trava em navegador automatizado):
 *   POST /cypher/auth/authenticate                    -> access_token
 *   GET  /cypher/financeiro/<doc>/faturas             -> faturas (abertas e pagas)
 *   GET  /cypher/veroapi/financeiro/fatura/<id>/exportar-pdf  -> PDF em base64
 */
const VERO_API = 'https://verointernet.com.br/cypher';

async function coletarVero(_context, cnpj, pastaBase) {
  const usuario = soDigitos(process.env.VERO_USUARIO);
  const senha = process.env.VERO_SENHA || '';
  if (!usuario || !senha) throw new Error('Vero: preencha VERO_USUARIO e VERO_SENHA no .env');
  if (usuario !== soDigitos(cnpj)) return []; // o login da Vero é de outro documento

  const auth = await fetch(`${VERO_API}/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: usuario, password: senha }),
  });
  if (auth.status === 401) throw new Error('Vero: usuário e/ou senha inválidos (confira VERO_USUARIO/VERO_SENHA no .env)');
  if (!auth.ok) throw new Error(`Vero: falha no login (HTTP ${auth.status})`);
  const { access_token: token } = await auth.json();
  const hdr = (crm) => ({ Authorization: `Bearer ${token}`, CRM: crm || 'todos', Accept: 'application/json' });

  const r = await fetch(`${VERO_API}/financeiro/${usuario}/faturas`, { headers: hdr() });
  if (!r.ok) throw new Error(`Vero: faturas não carregaram (HTTP ${r.status})`);
  const faturas = await r.json();

  const resultado = [];
  for (const f of Array.isArray(faturas) ? faturas : []) {
    const vencimento = f.dataVencimento || null;
    const comp = competenciaDe(vencimento);
    const paga = /pag|quit|baix/i.test(f.status || '');
    let boletoPdfPath = null;
    if (!paga && f.idFatura) {
      try {
        const p = await fetch(`${VERO_API}/veroapi/financeiro/fatura/${f.idFatura}/exportar-pdf`, { headers: hdr(f.crm) });
        // A API devolve o PDF como lista de bytes em JSON ([37,80,68,70,...]);
        // aceita também base64, caso mude.
        const corpo = p.ok ? await p.json() : null;
        const buf = Array.isArray(corpo) ? Buffer.from(corpo)
          : typeof corpo === 'string' ? Buffer.from(corpo, 'base64') : null;
        if (buf && buf.subarray(0, 4).toString() === '%PDF') {
          const pasta = path.join(pastaBase, String(comp.ano || 'sem-data'), String(comp.mes || '').padStart(2, '0'));
          fs.mkdirSync(pasta, { recursive: true });
          boletoPdfPath = path.join(pasta, `Fatura-Vero-${f.idFatura}.pdf`);
          fs.writeFileSync(boletoPdfPath, buf);
        } else {
          logger.warn(`Vero: PDF da fatura ${f.idFatura} não veio (HTTP ${p.status}).`);
        }
      } catch (e) {
        logger.warn(`Vero: falha ao baixar o PDF da fatura ${f.idFatura}: ${e.message}`);
      }
    }
    resultado.push({
      produto: 'Vero',
      linha: f.descricaoContrato || f.crm || 'Vero',
      contrato: f.descricaoContrato || null,
      numeroDocumento: f.idFatura ? String(f.idFatura) : null,
      dataVencimento: vencimento,
      valor: f.valorTotal != null ? Number(f.valorTotal) : f.valor != null ? Number(f.valor) : null,
      statusPortal: /venc|atras/i.test(f.status || '') ? 'Atrasada' : statusDe({ paga, vencimento }),
      linhaDigitavel: f.linhaDigitavel || f.codigoDeBarras || null,
      pixCode: f.pixCopiaCola || null,
      boletoPdfPath,
      ...comp,
    });
  }
  return resultado;
}

const COLETORES = { desktop: coletarDesktop, aonet: coletarAonet, vero: coletarVero };

module.exports = { COLETORES, abrirNavegador, fmtCnpj, soDigitos, faturasDoSnapshot, statusDe };
