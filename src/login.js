'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { config } = require('./config');
const { logger } = require('./logger');
const { LOGIN } = require('./selectors');
const {
  ErroPermanente,
  ensureDir,
  esperarEstabilizar,
  fecharOverlays,
  primeiroVisivel,
  exigirVisivel,
  clicarSeguro,
  screenshotErro,
  retry,
  sleep,
} = require('./utils');

/**
 * Abre o navegador e devolve { browser, context, page }.
 * Reaproveita o storageState salvo quando REUSE_SESSION=true.
 */
async function abrirNavegador() {
  await ensureDir(config.paths.downloads);
  await ensureDir(path.dirname(config.paths.storageState));

  const browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  const temSessao = config.run.reuseSession && fs.existsSync(config.paths.storageState);
  if (temSessao) logger.info('Reaproveitando sessão salva em ' + config.paths.storageState);

  const context = await browser.newContext({
    acceptDownloads: true,
    locale: config.browser.locale,
    timezoneId: config.browser.timezone,
    userAgent: config.browser.userAgent,
    viewport: config.browser.viewport,
    storageState: temSessao ? config.paths.storageState : undefined,
    ignoreHTTPSErrors: true,
  });

  context.setDefaultTimeout(config.browser.actionTimeout);
  context.setDefaultNavigationTimeout(config.browser.navTimeout);

  // Mascara sinais obvios de automacao (o MVE usa antifraude no login).
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
  });

  const page = await context.newPage();

  page.on('pageerror', (err) => logger.debug(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') logger.debug(`console.error: ${msg.text().slice(0, 300)}`);
  });

  return { browser, context, page };
}

/** Detecta se a sessao ja esta autenticada. */
async function estaAutenticado(page) {
  const url = page.url();
  if (/login|signin|auth|acesso/i.test(url)) {
    // Ainda pode ser um redirect em curso; confirma pela presenca do formulario.
    const campo = await primeiroVisivel(page, LOGIN.usuario, 2000);
    if (campo) return false;
  }
  const marca = await primeiroVisivel(page, LOGIN.autenticado, 6000);
  return Boolean(marca);
}

/**
 * Dispensa o modal pos-login que oferece cadastrar e-mail de recuperacao,
 * clicando em "Agora nao". Aparece uma unica vez, as vezes com atraso; por isso
 * fazemos uma pequena sondagem. Ausencia do modal nao e erro.
 */
async function pularRecuperacao(page) {
  for (let i = 0; i < 6; i++) {
    const botao = await primeiroVisivel(page, LOGIN.pularRecuperacao, 1200);
    if (botao) {
      await clicarSeguro(botao).catch(() => {});
      logger.info('Modal de e-mail de recuperação dispensado ("Agora não").');
      await esperarEstabilizar(page, { timeout: 8000 });
      return true;
    }
    if (await estaAutenticado(page)) break;
    await sleep(1000);
  }
  return false;
}

/**
 * Preenche um campo de forma robusta em inputs de web component.
 *
 * .fill() apenas seta o value e NAO dispara a validacao interna do componente
 * (o botao "Continuar" fica inerte). Por isso usamos digitacao real por
 * teclado (pressSequentially), que gera os eventos que o formatador/validador
 * escuta. Para CPF/CNPJ digitamos so os digitos — o formatador aplica a mascara.
 */
async function preencherCampo(campo, valor) {
  await campo.click({ timeout: 5000 }).catch(() => {});

  // Limpa qualquer conteudo pre-existente.
  await campo.press('ControlOrMeta+a').catch(() => {});
  await campo.press('Delete').catch(() => {});
  await campo.fill('').catch(() => {});

  // CPF/CNPJ (so numeros e mascara) -> digita apenas digitos.
  const pareceDocumento = /^[\d.\-/\s]+$/.test(valor) && valor.replace(/\D/g, '').length >= 11;
  const aDigitar = pareceDocumento ? valor.replace(/\D/g, '') : valor;

  await campo.pressSequentially(aDigitar, { delay: 90 });

  // Confirma que algo entrou; se nao, tenta fill como ultimo recurso.
  const atual = await campo.inputValue().catch(() => '');
  if (!atual || atual.replace(/\D/g, '').length < Math.min(3, aDigitar.length)) {
    await campo.fill(valor).catch(() => {});
  }
}

/** Espera um locator ficar habilitado (sem atributo disabled/aria-disabled). */
async function esperarHabilitado(locator, timeout = 8000) {
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    const desabilitado = await locator
      .evaluate((el) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')
      .catch(() => false);
    if (!desabilitado) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Submete uma etapa do login. Em formulários de web component, pressionar Enter
 * no campo é mais confiável do que clicar no botão (que às vezes fica inerte).
 * O clique no botão fica como reforço, caso o Enter não avance.
 */
async function avancarEtapa(page, campo, botao) {
  await campo.press('Enter').catch(() => {});
  await sleep(1500);
  try {
    if (botao && (await botao.isVisible({ timeout: 1500 }))) {
      await botao.click({ timeout: 6000, force: true }).catch(() => {});
      await sleep(1000);
    }
  } catch {
    /* etapa provavelmente já avançou */
  }
}

/** Escopo de busca: pagina ou o iframe do IdP, se houver. */
async function escopoLogin(page) {
  for (const sel of LOGIN.frames) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 800 })) {
        logger.debug(`Formulário de login dentro do iframe: ${sel}`);
        return page.frameLocator(sel);
      }
    } catch {
      /* segue */
    }
  }
  return page;
}

/**
 * Executa o login. Idempotente: se ja houver sessao valida, apenas retorna.
 * @returns {Promise<{reaproveitada: boolean}>}
 */
async function login(page) {
  // Tenta reusar a sessão indo ao painel (SEM logout) antes de qualquer coisa.
  logger.info(`Abrindo o painel: ${config.portal.baseUrl}`);
  await page.goto(config.portal.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.browser.navTimeout });
  await esperarEstabilizar(page);
  await pularRecuperacao(page);
  await fecharOverlays(page);

  if (await estaAutenticado(page)) {
    logger.info('Sessão reaproveitada — login não foi necessário.');
    return { reaproveitada: true };
  }

  logger.info('Realizando login...');
  await retry(
    async (tentativa) => {
      // Vai para a página de login (VIVO_URL pode conter logout=true p/ sessão limpa).
      await page.goto(config.portal.url, { waitUntil: 'domcontentloaded' });
      await esperarEstabilizar(page);
      await fecharOverlays(page);

      let escopo = await escopoLogin(page);

      const campoUsuario = await exigirVisivel(escopo, LOGIN.usuario, 'campo de usuário', 20000);
      await preencherCampo(campoUsuario, config.portal.user);

      // Fluxo em duas etapas: CPF -> Continuar -> (navega p/ auth.vivo.com.br) -> senha
      let campoSenha = await primeiroVisivel(escopo, LOGIN.senha, 1500);
      if (!campoSenha) {
        const btnContinuar = await primeiroVisivel(escopo, LOGIN.continuar, 8000);
        await esperarHabilitado(btnContinuar || escopo.locator('body'), 8000);
        logger.debug('Enviando etapa 1 (CPF)...');
        await avancarEtapa(page, campoUsuario, btnContinuar);

        // O portal faz navegação cross-domain; aguarda a URL do IdP ou o campo.
        await page
          .waitForURL(/auth\.vivo\.com\.br|senha|password/i, { timeout: 25000 })
          .catch(() => {});
        await esperarEstabilizar(page, { timeout: 15000 });
        await fecharOverlays(page);

        // A etapa 2 pode estar em iframe do IdP: reavalia o escopo.
        escopo = await escopoLogin(page);
        campoSenha = await exigirVisivel(escopo, LOGIN.senha, 'campo de senha', 30000);
      }

      await preencherCampo(campoSenha, config.portal.pass);

      const btnEntrar = await primeiroVisivel(escopo, LOGIN.entrar, 10000);
      logger.debug('Enviando etapa 2 (senha)...');
      await avancarEtapa(page, campoSenha, btnEntrar);

      await esperarEstabilizar(page, { timeout: 30000 });
      await pularRecuperacao(page);
      await fecharOverlays(page);

      // Credenciais rejeitadas -> erro permanente, nao adianta retentar.
      const erro = await primeiroVisivel(page, LOGIN.erro, 2500);
      if (erro) {
        const texto = (await erro.textContent().catch(() => '')) || '';
        if (/senha|inválid|incorret|bloquead|credencia/i.test(texto)) {
          throw new ErroPermanente(`Login rejeitado pelo portal: ${texto.trim().slice(0, 200)}`);
        }
      }

      // MFA / captcha exige um humano.
      const desafio = await primeiroVisivel(page, LOGIN.desafio, 2000);
      if (desafio && !(await estaAutenticado(page))) {
        if (config.browser.headless) {
          throw new ErroPermanente(
            'O portal apresentou desafio de segurança (MFA/captcha) e a execução é headless. ' +
              'Rode `npm run login` para autenticar manualmente uma vez — a sessão será reutilizada.'
          );
        }
        logger.warn('Desafio de segurança detectado. Aguardando conclusão manual (até 5 minutos)...');
        const limite = Date.now() + 5 * 60 * 1000;
        while (Date.now() < limite) {
          if (await estaAutenticado(page)) break;
          await sleep(3000);
        }
      }

      if (!(await estaAutenticado(page))) {
        const shot = await screenshotErro(page, 'login-falhou');
        throw new Error(`Login não confirmado. URL atual: ${page.url()}${shot ? ` | screenshot: ${shot}` : ''}`);
      }
    },
    { descricao: 'login no portal', tentativas: Math.min(config.run.maxRetries, 3) }
  );

  await salvarSessao(page.context());
  logger.info('Login concluído com sucesso.');
  return { reaproveitada: false };
}

/** Persiste cookies/localStorage para reuso na proxima execucao. */
async function salvarSessao(context) {
  try {
    await ensureDir(path.dirname(config.paths.storageState));
    await context.storageState({ path: config.paths.storageState });
    logger.debug(`Sessão salva em ${config.paths.storageState}`);
  } catch (err) {
    logger.warn(`Não foi possível salvar a sessão: ${err.message}`);
  }
}

/**
 * Garante que a sessao continua valida no meio da execucao (o MVE expira sessao
 * com frequencia). Refaz o login se necessario.
 */
async function garantirSessao(page) {
  if (await estaAutenticado(page)) return true;
  logger.warn('Sessão expirou durante a execução — refazendo login.');
  await login(page);
  return true;
}

module.exports = { abrirNavegador, login, estaAutenticado, garantirSessao, salvarSessao };
