'use strict';
/**
 * Confere a pasta de um mês no Drive (ex.: "Outubro - 2026") contra as contas
 * desse mês (pelo vencimento):
 *   1) conta que não está na pasta (nem em outra pasta do Drive) -> sobe o BOLETO
 *      (ou a fatura, se a conta não tem boleto);
 *   2) conta com BOLETO e FATURA na pasta -> manda a FATURA para a lixeira
 *      (recuperável por 30 dias), para não parecer duplicidade.
 * Só mexe em arquivos que reconhece como de uma conta do sistema (pelo
 * conteúdo/MD5 ou pelo nº da linha/documento no nome). O resto fica como está.
 *
 *   node scripts/conferir-drive-mes.js --mes 2026-10            (simulação)
 *   node scripts/conferir-drive-mes.js --mes 2026-10 --executar
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../src/config');
const drv = require('../src/uploadDrive');
const { md5 } = require('../src/utils');
const { anoMes, nomePastaMes, documentoDaConta, md5sNoDrive, lerRegistro, gravarRegistro } = require('../src/syncDrive');

const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const executar = process.argv.includes('--executar');
const MES = arg('--mes') || new Date().toISOString().slice(0, 7);
const PASTA = 'application/vnd.google-apps.folder';
const digitos = (s) => (String(s || '').match(/\d{8,}/g) || []);

(async () => {
  await drv.verificarConexao();
  const d = drv.drive();
  const raiz = config.drive.rootFolderId;
  const [ano, mes] = MES.split('-').map(Number);
  const nomePasta = nomePastaMes({ ano, mes });

  const contas = new DatabaseSync(path.join(config.paths.state, 'contas.db'), { readOnly: true })
    .prepare('SELECT * FROM contas WHERE data_vencimento LIKE ?').all(`${MES}-%`);

  // Arquivos da pasta do mês.
  const pastaId = await drv.garantirPasta(nomePasta, raiz);
  const naPasta = [];
  let pageToken;
  do {
    const r = await d.files.list({ q: `'${pastaId}' in parents and trashed=false`, fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,createdTime)', pageSize: 200, pageToken });
    naPasta.push(...r.data.files.filter((f) => f.mimeType !== PASTA));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  const noDrive = await md5sNoDrive(raiz);

  const tipoPorNome = (n) => (/boleto|gvtinv/i.test(n) ? 'boleto' : /fatura|document-|conta.?detalhada|nota.?fiscal/i.test(n) ? 'fatura' : null);
  const plano = [];
  const relatorio = [];

  for (const c of contas) {
    const docs = {
      boleto: c.boleto_pdf_path && fs.existsSync(c.boleto_pdf_path) ? { arq: c.boleto_pdf_path, md5: await md5(c.boleto_pdf_path) } : null,
      fatura: c.pdf_path && fs.existsSync(c.pdf_path) ? { arq: c.pdf_path, md5: await md5(c.pdf_path) } : null,
    };
    const chaves = new Set([...digitos(c.linha), ...digitos(c.numero_documento)].map((x) => x.replace(/^0+/, '')));
    // Arquivos da pasta que são desta conta: pelo conteúdo, pelo nome que a
    // automação usa (o PDF pode ser baixado de novo e mudar os bytes) ou pelo
    // nº da linha/documento no nome.
    const nomesLocais = new Set([docs.boleto, docs.fatura].filter(Boolean).map((x) => path.basename(x.arq).toLowerCase()));
    const meus = naPasta.filter((f) =>
      (docs.boleto && f.md5Checksum === docs.boleto.md5) || (docs.fatura && f.md5Checksum === docs.fatura.md5) ||
      nomesLocais.has(f.name.toLowerCase()) ||
      digitos(f.name).some((x) => chaves.has(x.replace(/^0+/, ''))));
    const tipo = (f) => (docs.boleto && f.md5Checksum === docs.boleto.md5 ? 'boleto' : docs.fatura && f.md5Checksum === docs.fatura.md5 ? 'fatura'
      : docs.boleto && f.name.toLowerCase() === path.basename(docs.boleto.arq).toLowerCase() ? 'boleto'
        : docs.fatura && f.name.toLowerCase() === path.basename(docs.fatura.arq).toLowerCase() ? 'fatura' : tipoPorNome(f.name));
    const rotulo = `${(c.produto || '').padEnd(7)} ${c.linha || c.numero_documento || '-'} venc ${c.data_vencimento} R$ ${c.valor_original}`;

    // Cópias idênticas (mesmo conteúdo) da mesma conta: fica uma só — a que
    // segue o padrão de nome do financeiro (não o nome gerado pela automação).
    const doRobo = (f) => nomesLocais.has(f.name.toLowerCase());
    const porConteudo = new Map();
    for (const f of meus) (porConteudo.get(f.md5Checksum) || porConteudo.set(f.md5Checksum, []).get(f.md5Checksum)).push(f);
    const removidos = new Set();
    for (const grupo of porConteudo.values()) {
      if (grupo.length < 2) continue;
      const ordem = [...grupo].sort((a, b) => Number(doRobo(a)) - Number(doRobo(b)) || String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
      for (const f of ordem.slice(1)) {
        removidos.add(f.id); plano.push({ acao: 'lixeira', f });
        relatorio.push(`  🗑 ${rotulo}: cópia idêntica "${f.name}" vai para a LIXEIRA (fica "${ordem[0].name}")`);
      }
    }
    const restantes = meus.filter((f) => !removidos.has(f.id));
    const boletos = restantes.filter((f) => tipo(f) === 'boleto');
    const faturas = restantes.filter((f) => tipo(f) === 'fatura');

    const principal = documentoDaConta(c);
    if (!meus.length) {
      if (!principal) { relatorio.push(`  ⚠ ${rotulo}: não está na pasta e não há PDF baixado (ex.: Desktop não tem PDF)`); continue; }
      const h = await md5(principal);
      if (noDrive.has(h)) { relatorio.push(`  ✓ ${rotulo}: já está no Drive em "${noDrive.get(h).pasta}"`); continue; }
      plano.push({ acao: 'subir', arq: principal, c });
      relatorio.push(`  ↑ ${rotulo}: SUBIR ${path.basename(principal)}`);
      continue;
    }
    if (boletos.length && faturas.length) {
      for (const f of faturas) { plano.push({ acao: 'lixeira', f }); relatorio.push(`  🗑 ${rotulo}: tem boleto (${boletos[0].name}) — fatura "${f.name}" vai para a LIXEIRA`); }
      continue;
    }
    if (!boletos.length && docs.boleto && !noDrive.has(docs.boleto.md5)) {
      // Na pasta só a fatura, mas temos o boleto: sobe o boleto e tira a fatura.
      plano.push({ acao: 'subir', arq: docs.boleto.arq, c });
      for (const f of faturas) plano.push({ acao: 'lixeira', f });
      relatorio.push(`  ↑ ${rotulo}: só havia a fatura — SUBIR o boleto e mandar a fatura para a LIXEIRA`);
      continue;
    }
    relatorio.push(`  ✓ ${rotulo}: ok (${restantes.map((f) => f.name).join(', ')})`);
  }

  console.log(`Pasta "${nomePasta}": ${naPasta.length} arquivo(s) | contas com vencimento em ${MES}: ${contas.length}\n`);
  relatorio.forEach((l) => console.log(l));
  const reconhecidos = new Set();
  for (const c of contas) for (const f of naPasta) if (digitos(f.name).some((x) => [...digitos(c.linha), ...digitos(c.numero_documento)].map((y) => y.replace(/^0+/, '')).includes(x.replace(/^0+/, '')))) reconhecidos.add(f.id);
  const outros = naPasta.filter((f) => !reconhecidos.has(f.id) && !contas.some((c) => [c.pdf_path, c.boleto_pdf_path].filter(Boolean).length));
  if (outros.length) console.log(`\nArquivos da pasta que não são de contas do sistema (não mexo): ${outros.map((f) => f.name).join(', ')}`);

  if (!executar) { console.log(`\n${plano.length} ação(ões) planejada(s). (simulação — nada foi alterado; rode com --executar)`); return; }

  const registro = lerRegistro();
  for (const p of plano) {
    if (p.acao === 'subir') {
      const r = await drv.enviarArquivo(p.arq, pastaId);
      registro[await md5(p.arq)] = { id: r.id, nome: path.basename(p.arq), pasta: nomePasta, em: new Date().toISOString() };
      console.log(`  enviado: ${path.basename(p.arq)}`);
    } else {
      await d.files.update({ fileId: p.f.id, requestBody: { trashed: true } });
      console.log(`  lixeira: ${p.f.name}`);
    }
    gravarRegistro(registro);
  }
  console.log('\nConcluído.');
})().catch((e) => {
  const auth = /invalid_grant/i.test(e.message);
  console.error('Erro:', e.message, auth ? '\n→ A autorização do Google expirou: rode "npm run google:token" e tente de novo.' : '');
  process.exit(1);
});
