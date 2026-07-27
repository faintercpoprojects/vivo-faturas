'use strict';

const fsp = require('fs/promises');
const path = require('path');
const pdfParse = require('pdf-parse');

const { config } = require('./config');
const { logger } = require('./logger');
const {
  retry,
  formatarCNPJ,
  extrairCNPJ,
  normalizarValor,
  parseCompetencia,
  pad2,
  ensureDir,
} = require('./utils');

// Clientes criados sob demanda (evita exigir chave quando --no-ia).
let anthropic = null;
let openai = null;

// Quando a IA falha por saldo/quota/autenticacao, nao adianta insistir a cada
// fatura: desliga a IA para o resto da execucao e segue na extracao local.
let iaDesativada = false;
let motivoDesativacao = null;

/** Erros de billing/auth/rate são permanentes no escopo da execução. */
function ehFalhaPermanenteIA(err) {
  const status = err && (err.status || err.statusCode);
  const tipo = (err && err.error && err.error.type) || '';
  const msg = String((err && err.message) || '').toLowerCase();
  if ([401, 403].includes(status)) return true; // chave inválida / sem permissão
  if (status === 429 && /quota|insufficient/i.test(tipo + msg)) return true; // sem saldo
  if (status === 400 && /credit balance|billing|quota/i.test(msg)) return true; // Anthropic sem crédito
  return false;
}

function clienteAnthropic() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: config.ia.anthropicKey, maxRetries: 0 });
  }
  return anthropic;
}

function clienteOpenAI() {
  if (!openai) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: config.ia.openaiKey, maxRetries: 0 });
  }
  return openai;
}

const CAMPOS = [
  'cnpj',
  'empresa',
  'tipo',
  'competencia',
  'vencimento',
  'valor',
  'linha',
  'observacoes',
  'resumo',
];

const PROMPT_SISTEMA = `Você extrai dados estruturados de faturas de telecomunicações da Vivo (Telefônica Brasil).
Responda SEMPRE e SOMENTE com um objeto JSON válido, sem markdown, sem crases, sem texto antes ou depois.

Esquema obrigatório (todas as chaves sempre presentes; use "" quando não encontrar):
{
  "cnpj": "CNPJ do cliente no formato 00.000.000/0000-00",
  "empresa": "razão social do cliente",
  "tipo": "Movel ou Fixo",
  "competencia": "MM/AAAA do mês de referência",
  "vencimento": "DD/MM/AAAA",
  "valor": "valor total a pagar, apenas números com ponto decimal, ex: 1234.56",
  "linha": "número da linha/telefone ou identificador do contrato; se houver várias, a principal",
  "observacoes": "avisos relevantes: multas, juros, serviços adicionais, mudança de plano, débito automático, fatura em atraso",
  "resumo": "resumo objetivo da fatura em até 3 frases"
}

Regras:
- Não invente dados. Se a informação não estiver no texto, use "".
- "tipo" deve ser exatamente "Movel" ou "Fixo" (sem acento).
- Não inclua o símbolo R$ em "valor".`;

/**
 * Extrai o texto de um PDF.
 * @returns {Promise<{texto: string, paginas: number}>}
 */
async function extrairTexto(arquivo) {
  const buffer = await fsp.readFile(arquivo);
  const dados = await pdfParse(buffer, { max: 0 });
  const texto = String(dados.text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { texto, paginas: dados.numpages || 0 };
}

/** Reduz o texto ao que interessa, respeitando o limite de tokens. */
function prepararTexto(texto) {
  const limite = config.ia.maxChars;
  if (texto.length <= limite) return texto;
  // Cabeçalho e rodapé concentram totais, vencimento e dados cadastrais.
  const cabeca = texto.slice(0, Math.floor(limite * 0.7));
  const cauda = texto.slice(-Math.floor(limite * 0.3));
  return `${cabeca}\n\n[...TRECHO INTERMEDIÁRIO OMITIDO...]\n\n${cauda}`;
}

/** Extrai o primeiro objeto JSON de uma resposta possivelmente suja. */
function extrairJSON(resposta) {
  const texto = String(resposta || '').trim();
  const semCerca = texto.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(semCerca);
  } catch {
    /* tenta recortar */
  }
  const inicio = semCerca.indexOf('{');
  const fim = semCerca.lastIndexOf('}');
  if (inicio >= 0 && fim > inicio) {
    return JSON.parse(semCerca.slice(inicio, fim + 1));
  }
  throw new Error(`Resposta da IA não contém JSON válido: ${texto.slice(0, 300)}`);
}

async function chamarAnthropic(texto, contexto) {
  const resp = await clienteAnthropic().messages.create({
    model: config.ia.anthropicModel,
    max_tokens: 1500,
    system: PROMPT_SISTEMA,
    messages: [
      {
        role: 'user',
        content:
          `Contexto conhecido (use para validar, o texto da fatura tem prioridade):\n` +
          `${JSON.stringify(contexto)}\n\n` +
          `Texto extraído do PDF:\n"""\n${texto}\n"""`,
      },
      { role: 'assistant', content: '{' },
    ],
  });
  const bruto = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return extrairJSON('{' + bruto);
}

async function chamarOpenAI(texto, contexto) {
  const resp = await clienteOpenAI().chat.completions.create({
    model: config.ia.openaiModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PROMPT_SISTEMA },
      {
        role: 'user',
        content:
          `Contexto conhecido (use para validar, o texto da fatura tem prioridade):\n` +
          `${JSON.stringify(contexto)}\n\n` +
          `Texto extraído do PDF:\n"""\n${texto}\n"""`,
      },
    ],
  });
  return extrairJSON(resp.choices[0].message.content);
}

/**
 * Extração puramente local, usada quando a IA está desabilitada ou falha.
 * Garante que sempre exista um JSON ao lado do PDF.
 */
function extrairPorRegex(texto, contexto) {
  // O CNPJ do contexto é autoritativo (sabemos de qual empresa é o download).
  // O texto do PDF contém CNPJ da Telefônica, códigos de barras etc. que
  // confundiriam a extração por regex.
  const cnpj = contexto.cnpj || extrairCNPJ(texto) || '';
  const venc = (texto.match(/vencimento[^\d]{0,40}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    (texto.match(/\d{2}\/\d{2}\/\d{4}/) || [])[0] || contexto.vencimento || '';
  const valor =
    normalizarValor((texto.match(/total\s*(?:a\s*pagar|da\s*fatura)?[^\d]{0,30}([\d.]+,\d{2})/i) || [])[1]) ||
    contexto.valor || '';
  const linha = (texto.match(/\(?\d{2}\)?\s?9?\d{4}-?\d{4}/) || [])[0] || contexto.linha || '';
  const comp = parseCompetencia(texto.match(/(?:refer[êe]ncia|compet[êe]ncia)[^\n]{0,30}/i)?.[0] || '') ||
    (contexto.ano ? { ano: contexto.ano, mes: contexto.mes } : null);

  return {
    cnpj: cnpj ? formatarCNPJ(cnpj) : '',
    empresa: contexto.empresa || '',
    tipo: contexto.tipo || '',
    competencia: comp ? `${pad2(comp.mes)}/${comp.ano}` : '',
    vencimento: venc,
    valor: valor || '',
    linha,
    observacoes: 'Extração local por expressões regulares (IA indisponível).',
    resumo: '',
  };
}

/** Normaliza e completa o objeto devolvido pela IA. */
function normalizar(bruto, contexto) {
  const out = {};
  for (const campo of CAMPOS) out[campo] = bruto && bruto[campo] != null ? String(bruto[campo]).trim() : '';

  if (out.cnpj) {
    const d = extrairCNPJ(out.cnpj);
    out.cnpj = d ? formatarCNPJ(d) : out.cnpj;
  }
  if (!out.cnpj && contexto.cnpj) out.cnpj = formatarCNPJ(contexto.cnpj);
  if (!out.empresa && contexto.empresa) out.empresa = contexto.empresa;

  const tipoNorm = out.tipo.toLowerCase();
  out.tipo = tipoNorm.startsWith('mov') || tipoNorm.startsWith('móv') ? 'Movel'
    : tipoNorm.startsWith('fix') ? 'Fixo'
    : contexto.tipo || '';

  if (!out.competencia && contexto.ano) out.competencia = `${pad2(contexto.mes)}/${contexto.ano}`;
  if (out.valor) out.valor = normalizarValor(out.valor) || out.valor;

  return out;
}

/**
 * Analisa um PDF já baixado e grava o JSON ao lado dele.
 *
 * @param {string} arquivoPdf
 * @param {{cnpj:string, empresa:string, tipo:'Movel'|'Fixo', ano:number, mes:number,
 *          vencimento?:string, valor?:string, linha?:string, documento:'Fatura'|'Boleto'}} contexto
 * @returns {Promise<{json: object, arquivoJson: string, fonte: 'ia'|'regex'}>}
 */
async function analisarPDF(arquivoPdf, contexto) {
  const arquivoJson = arquivoPdf.replace(/\.pdf$/i, '.json');
  await ensureDir(path.dirname(arquivoJson));

  const { texto, paginas } = await extrairTexto(arquivoPdf);
  if (!texto || texto.length < 40) {
    logger.warn(`PDF sem texto extraível (provavelmente digitalizado): ${path.basename(arquivoPdf)}`);
  }

  let json;
  let fonte = 'regex';

  if (config.ia.enabled && !iaDesativada && texto.length >= 40) {
    try {
      const preparado = prepararTexto(texto);
      const bruto = await retry(
        () =>
          config.ia.provider === 'openai'
            ? chamarOpenAI(preparado, contexto)
            : chamarAnthropic(preparado, contexto),
        {
          descricao: `análise IA de ${path.basename(arquivoPdf)}`,
          tentativas: config.run.maxRetries,
          // Não re-tenta erros de saldo/quota/autenticação.
          naoRetentarSe: ehFalhaPermanenteIA,
        }
      );
      json = normalizar(bruto, contexto);
      fonte = 'ia';
    } catch (err) {
      if (ehFalhaPermanenteIA(err)) {
        iaDesativada = true;
        motivoDesativacao = err.message;
        logger.error(
          `IA desativada para o restante da execução (${err.status || ''} ${err.message.slice(0, 120)}). ` +
            'Seguindo com extração local em todas as próximas faturas.'
        );
      } else {
        logger.error(`IA falhou para ${path.basename(arquivoPdf)}: ${err.message}. Usando extração local.`);
      }
      json = normalizar(extrairPorRegex(texto, contexto), contexto);
    }
  } else {
    json = normalizar(extrairPorRegex(texto, contexto), contexto);
  }

  // Metadados de rastreabilidade ficam fora do esquema pedido, em _meta.
  const saida = {
    ...json,
    _meta: {
      arquivo: path.basename(arquivoPdf),
      documento: contexto.documento,
      paginas,
      caracteresExtraidos: texto.length,
      fonte,
      provider: fonte === 'ia' ? config.ia.provider : null,
      modelo: fonte === 'ia'
        ? (config.ia.provider === 'openai' ? config.ia.openaiModel : config.ia.anthropicModel)
        : null,
      analisadoEm: new Date().toISOString(),
    },
  };

  await fsp.writeFile(arquivoJson, JSON.stringify(saida, null, 2), 'utf8');
  logger.info(`JSON gerado (${fonte}): ${path.basename(arquivoJson)}`);

  return { json: saida, arquivoJson, fonte };
}

module.exports = { analisarPDF, extrairTexto, extrairJSON, normalizar, CAMPOS };
