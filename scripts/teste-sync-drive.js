'use strict';
// Teste da sincronização com o Drive usando um Drive SIMULADO (nada vai para o Google).
//   node scripts/teste-sync-drive.js
const path = require('path');
const fs = require('fs');
const os = require('os');

// Drive falso em memória.
const pastas = new Map();   // id -> { nome, pai }
const arquivos = [];        // { id, nome, pasta }
let seq = 0;
const falso = {
  verificarConexao: async () => ({ ok: true }),
  garantirArvore: async ({ empresa, cnpjFormatado, ano, mes }) => {
    let pai = 'raiz';
    for (const nome of [empresa, cnpjFormatado, String(ano), `${String(mes).padStart(2, '0')}`]) {
      let id = [...pastas].find(([, p]) => p.nome === nome && p.pai === pai)?.[0];
      if (!id) { id = `p${++seq}`; pastas.set(id, { nome, pai }); }
      pai = id;
    }
    return pai;
  },
  buscarArquivo: async (nome, pastaId) => arquivos.find((a) => a.nome === nome && a.pasta === pastaId) || null,
  enviarArquivo: async (arq, pastaId) => { const a = { id: `f${++seq}`, nome: path.basename(arq), pasta: pastaId }; arquivos.push(a); return { id: a.id, status: 'enviado' }; },
};
require.cache[require.resolve('../src/uploadDrive')] = { id: 'x', filename: 'x', loaded: true, exports: falso };

// Registro local isolado (não mexe no real).
const { config } = require('../src/config');
config.paths.state = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-teste-'));
const { sincronizarDrive } = require('../src/syncDrive');

let falhas = 0;
const ok = (c, n) => { console.log(`${c ? 'OK    ' : 'FALHOU'} ${n}`); if (!c) falhas++; };
const caminho = (id) => { const p = []; while (id && id !== 'raiz') { const x = pastas.get(id); p.unshift(x.nome); id = x.pai; } return p.join(' / '); };

(async () => {
  const dbFile = path.resolve(__dirname, '..', '.state', 'contas.db');
  // Simula um arquivo que já estava no Drive antes (subido à mão).
  const { DatabaseSync } = require('node:sqlite');
  const algum = new DatabaseSync(dbFile, { readOnly: true }).prepare("SELECT * FROM contas WHERE pdf_path IS NOT NULL LIMIT 1").get();
  if (algum && fs.existsSync(algum.pdf_path)) {
    const { nomesPorCnpj, anoMes } = require('../src/syncDrive');
    const todas = new DatabaseSync(dbFile, { readOnly: true }).prepare('SELECT * FROM contas').all();
    const { ano, mes } = anoMes(algum);
    const pasta = await falso.garantirArvore({ empresa: nomesPorCnpj(todas).get(algum.cnpj) || algum.empresa, cnpjFormatado: algum.cnpj, ano, mes });
    arquivos.push({ id: 'manual', nome: path.basename(algum.pdf_path), pasta });
  }
  const antes = arquivos.length;

  const r1 = await sincronizarDrive({ dbFile, log: () => {} });
  console.log(`       1ª execução: ${r1.enviados} enviado(s), ${r1.jaExistiam} já existia(m), ${r1.falhas} falha(s), ${r1.total} PDF(s)`);
  ok(r1.total > 0 && r1.falhas === 0, 'todos os PDFs conferidos sem falha');
  ok(r1.jaExistiam >= antes && r1.enviados + r1.jaExistiam === r1.total, 'arquivo que já estava no Drive foi ignorado (não duplicou)');
  const nomes = arquivos.map((a) => `${caminho(a.pasta)} / ${a.nome}`);
  ok(new Set(nomes).size === nomes.length, 'nenhum arquivo duplicado na mesma pasta');
  ok(nomes.some((n) => /AONet/i.test(n)) && nomes.some((n) => /Vero/i.test(n)), 'PDFs das outras operadoras (AONet, Vero) também foram');
  ok(!nomes.some((n) => /^R\. Dorival|^AONET PME|^HERMINIO/i.test(n)), 'pastas usam o nome da empresa, não o endereço do contrato');

  const qtd = arquivos.length;
  const r2 = await sincronizarDrive({ dbFile, log: () => {} });
  ok(r2.enviados === 0 && arquivos.length === qtd, '2ª execução: nada é reenviado');

  console.log('\nExemplos de onde os arquivos ficaram:');
  [...new Set(nomes)].filter((n, i, a) => i < 3 || /AONet|Vero/.test(n)).slice(0, 6).forEach((n) => console.log('   ' + n));
  fs.rmSync(config.paths.state, { recursive: true, force: true });
  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
