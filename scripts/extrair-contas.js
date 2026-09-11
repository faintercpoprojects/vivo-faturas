#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const RAIZ = process.argv[2] || 'C:/Users/Luiz/Desktop/faturas vivo 09-26';

function listarPdfs(dir) {
  const out = [];
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listarPdfs(p));
    else if (/\.pdf$/i.test(nome)) out.push(p);
  }
  return out;
}

const num = (s) => {
  if (!s) return null;
  return s.replace(/\./g, '').replace(',', '.');
};

async function extrair(file) {
  const rel = path.relative(RAIZ, file).replace(/\\/g, '/');
  const partes = rel.split('/'); // CNPJ/ANO/MES/arquivo.pdf
  const cnpjPasta = partes[0];
  const anoPasta = partes[1];
  const mesPasta = partes[2];
  const nome = path.basename(file, '.pdf');
  const tipo = /^Boleto/i.test(nome) ? 'Boleto' : 'Fatura';
  const linhaM = nome.match(/(\d{6,})/);
  const linha = linhaM ? linhaM[1] : null;

  let texto = '';
  try {
    const d = await pdfParse(fs.readFileSync(file), { max: 0 });
    texto = String(d.text || '').replace(/\u00a0/g, ' ').replace(/[ \t]{2,}/g, ' ');
  } catch (e) {
    texto = '';
  }
  const flat = texto.replace(/\s+/g, ' ');

  // vencimento
  const venc = (flat.match(/vencimento[^0-9]{0,25}(\d{2}\/\d{2}\/\d{4})/i) || [])[1]
    || (flat.match(/vencto[^0-9]{0,15}(\d{2}\/\d{2}\/\d{4})/i) || [])[1]
    || (flat.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1] || null;

  // emissao
  const emissao = (flat.match(/emiss[aã]o[^0-9]{0,20}(\d{2}\/\d{2}\/\d{4})/i) || [])[1]
    || (flat.match(/data\s+de\s+emiss[aã]o[^0-9]{0,20}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;

  // valor total
  const valor = num((flat.match(/total\s*(?:a\s*pagar|da\s*fatura)?[^0-9\-]{0,25}(\d{1,3}(?:\.\d{3})*,\d{2})/i) || [])[1])
    || num((flat.match(/valor\s*(?:do\s*documento|total|cobrado)?[^0-9\-]{0,25}(\d{1,3}(?:\.\d{3})*,\d{2})/i) || [])[1])
    || num((flat.match(/R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/) || [])[1]) || null;

  // numero do documento / fatura / nota
  const numDoc = (flat.match(/(?:n[ºo\.]?\s*(?:da\s*)?(?:fatura|documento|nota\s*fiscal|nf-?e?)|documento\s*n[ºo])[^0-9]{0,12}(\d[\d.\-\/]{4,})/i) || [])[1] || null;

  // indicios de pagamento (raro na fatura, mas registramos)
  const indicioPago = /\b(fatura\s+paga|pagamento\s+(confirmad|efetuad|realizad)|conta\s+paga|situa[cç][aã]o[^\.]{0,15}pag[oa])\b/i.test(flat);

  // linha digitavel do boleto
  const linhaDigitavel = (flat.match(/(\d{5}\.?\d{5}\s+\d{5}\.?\d{6}\s+\d{5}\.?\d{6}\s+\d\s+\d{14})/) || [])[1]
    || (flat.match(/(\d{47,48})/) || [])[1] || null;

  // razao social do cliente (heuristico) - fica melhor via CNPJ conhecido
  const empresa = cnpjPasta.startsWith('40.524.182') ? 'UNICPO LTDA'
    : cnpjPasta.startsWith('68.165.786') ? 'CPO BAURU - CENTRO DE PESQUISA OROFACIAL LTDA'
    : cnpjPasta.startsWith('11.664.569') ? 'CTODONTO CENTRO DE TRATAMENTO ODONTOLOGICO LTDA'
    : 'Nao informado';

  return {
    arquivo: rel,
    tipo,
    fornecedor: 'Telefonica Brasil S.A. (Vivo)',
    empresaCliente: empresa,
    cnpjCliente: cnpjPasta.replace(/-(\d{2})$/, '-$1'),
    linha,
    competencia: `${mesPasta}/${anoPasta}`,
    numeroDocumento: numDoc || 'Nao informado',
    emissao: emissao || 'Nao informado',
    vencimento: venc || 'Nao informado',
    valor: valor || 'Nao informado',
    linhaDigitavel: tipo === 'Boleto' ? (linhaDigitavel || 'Nao informado') : null,
    indicioPagoNoPdf: indicioPago,
    chars: flat.length,
  };
}

(async () => {
  const pdfs = listarPdfs(RAIZ).sort();
  const dados = [];
  for (const f of pdfs) dados.push(await extrair(f));
  fs.writeFileSync(path.join(__dirname, '..', 'logs', 'contas-extraidas.json'), JSON.stringify(dados, null, 2), 'utf8');
  for (const d of dados) {
    console.log(`${d.tipo}\t${d.cnpjCliente}\tlinha ${d.linha}\tcomp ${d.competencia}\tvenc ${d.vencimento}\tR$ ${d.valor}\tdoc ${d.numeroDocumento}\temiss ${d.emissao}\tpagoPdf:${d.indicioPagoNoPdf}`);
  }
  console.log('\nTotal PDFs:', dados.length);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
