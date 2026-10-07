'use strict';
// Teste da sincronização com o Drive usando um Drive SIMULADO (nada vai para o Google).
//   node scripts/teste-sync-drive.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Drive falso em memória: pastas na raiz + arquivos com MD5.
const pastas = new Map([['raiz', { nome: 'Contas Telefonia', pai: null }]]);
const arquivos = []; // { id, nome, pasta, md5 }
let seq = 0;
const md5Arq = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const falso = {
  verificarConexao: async () => ({ ok: true }),
  garantirPasta: async (nome, pai) => {
    let id = [...pastas].find(([, p]) => p.nome === nome && p.pai === pai)?.[0];
    if (!id) { id = `p${++seq}`; pastas.set(id, { nome, pai }); }
    return id;
  },
  buscarArquivo: async (nome, pastaId) => arquivos.find((a) => a.nome === nome && a.pasta === pastaId) || null,
  enviarArquivo: async (arq, pastaId) => { const a = { id: `f${++seq}`, nome: path.basename(arq), pasta: pastaId, md5: md5Arq(arq) }; arquivos.push(a); return { id: a.id, status: 'enviado' }; },
  drive: () => ({ files: { list: async ({ q }) => {
    const pai = q.match(/'([^']+)' in parents/)[1];
    const subpastas = [...pastas].filter(([, p]) => p.pai === pai).map(([id, p]) => ({ id, name: p.nome, mimeType: 'application/vnd.google-apps.folder' }));
    const arqs = arquivos.filter((a) => a.pasta === pai).map((a) => ({ id: a.id, name: a.nome, md5Checksum: a.md5 }));
    return { data: { files: [...subpastas, ...arqs] } };
  } } }),
};
require.cache[require.resolve('../src/uploadDrive')] = { id: 'x', filename: 'x', loaded: true, exports: falso };

const { config } = require('../src/config');
config.drive.rootFolderId = 'raiz';
config.paths.state = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-teste-')); // registro local isolado
const { sincronizarDrive, anoMes, nomePastaMes } = require('../src/syncDrive');

let falhas = 0;
const ok = (c, n) => { console.log(`${c ? 'OK    ' : 'FALHOU'} ${n}`); if (!c) falhas++; };
const nomePasta = (id) => pastas.get(id).nome;

(async () => {
  const dbFile = path.resolve(__dirname, '..', '.state', 'contas.db');
  const contas = new DatabaseSync(dbFile, { readOnly: true }).prepare('SELECT * FROM contas').all();
  // Simula o financeiro: um PDF já está no Drive, numa pasta manual e com OUTRO nome.
  const manual = contas.find((c) => c.pdf_path && fs.existsSync(c.pdf_path));
  const pastaManual = await falso.garantirPasta('Setembro - 2026', 'raiz');
  arquivos.push({ id: 'manual', nome: 'documento-baixado-a-mao.PDF', pasta: pastaManual, md5: md5Arq(manual.pdf_path) });

  const r1 = await sincronizarDrive({ dbFile, log: () => {} });
  console.log(`       1ª execução: ${r1.enviados} enviado(s), ${r1.jaExistiam} já existia(m), ${r1.falhas} falha(s), ${r1.total} PDF(s)`);
  ok(r1.total > 0 && r1.falhas === 0, 'todos os PDFs conferidos sem falha');
  ok(!arquivos.some((a) => a.id !== 'manual' && a.md5 === md5Arq(manual.pdf_path)), 'PDF que já estava no Drive com OUTRO nome não foi reenviado');
  const md5s = arquivos.map((a) => a.md5);
  ok(new Set(md5s).size === md5s.length, 'nenhum conteúdo duplicado no Drive');
  ok(arquivos.every((a) => /^(Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro) - \d{4}$/.test(nomePasta(a.pasta))), 'todos os arquivos em pastas "Mês - Ano"');
  ok([...pastas.values()].every((p) => p.pai === null || p.pai === 'raiz'), 'pastas de mês direto na raiz (sem Empresa/CNPJ)');
  const vero = contas.find((c) => /vero/i.test(c.produto || '') && c.boleto_pdf_path && fs.existsSync(c.boleto_pdf_path));
  if (vero) {
    const a = arquivos.find((x) => x.nome === path.basename(vero.boleto_pdf_path));
    ok(a && nomePasta(a.pasta) === nomePastaMes(anoMes(vero)) && /^Outubro - 2026$/.test(nomePasta(a.pasta)), `pasta pelo mês do VENCIMENTO (Vero venc. ${vero.data_vencimento} -> ${a && nomePasta(a.pasta)})`);
  }
  const qtd = arquivos.length;
  const r2 = await sincronizarDrive({ dbFile, log: () => {} });
  ok(r2.enviados === 0 && arquivos.length === qtd, '2ª execução: nada é reenviado');

  fs.rmSync(config.paths.state, { recursive: true, force: true });
  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
