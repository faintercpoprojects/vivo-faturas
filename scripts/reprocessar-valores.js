'use strict';
// Reextrai o valor (TOTAL A PAGAR) e demais campos dos PDFs já baixados e
// atualiza o banco — sem novo acesso ao portal. Corrige valores de subtotal.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { extrairCamposFatura } = require('../src/extrairCampos');

const RAIZ = path.resolve(__dirname, '..', 'downloads');
const DB = path.resolve(__dirname, '..', '.state', 'contas.db');

function hash(cnpj, produto, linha, comp) {
  return crypto.createHash('sha1').update(`${cnpj}|${produto}|${linha}|${comp}`).digest('hex');
}
function pdfs(dir) {
  let o = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const s = fs.statSync(p);
    if (s.isDirectory()) o.push(...pdfs(p));
    else if (/^Fatura.*\.pdf$/i.test(n)) o.push(p);
  }
  return o;
}

(async () => {
  const db = new DatabaseSync(DB);
  let n = 0;
  for (const f of pdfs(RAIZ)) {
    const rel = path.relative(RAIZ, f).split(path.sep);
    const cnpjPasta = rel[0], ano = rel[1], mes = rel[2];
    const cnpj = cnpjPasta.replace(/^(\d{2})\.(\d{3})\.(\d{3})-(\d{4})-(\d{2})$/, '$1.$2.$3/$4-$5');
    const nome = path.basename(f, '.pdf');
    const linha = (nome.match(/(\d{6,})/) || [])[1];
    const produto = /fixo/i.test(nome) ? 'Fixo' : 'Movel';
    const comp = `${mes}/${ano}`;
    const c = await extrairCamposFatura(f);
    const h = hash(cnpj, produto, linha, comp);
    const r = db.prepare(
      'UPDATE contas SET valor_original=COALESCE(?,valor_original), numero_documento=COALESCE(?,numero_documento), data_vencimento=COALESCE(?,data_vencimento), data_emissao=COALESCE(?,data_emissao), updated_at=? WHERE hash_dedup=?'
    ).run(c.valor, c.numeroDocumento, c.dataVencimento, c.dataEmissao, new Date().toISOString(), h);
    console.log(cnpj, produto, linha, comp, '-> R$', c.valor, r.changes ? '(atualizado)' : '(sem match)');
    if (r.changes) n++;
  }
  console.log('\nAtualizados:', n);
})();
