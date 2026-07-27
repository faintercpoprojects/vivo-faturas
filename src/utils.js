'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const cliProgress = require('cli-progress');

const { config } = require('./config');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Basico
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Erro que nao deve ser re-tentado (credencial invalida, CNPJ sem faturas...). */
class ErroPermanente extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ErroPermanente';
    this.permanente = true;
    Object.assign(this, meta);
  }
}

/**
 * Retry com backoff exponencial + jitter.
 * @param {() => Promise<any>} fn
 * @param {{ tentativas?: number, delayBase?: number, descricao?: string, onRetry?: Function }} opts
 */
async function retry(fn, opts = {}) {
  const tentativas = opts.tentativas ?? config.run.maxRetries;
  const delayBase = opts.delayBase ?? config.run.retryBaseDelay;
  const descricao = opts.descricao || 'operacao';

  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn(i);
    } catch (err) {
      ultimoErro = err;
      if (err && err.permanente) throw err;
      // Erros classificados como permanentes pelo chamador não são re-tentados.
      if (opts.naoRetentarSe && opts.naoRetentarSe(err)) throw err;
      if (i === tentativas) break;
      const espera = Math.round(delayBase * Math.pow(2, i - 1) * (0.75 + Math.random() * 0.5));
      logger.warn(`Falha em "${descricao}" (tentativa ${i}/${tentativas}): ${err.message}. Retentando em ${espera}ms`);
      if (opts.onRetry) await opts.onRetry(err, i);
      await sleep(espera);
    }
  }
  ultimoErro.message = `[${descricao}] ${ultimoErro.message}`;
  throw ultimoErro;
}

/**
 * Executa tarefas com limite de concorrencia preservando a ordem dos resultados.
 */
async function mapLimit(items, limite, fn) {
  const resultados = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      resultados[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return resultados;
}

// ---------------------------------------------------------------------------
// Strings / CNPJ / datas
// ---------------------------------------------------------------------------

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

/** Formata 11222333000144 -> 11.222.333/0001-44 */
function formatarCNPJ(valor) {
  const d = onlyDigits(valor).padStart(14, '0').slice(0, 14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

/** Extrai o primeiro CNPJ encontrado num texto livre. */
function extrairCNPJ(texto) {
  const m = String(texto || '').match(/\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}/);
  return m ? onlyDigits(m[0]) : null;
}

function cnpjValido(valor) {
  const d = onlyDigits(valor);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = base.split('').reduce((acc, n, i) => acc + Number(n) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = calc(d.slice(0, 12));
  const dv2 = calc(d.slice(0, 12) + dv1);
  return d === d.slice(0, 12) + dv1 + dv2;
}

/** Remove caracteres invalidos para nome de arquivo/pasta no Windows e Linux. */
function sanitizarNome(nome, fallback = 'sem-nome') {
  const limpo = String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return limpo || fallback;
}

const MESES_PT = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/**
 * Interpreta competencia/vencimento em varios formatos e devolve { ano, mes }.
 * Aceita: "07/2026", "2026-07", "Jul/2026", "julho de 2026", "15/07/2026".
 */
function parseCompetencia(texto) {
  const t = String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  let m;
  if ((m = t.match(/(\d{4})[-/](\d{1,2})(?!\d)/))) {
    return { ano: Number(m[1]), mes: Number(m[2]) };
  }
  if ((m = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/))) {
    return { ano: Number(m[3]), mes: Number(m[2]) };
  }
  if ((m = t.match(/(\d{1,2})[/-](\d{4})/))) {
    return { ano: Number(m[2]), mes: Number(m[1]) };
  }
  if ((m = t.match(/([a-z]{3,})\.?\s*(?:de\s*)?[/\s-]?\s*(\d{4})/))) {
    const mes = MESES_PT[m[1].slice(0, 3)];
    if (mes) return { ano: Number(m[2]), mes };
  }
  return null;
}

/** "2026", "07" -> caminho pronto para uso */
const pad2 = (n) => String(n).padStart(2, '0');

const NOME_MES = [
  '', 'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/**
 * Normaliza valor monetario "R$ 1.234,56" -> "1234.56".
 * Idempotente: aplicar duas vezes nao corrompe o resultado.
 */
function normalizarValor(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return null;

  // Ja normalizado (formato de saida: -1234.56) -> devolve como esta.
  if (/^-?\d+(\.\d{1,2})?$/.test(bruto)) return bruto;

  const m = bruto.match(/-?[\d.]*\d(?:,\d{1,2})?/);
  if (!m) return null;
  return m[0].replace(/\./g, '').replace(',', '.');
}

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function existe(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

async function md5(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Verifica se o arquivo baixado e realmente um PDF (evita salvar HTML de erro). */
async function ehPDF(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    return buf.toString('latin1') === '%PDF-';
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Remove diretorio vazio subindo na arvore ate o limite. */
async function limparDiretoriosVazios(dir, limite) {
  let atual = path.resolve(dir);
  const parada = path.resolve(limite);
  while (atual.startsWith(parada) && atual !== parada) {
    try {
      const itens = await fsp.readdir(atual);
      if (itens.length) break;
      await fsp.rmdir(atual);
    } catch {
      break;
    }
    atual = path.dirname(atual);
  }
}

// ---------------------------------------------------------------------------
// Manifest (deduplicacao entre execucoes)
// ---------------------------------------------------------------------------

class Manifest {
  constructor(file = config.paths.manifest) {
    this.file = file;
    this.dados = { versao: 1, itens: {} };
    this.dirty = false;
  }

  async carregar() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.itens) this.dados = parsed;
    } catch {
      /* primeiro run */
    }
    return this;
  }

  static chave({ cnpj, tipo, ano, mes, doc }) {
    return `${onlyDigits(cnpj)}|${tipo}|${ano}-${pad2(mes)}|${doc}`;
  }

  tem(chave) {
    return Boolean(this.dados.itens[chave]);
  }

  /** Marca item como concluido (baixado/analisado/enviado). */
  marcar(chave, info) {
    this.dados.itens[chave] = { ...(this.dados.itens[chave] || {}), ...info, atualizadoEm: new Date().toISOString() };
    this.dirty = true;
  }

  obter(chave) {
    return this.dados.itens[chave];
  }

  async salvar() {
    if (!this.dirty) return;
    await ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.dados, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
    this.dirty = false;
  }
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function criarProgresso(titulo) {
  const multi = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `${titulo} {bar} {percentage}% | {value}/{total} | {etapa}`,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      stopOnComplete: false,
      forceRedraw: false,
      noTTYOutput: true,
      notTTYSchedule: 20000,
    },
    cliProgress.Presets.shades_grey
  );
  return multi;
}

// ---------------------------------------------------------------------------
// Playwright: esperas inteligentes
// ---------------------------------------------------------------------------

/**
 * Espera a pagina "assentar": rede ociosa + sem spinners visiveis + DOM estavel.
 * Nunca lanca por timeout de rede (SPAs mantem websockets abertos).
 */
async function esperarEstabilizar(page, { timeout = 20000, spinners = [] } = {}) {
  const inicio = Date.now();
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 15000) }).catch(() => {});

  const seletoresSpinner = [
    '[role="progressbar"]',
    '.loading:visible',
    '.spinner:visible',
    '.loader:visible',
    '[class*="skeleton"]:visible',
    '[class*="Loading"]:visible',
    ...spinners,
  ];
  for (const sel of seletoresSpinner) {
    const restante = timeout - (Date.now() - inicio);
    if (restante <= 0) break;
    await page
      .locator(sel)
      .first()
      .waitFor({ state: 'hidden', timeout: Math.min(restante, 8000) })
      .catch(() => {});
  }

  // DOM estavel: mesmo tamanho de HTML em duas amostras consecutivas.
  let anterior = -1;
  for (let i = 0; i < 5; i++) {
    const atual = await page.evaluate(() => document.body?.innerHTML.length || 0).catch(() => 0);
    if (atual === anterior) break;
    anterior = atual;
    await sleep(300);
  }
}

/**
 * Tenta uma lista de seletores e devolve o primeiro Locator visivel.
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function primeiroVisivel(scope, seletores, timeout = 10000) {
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    for (const sel of seletores) {
      const loc = typeof sel === 'string' ? scope.locator(sel).first() : sel;
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc;
      } catch {
        /* seletor invalido nesse contexto */
      }
    }
    await sleep(250);
  }
  return null;
}

/** Igual a primeiroVisivel, mas lanca se nao encontrar. */
async function exigirVisivel(scope, seletores, descricao, timeout = 15000) {
  const loc = await primeiroVisivel(scope, seletores, timeout);
  if (!loc) {
    throw new Error(
      `Elemento nao encontrado: ${descricao}. Seletores testados: ${JSON.stringify(seletores.slice(0, 8))}`
    );
  }
  return loc;
}

/** Clique resiliente: scroll, aguarda estabilidade, tenta force como ultimo recurso. */
async function clicarSeguro(locator, { timeout = config.browser.actionTimeout } = {}) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  try {
    await locator.click({ timeout });
  } catch (err) {
    await locator.click({ timeout: 5000, force: true });
  }
}

/**
 * Rola a pagina/container ate parar de crescer (lazy loading / scroll infinito).
 */
async function carregarTudoPorScroll(page, { maxRodadas = 40, container = null } = {}) {
  let alturaAnterior = 0;
  for (let i = 0; i < maxRodadas; i++) {
    const altura = await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : null;
      const alvo = el || document.scrollingElement || document.body;
      alvo.scrollTop = alvo.scrollHeight;
      if (!el) window.scrollTo(0, document.body.scrollHeight);
      return alvo.scrollHeight;
    }, container);
    await sleep(700);
    if (altura === alturaAnterior) break;
    alturaAnterior = altura;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

/** Captura screenshot de erro e devolve o caminho. */
async function screenshotErro(page, nome) {
  try {
    if (!page || page.isClosed()) return null;
    await ensureDir(config.paths.screenshots);
    const file = path.join(
      config.paths.screenshots,
      `${sanitizarNome(nome)}-${Date.now()}.png`
    );
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (err) {
    logger.debug(`Falha ao capturar screenshot: ${err.message}`);
    return null;
  }
}

/** Fecha cookie banners / modais que bloqueiam interacao. */
async function fecharOverlays(page) {
  const candidatos = [
    // Modal pos-login "cadastre um e-mail de recuperacao" -> Agora nao
    // (web component: aria-label primeiro, texto como fallback)
    'button[aria-label*="Agora não" i]',
    'button[aria-label*="Agora nao" i]',
    'button:has-text("Agora não")',
    'button:has-text("Agora nao")',
    'a:has-text("Agora não")',
    'button[aria-label*="Não, obrigado" i]',
    'button:has-text("Não, obrigado")',
    'button:has-text("Cadastrar depois")',
    'button:has-text("Aceitar todos")',
    'button:has-text("Aceitar")',
    'button:has-text("Concordo")',
    'button:has-text("Entendi")',
    '#onetrust-accept-btn-handler',
    '[id*="cookie"] button:has-text("Aceitar")',
    '[aria-label="Fechar"]',
    'button[aria-label="close"]',
    '.modal button.close',
  ];
  for (const sel of candidatos) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 400 })) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        await sleep(300);
      }
    } catch {
      /* ignora */
    }
  }
}

/** Formata duracao em ms para "1h 02m 03s". */
function formatarDuracao(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  if (h) return `${h}h ${pad2(m)}m ${pad2(seg)}s`;
  if (m) return `${m}m ${pad2(seg)}s`;
  return `${seg}s`;
}

module.exports = {
  sleep,
  retry,
  mapLimit,
  ErroPermanente,
  onlyDigits,
  formatarCNPJ,
  extrairCNPJ,
  cnpjValido,
  sanitizarNome,
  parseCompetencia,
  normalizarValor,
  pad2,
  NOME_MES,
  ensureDir,
  existe,
  md5,
  ehPDF,
  limparDiretoriosVazios,
  Manifest,
  criarProgresso,
  esperarEstabilizar,
  primeiroVisivel,
  exigirVisivel,
  clicarSeguro,
  carregarTudoPorScroll,
  screenshotErro,
  fecharOverlays,
  formatarDuracao,
};
