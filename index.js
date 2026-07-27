#!/usr/bin/env node
'use strict';

/**
 * ---------------------------------------------------------------------------
 * Automação Vivo Empresas (MVE) — faturas e boletos
 * ---------------------------------------------------------------------------
 * Fluxo: login -> percorre CNPJs -> Vivo Móvel e Vivo Fixo -> baixa PDF e
 * boleto -> extrai texto -> IA gera JSON -> upload para o Google Drive ->
 * limpeza local -> relatório.
 *
 * Uso:
 *   node index.js                      execução completa
 *   node index.js --headed             com navegador visível
 *   node index.js --no-upload --no-ia  só baixa (teste)
 *   node index.js --cnpj 11222333000144
 *   node index.js --only-login         autentica e salva a sessão
 */

const fsp = require('fs/promises');
const path = require('path');

const { config, validate } = require('./src/config');
const { logger, salvarRelatorio } = require('./src/logger');
const { abrirNavegador, login, garantirSessao, salvarSessao } = require('./src/login');
const { listarContratos, filtrarContratos, selecionarContrato } = require('./src/selecionarCNPJ');
const { processarEmpresa } = require('./src/baixarFaturas');
const { analisarPDF } = require('./src/analisarPDF');
const { dumpDashboard } = require('./src/diagnostico');
const { uploadLote, verificarConexao } = require('./src/uploadDrive');
const {
  Manifest,
  criarProgresso,
  screenshotErro,
  formatarDuracao,
  limparDiretoriosVazios,
  pad2,
  ensureDir,
  esperarEstabilizar,
} = require('./src/utils');

// ---------------------------------------------------------------------------
// Estatísticas
// ---------------------------------------------------------------------------

const stats = {
  inicio: Date.now(),
  contratosTotal: 0,
  contratosProcessados: 0,
  contratosIgnorados: 0,
  contratosComErro: 0,
  faturasEncontradas: 0,
  faturasBaixadas: 0,
  boletosBaixados: 0,
  boletosAusentes: 0,
  jsonsGerados: 0,
  uploads: 0,
  uploadsJaExistiam: 0,
  arquivosRemovidos: 0,
  puladosPorManifest: 0,
  erros: [],
};

function registrarErro(escopo, err, extras = {}) {
  const registro = {
    escopo,
    mensagem: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null,
    ...extras,
    em: new Date().toISOString(),
  };
  stats.erros.push(registro);
  logger.error(`[${escopo}] ${registro.mensagem}`, { stack: registro.stack, ...extras });
  return registro;
}

// ---------------------------------------------------------------------------
// Processamento de um documento (fatura ou boleto)
// ---------------------------------------------------------------------------

/**
 * Processa um documento já baixado: IA -> JSON, upload ao Drive, limpeza e
 * marcação no manifest. Chamado pelo processarEmpresa para cada PDF.
 */
async function finalizarDocumento(doc, contrato, manifest) {
  const chave = Manifest.chave({
    cnpj: contrato.cnpj,
    tipo: doc.produto,
    ano: doc.ano,
    mes: doc.mes,
    doc: `${doc.tipo}-${doc.linha || 'x'}`,
  });

  const contexto = {
    cnpj: contrato.cnpj,
    cnpjFormatado: contrato.cnpjFormatado,
    empresa: contrato.empresa,
    tipo: doc.produto, // 'Movel' | 'Fixo'
    ano: doc.ano,
    mes: doc.mes,
    linha: doc.linha || '',
    documento: doc.tipo, // 'Fatura' | 'Boleto'
  };

  const arquivos = [doc.arquivo];

  // 1) IA -> JSON ao lado do PDF
  try {
    const { arquivoJson } = await analisarPDF(doc.arquivo, contexto);
    arquivos.push(arquivoJson);
    stats.jsonsGerados++;
  } catch (err) {
    registrarErro('analise-pdf', err, { arquivo: path.basename(doc.arquivo) });
  }

  // 2) Upload
  let enviados = 0;
  let uploadOk = true;
  try {
    const resultados = await uploadLote(arquivos, {
      empresa: contrato.empresa,
      cnpjFormatado: contrato.cnpjFormatado,
      ano: doc.ano,
      mes: doc.mes,
    });
    for (const r of resultados) {
      if (r.status === 'enviado' || r.status === 'atualizado') { stats.uploads++; enviados++; }
      else if (r.status === 'ja-existia') { stats.uploadsJaExistiam++; enviados++; }
    }
    if (config.drive.enabled && enviados < arquivos.length) uploadOk = false;
  } catch (err) {
    uploadOk = false;
    registrarErro('upload-drive', err, { arquivo: path.basename(doc.arquivo) });
  }

  // 3) Limpeza — só depois do upload confirmado
  if (config.drive.enabled && uploadOk && config.run.limparAposUpload) {
    for (const arquivo of arquivos) {
      await fsp.unlink(arquivo).catch(() => {});
      stats.arquivosRemovidos++;
    }
    await limparDiretoriosVazios(path.dirname(doc.arquivo), config.paths.downloads);
  }

  // 4) Manifest
  if (!config.drive.enabled || uploadOk) {
    manifest.marcar(chave, {
      cnpj: contrato.cnpjFormatado, tipo: doc.produto, documento: doc.tipo,
      ano: doc.ano, mes: doc.mes, linha: doc.linha, uploadOk,
    });
  }
  await manifest.salvar();
}

// ---------------------------------------------------------------------------
// Processamento de uma empresa (todas as contas: Móvel + Fixo + boleto)
// ---------------------------------------------------------------------------

async function processarContrato(page, contrato, manifest, barra) {
  const inicio = Date.now();
  logger.info(`===== ${contrato.cnpjFormatado} — ${contrato.empresa} =====`);

  await garantirSessao(page);
  await selecionarContrato(page, contrato);

  barra.update({ etapa: `${contrato.cnpjFormatado} — baixando faturas` });

  const resumo = await processarEmpresa(page, contrato, async (doc) => {
    if (doc.tipo === 'Fatura') { stats.faturasEncontradas++; stats.faturasBaixadas++; }
    else stats.boletosBaixados++;
    await finalizarDocumento(doc, contrato, manifest);
  });

  logger.info(
    `----- ${contrato.cnpjFormatado}: ${resumo.faturas} fatura(s), ${resumo.boletos} boleto(s) em ${formatarDuracao(Date.now() - inicio)} -----`
  );
  return resumo;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validate();

  logger.info('='.repeat(70));
  logger.info('Automação Vivo Empresas — início');
  logger.info(
    `Modo: ${config.browser.headless ? 'headless' : 'headed'} | IA: ${config.ia.enabled ? config.ia.provider : 'desabilitada'} | Drive: ${config.drive.enabled ? 'ativo' : 'desabilitado'}`
  );
  logger.info('='.repeat(70));

  await ensureDir(config.paths.downloads);
  const manifest = await new Manifest().carregar();

  if (config.drive.enabled) {
    await verificarConexao();
  }

  const { browser, context, page } = await abrirNavegador();

  // Salva a sessão ao encerrar, mesmo em Ctrl+C.
  const encerrar = async () => {
    await manifest.salvar().catch(() => {});
    await salvarSessao(context).catch(() => {});
    await browser.close().catch(() => {});
  };
  process.on('SIGINT', async () => {
    logger.warn('Interrompido pelo usuário (SIGINT). Salvando estado...');
    await encerrar();
    process.exit(130);
  });

  const multibar = criarProgresso('Contratos');
  let barra = null;

  try {
    await login(page);

    if (config.run.onlyLogin) {
      logger.info('Sessão autenticada e salva. Encerrando (--only-login).');
      return;
    }

    // Modo diagnóstico: dumpa o painel autenticado (onde o login parou) e encerra.
    // NÃO navega — ir para "/" ou para a URL de login derruba a sessão.
    if (config.cli.inspecionar) {
      logger.info(`Modo --inspecionar: dumpando a página atual (${page.url()})`);
      await esperarEstabilizar(page, { timeout: 20000 });
      await dumpDashboard(page, 'dashboard');
      logger.info('Inspeção concluída. Veja logs/inspecao-dashboard.json');
      return;
    }

    const todos = await listarContratos(page);
    const contratos = filtrarContratos(todos);

    stats.contratosTotal = todos.length;
    stats.contratosIgnorados = todos.length - contratos.length;

    logger.info(`${contratos.length} contrato(s) a processar (${stats.contratosIgnorados} ignorado(s)).`);
    if (!contratos.length) {
      logger.warn('Nenhum contrato restante após os filtros. Verifique CNPJ_IGNORAR / CNPJ_SOMENTE.');
      return;
    }

    barra = multibar.create(contratos.length, 0, { etapa: 'iniciando' });

    for (const contrato of contratos) {
      try {
        await processarContrato(page, contrato, manifest, barra);
        stats.contratosProcessados++;
      } catch (err) {
        stats.contratosComErro++;
        const shot = await screenshotErro(page, `contrato-${contrato.cnpj}`);
        registrarErro('contrato', err, {
          cnpj: contrato.cnpjFormatado,
          empresa: contrato.empresa,
          screenshot: shot,
        });
        // Requisito 10: seguir para o próximo CNPJ.
        // Usa baseUrl (SEM logout) para não derrubar a sessão no meio da execução.
        logger.warn(`Seguindo para o próximo CNPJ após falha em ${contrato.cnpjFormatado}.`);
        await page.goto(config.portal.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      } finally {
        barra.increment({ etapa: contrato.cnpjFormatado });
        await manifest.salvar().catch(() => {});
      }
    }
  } finally {
    if (barra) multibar.stop();
    await encerrar();
    relatorioFinal();
  }
}

function relatorioFinal() {
  const duracaoMs = Date.now() - stats.inicio;
  const resumo = { ...stats, duracao: formatarDuracao(duracaoMs), duracaoMs };
  delete resumo.inicio;

  logger.info('='.repeat(70));
  logger.info('RESUMO DA EXECUÇÃO');
  logger.info(`  Tempo total ............ ${resumo.duracao}`);
  logger.info(`  Contratos encontrados .. ${stats.contratosTotal}`);
  logger.info(`  Contratos processados .. ${stats.contratosProcessados}`);
  logger.info(`  Contratos ignorados .... ${stats.contratosIgnorados}`);
  logger.info(`  Contratos com erro ..... ${stats.contratosComErro}`);
  logger.info(`  Faturas encontradas .... ${stats.faturasEncontradas}`);
  logger.info(`  Faturas baixadas ....... ${stats.faturasBaixadas}`);
  logger.info(`  Boletos baixados ....... ${stats.boletosBaixados}`);
  logger.info(`  Boletos indisponíveis .. ${stats.boletosAusentes}`);
  logger.info(`  JSONs gerados .......... ${stats.jsonsGerados}`);
  logger.info(`  Uploads (novos) ........ ${stats.uploads}`);
  logger.info(`  Uploads já existentes .. ${stats.uploadsJaExistiam}`);
  logger.info(`  Pulados (já feitos) .... ${stats.puladosPorManifest}`);
  logger.info(`  Arquivos removidos ..... ${stats.arquivosRemovidos}`);
  logger.info(`  Erros registrados ...... ${stats.erros.length}`);
  logger.info('='.repeat(70));

  const arquivo = salvarRelatorio(resumo);
  logger.info(`Relatório detalhado: ${arquivo}`);
}

main()
  .then(() => {
    process.exitCode = stats.erros.length ? 1 : 0;
  })
  .catch(async (err) => {
    registrarErro('fatal', err);
    logger.error('Execução abortada.');
    process.exitCode = 2;
  });
