'use strict';
/**
 * Arruma no Drive os PDFs enviados pela automação para a estrutura antiga
 * (Empresa/CNPJ/Ano/Mês), deixando tudo no padrão do financeiro ("Outubro - 2026"):
 *   - PDF que já existe com o mesmo conteúdo nas pastas manuais -> LIXEIRA (recuperável 30 dias)
 *   - PDF único -> MOVIDO para a pasta "<Mês> - <Ano>" (mês do vencimento)
 *   - pastas da estrutura antiga criadas pela automação e que ficaram vazias -> LIXEIRA
 * Só mexe em arquivos que a automação enviou (registrados em .state/drive-enviados.json).
 *
 *   node scripts/reorganizar-drive.js --simular     mostra o plano, não altera nada
 *   node scripts/reorganizar-drive.js --executar    executa
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../src/config');
const drv = require('../src/uploadDrive');
const { md5 } = require('../src/utils');
const { anoMes, nomePastaMes, lerRegistro, gravarRegistro } = require('../src/syncDrive');

const executar = process.argv.includes('--executar');
const PASTA = 'application/vnd.google-apps.folder';

(async () => {
  const d = drv.drive();
  const raiz = config.drive.rootFolderId;
  await drv.verificarConexao();

  // Árvore completa (arquivos e pastas) sob a raiz.
  const itens = [];
  const visitar = async (id, caminho) => {
    let pageToken;
    do {
      const r = await d.files.list({ q: `'${id}' in parents and trashed=false`, fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,createdTime)', pageSize: 200, pageToken });
      for (const f of r.data.files) {
        const it = { ...f, pai: id, caminho: `${caminho}/${f.name}` };
        itens.push(it);
        if (f.mimeType === PASTA) await visitar(f.id, it.caminho);
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  };
  await visitar(raiz, '');

  const registro = lerRegistro();
  const enviadosPorId = new Map(Object.entries(registro).filter(([, v]) => !v.origem).map(([h, v]) => [v.id, h]));
  const meus = itens.filter((f) => f.mimeType !== PASTA && enviadosPorId.has(f.id));

  // Conta de cada PDF (pelo MD5 do arquivo local) para saber o mês do vencimento.
  const contas = new DatabaseSync(path.join(config.paths.state, 'contas.db'), { readOnly: true }).prepare('SELECT * FROM contas').all();
  const contaPorMd5 = new Map();
  for (const c of contas) for (const a of [c.pdf_path, c.boleto_pdf_path]) if (a && fs.existsSync(a)) contaPorMd5.set(await md5(a), c);

  const plano = [];
  for (const f of meus) {
    const dup = itens.find((o) => o.id !== f.id && o.mimeType !== PASTA && o.md5Checksum === f.md5Checksum && !enviadosPorId.has(o.id));
    if (dup) { plano.push({ acao: 'lixeira', f, motivo: `igual a ${dup.caminho.slice(1)}` }); continue; }
    const c = contaPorMd5.get(f.md5Checksum);
    const destino = nomePastaMes(c ? anoMes(c) : { ano: 2026, mes: 10 });
    plano.push({ acao: 'mover', f, destino });
  }

  console.log(`${meus.length} PDF(s) enviados pela automação no Drive:`);
  for (const p of plano) console.log(p.acao === 'lixeira' ? `  LIXEIRA  ${p.f.caminho.slice(1)}  (${p.motivo})` : `  MOVER    ${p.f.caminho.slice(1)}  ->  ${p.destino}/`);

  if (!executar) { console.log('\n(simulação: nada foi alterado — rode com --executar)'); return; }

  const pastas = new Map();
  for (const p of plano) {
    if (p.acao === 'lixeira') {
      await d.files.update({ fileId: p.f.id, requestBody: { trashed: true } });
      const h = enviadosPorId.get(p.f.id);
      const dup = itens.find((o) => o.id !== p.f.id && o.md5Checksum === p.f.md5Checksum && !enviadosPorId.has(o.id));
      registro[h] = { id: dup.id, nome: dup.name, pasta: path.dirname(dup.caminho).slice(1), em: new Date().toISOString(), origem: 'ja-existia-no-drive' };
    } else {
      if (!pastas.has(p.destino)) pastas.set(p.destino, await drv.garantirPasta(p.destino, raiz));
      await d.files.update({ fileId: p.f.id, addParents: pastas.get(p.destino), removeParents: p.f.pai, fields: 'id' });
      registro[enviadosPorId.get(p.f.id)].pasta = p.destino;
    }
    gravarRegistro(registro);
  }

  // Pastas da estrutura antiga (Empresa/CNPJ/Ano/MM - Mês) que ficaram vazias.
  const vazia = async (id) => {
    const r = await d.files.list({ q: `'${id}' in parents and trashed=false`, fields: 'files(id,mimeType)', pageSize: 50 });
    for (const f of r.data.files) { if (f.mimeType !== PASTA || !(await vazia(f.id))) return false; }
    return true;
  };
  const antigas = itens.filter((f) => f.mimeType === PASTA && f.pai === raiz && !/^(Janeiro|Fevereiro|Março|Marco|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro) - \d{4}$/.test(f.name));
  for (const p of antigas) {
    if (await vazia(p.id)) { await d.files.update({ fileId: p.id, requestBody: { trashed: true } }); console.log(`  LIXEIRA  pasta vazia ${p.name}/`); }
    else console.log(`  mantida  pasta ${p.name}/ (tem arquivos que não foram enviados pela automação)`);
  }
  console.log('\nConcluído.');
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
