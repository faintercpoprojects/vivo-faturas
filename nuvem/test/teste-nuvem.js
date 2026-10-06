'use strict';
// Teste ponta a ponta da versão na nuvem (Postgres em memória + dados reais copiados).
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { iniciar } = require('./servidor-local');
const { hashSenha } = require('../lib/auth');

const B = 'http://localhost:4611';
let falhas = 0;
const ok = (c, nome) => { console.log(`${c ? 'OK    ' : 'FALHOU'} ${nome}`); if (!c) falhas++; };
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const req = async (p, { method = 'GET', body, cookie, headers = {} } = {}) => {
  const r = await fetch(B + p, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  const sc = r.headers.get('set-cookie');
  return { status: r.status, json, buf, cookie: sc ? sc.split(';')[0] : null, tipo: r.headers.get('content-type') };
};

(async () => {
  const sim = await iniciar({ porta: 4611, silencioso: true });
  const { query, agente } = sim;
  try {
    // ---- dados copiados x banco local
    const local = new DatabaseSync(require('path').resolve(__dirname, '../../.state/contas.db'), { readOnly: true });
    const nLocal = local.prepare('SELECT COUNT(*) n FROM contas').get().n;
    const comPdf = local.prepare("SELECT hash_dedup, pdf_path, boleto_pdf_path FROM contas WHERE boleto_pdf_path IS NOT NULL OR pdf_path IS NOT NULL").all()
      .filter((c) => (c.pdf_path && fs.existsSync(c.pdf_path)) || (c.boleto_pdf_path && fs.existsSync(c.boleto_pdf_path)));
    local.close();
    const nNuvem = Number((await query('SELECT COUNT(*)::int n FROM contas'))[0].n);
    ok(nNuvem === nLocal, `todas as contas foram para a nuvem (${nNuvem}/${nLocal})`);
    ok(sim.envio.pdfs > 0, `PDFs enviados (${sim.envio.pdfs})`);

    // ---- acesso sem login
    let r = await req('/'); ok(r.status === 200 && /Contas a Pagar/.test(r.buf.toString()), 'página abre (dados só via API)');
    r = await req('/api/contas'); ok(r.status === 401, 'sem login: API 401');
    r = await req('/api/primeiro-acesso', { method: 'POST', body: { usuario: 'x', nome: 'x', senha: 'abcdefghij1' } });
    ok(r.status === 403, 'na nuvem não dá para criar o 1º admin pela internet');

    // ---- admin criado pelo computador (como o scripts/nuvem.js admin faz)
    const senha = 'T' + crypto.randomBytes(8).toString('hex') + '7';
    await agente.criarAdmin({ usuario: 'teste.admin', nome: 'Admin Teste', senhaHash: hashSenha(senha) });
    r = await req('/api/login', { method: 'POST', body: { usuario: 'teste.admin', senha: 'errada123456' } });
    ok(r.status === 401, 'senha errada recusada');
    r = await req('/api/login', { method: 'POST', body: { usuario: 'teste.admin', senha } });
    ok(r.status === 200 && r.cookie, 'login OK');
    const ck = r.cookie;

    // ---- dados
    r = await req('/api/contas', { cookie: ck });
    ok(r.status === 200 && r.json.length > 0, `lista de contas (${r.json.length})`);
    const contas = r.json;
    r = await req('/api/resumo', { cookie: ck });
    console.log(`       resumo nuvem: em aberto R$ ${r.json.valorPendente.toFixed(2)} (${r.json.emAberto}) | vencidas ${r.json.vencidas} | pagas ${r.json.pagas}`);
    ok(r.status === 200 && typeof r.json.valorPendente === 'number', 'resumo OK');

    // ---- PDF igual ao arquivo local
    const alvo = comPdf[0];
    const conta = contas.find((c) => c.hash_dedup === alvo.hash_dedup);
    if (conta) {
      const tipo = alvo.boleto_pdf_path && fs.existsSync(alvo.boleto_pdf_path) ? 'boleto' : 'fatura';
      const arq = tipo === 'boleto' ? alvo.boleto_pdf_path : alvo.pdf_path;
      r = await req(`/api/contas/${conta.id}/${tipo}`, { cookie: ck });
      ok(r.status === 200 && r.tipo === 'application/pdf' && md5(r.buf) === md5(fs.readFileSync(arq)), `PDF (${tipo}) baixa idêntico ao arquivo local`);
      r = await req(`/api/contas/${conta.id}/${tipo}`);
      ok(r.status === 401, 'PDF sem login bloqueado');
    } else ok(false, 'conta com PDF visível no dashboard');

    // ---- financeiro não é sobrescrito pela sincronização
    const c0 = contas[0];
    r = await req(`/api/contas/${c0.id}`, { method: 'PATCH', cookie: ck, body: { status_interno: 'Paga', observacoes: 'pago no teste' } });
    ok(r.status === 200 && r.json.alterado_por === 'Admin Teste', 'registrar pagamento grava quem fez');
    await agente.enviar();
    const depois = (await query('SELECT status_interno, observacoes FROM contas WHERE id = $1', [c0.id]))[0];
    ok(depois.status_interno === 'Paga' && depois.observacoes === 'pago no teste', 'sincronizar de novo NÃO apaga o que o financeiro registrou');

    // ---- excluir não volta na próxima sincronização
    const c1 = contas[1];
    r = await req(`/api/contas/${c1.id}`, { method: 'DELETE', cookie: ck });
    await agente.enviar();
    const volta = (await query('SELECT COUNT(*)::int n FROM contas WHERE hash_dedup = $1', [c1.hash_dedup]))[0].n;
    ok(r.json.ok && volta === 0, 'conta excluída não é recriada pela sincronização');

    // ---- nota manual
    r = await req('/api/contas', { method: 'POST', cookie: ck, body: { empresa: 'Teste Manual', produto: 'Vero', valor_original: 10.5, data_vencimento: '2026-10-30' } });
    ok(r.status === 200 && r.json.origem === 'manual', 'nova nota manual');

    // ---- botão "Baixar contas" -> pedido -> agente executa
    r = await req('/api/run/status', { cookie: ck }); ok(r.json.agenteOnline === false, 'sem sinal do computador: aparece offline');
    r = await req('/api/run', { method: 'POST', cookie: ck }); ok(r.json.pedido, 'botão cria pedido para o computador');
    r = await req('/api/run/status', { cookie: ck }); ok(r.json.rodando && r.json.aguardandoComputador, 'status: aguardando o computador');
    let executou = null;
    const timer = agente.iniciarAgente({
      iniciarColeta: (modo, fim) => { executou = modo; setTimeout(() => fim(0), 200); return true; },
      rodando: () => false, log: () => {}, intervaloMs: 300,
    });
    await new Promise((res) => setTimeout(res, 1500));
    clearInterval(timer);
    r = await req('/api/run/status', { cookie: ck });
    ok(executou === 'completo' && !r.json.rodando && r.json.agenteOnline, 'computador pegou o pedido, executou e ficou online');

    // ---- "Esqueci minha senha" (e-mail capturado em vez de enviado)
    const enviados = [];
    require('../lib/email').usarEnvio(async (m) => { enviados.push(m); });
    r = await req('/api/sessao'); ok(r.json.esqueci === true, 'login mostra "Esqueci minha senha" quando o e-mail está configurado');
    r = await req('/api/esqueci', { method: 'POST', body: { identificador: 'teste.admin' } });
    ok(r.status === 200 && enviados.length === 0, 'usuário sem e-mail: resposta genérica e nada é enviado');
    r = await req('/api/meu-email', { method: 'POST', cookie: ck, body: { email: 'invalido' } });
    ok(r.status === 400, 'e-mail inválido recusado');
    r = await req('/api/meu-email', { method: 'POST', cookie: ck, body: { email: 'admin.teste@example.com' } });
    ok(r.status === 200, 'usuário cadastra o próprio e-mail');
    r = await req('/api/esqueci', { method: 'POST', body: { identificador: 'ninguem@example.com' } });
    const genericaDesconhecido = r.json.mensagem;
    r = await req('/api/esqueci', { method: 'POST', body: { identificador: 'ADMIN.TESTE@example.com' } });
    ok(r.status === 200 && r.json.mensagem === genericaDesconhecido, 'mesma resposta para usuário existente e inexistente');
    ok(enviados.length === 1 && enviados[0].para === 'admin.teste@example.com', 'e-mail enviado só para o usuário certo (achado pelo e-mail)');
    const token = ((enviados[0] && enviados[0].texto.match(/#redefinir=([\w-]+)/)) || [])[1];
    ok(token && /http:\/\/localhost:4611\/login\.html#redefinir=/.test(enviados[0].texto), 'e-mail traz link para o próprio site');
    r = await req('/api/esqueci', { method: 'POST', body: { identificador: 'teste.admin' } });
    ok(enviados.length === 1, 'não manda outro link em menos de 2 minutos');
    const guardado = (await query('SELECT token_hash FROM redefinicoes LIMIT 1'))[0];
    ok(guardado && guardado.token_hash !== token, 'banco guarda só o hash do link');
    r = await req('/api/redefinir', { method: 'POST', body: { token, nova: 'curta' } });
    ok(r.status === 400, 'senha fraca recusada na redefinição');
    const nova = 'N' + crypto.randomBytes(8).toString('hex') + '5';
    r = await req('/api/redefinir', { method: 'POST', body: { token, nova } });
    ok(r.status === 200 && r.json.usuario === 'teste.admin', 'nova senha criada pelo link');
    r = await req('/api/contas', { cookie: ck }); ok(r.status === 401, 'sessões antigas caem após redefinir');
    r = await req('/api/login', { method: 'POST', body: { usuario: 'teste.admin', senha } }); ok(r.status === 401, 'senha antiga não funciona mais');
    r = await req('/api/login', { method: 'POST', body: { usuario: 'teste.admin', senha: nova } }); ok(r.status === 200, 'login com a nova senha');
    const ck2 = r.cookie;
    r = await req('/api/redefinir', { method: 'POST', body: { token, nova: 'Outra' + nova } }); ok(r.status === 400, 'link usado não funciona de novo');
    await query("UPDATE redefinicoes SET criado_em = '2000-01-01T00:00:00Z'"); // libera novo pedido
    await req('/api/esqueci', { method: 'POST', body: { identificador: 'teste.admin' } });
    const token2 = (enviados[1].texto.match(/#redefinir=([\w-]+)/) || [])[1];
    await query('UPDATE redefinicoes SET expira = 1 WHERE usado = 0');
    r = await req('/api/redefinir', { method: 'POST', body: { token: token2, nova: 'Outra' + nova } }); ok(r.status === 400, 'link vencido (30 min) é recusado');
    r = await req('/api/redefinir', { method: 'POST', body: { token: 'inventado', nova: 'Outra' + nova } }); ok(r.status === 400, 'link inventado é recusado');
    r = await req('/api/usuarios', { cookie: ck2 }); ok(r.json[0] && 'email' in r.json[0], 'admin vê o e-mail dos usuários');
    let ultE; for (let i = 0; i < 9; i++) ultE = await req('/api/esqueci', { method: 'POST', body: { identificador: 'x' + i } });
    ok(ultE.status === 429, 'limite de pedidos de "Esqueci minha senha" por IP');
    const ckSeg = ck2;

    // ---- segurança
    r = await req(`/api/contas/${c0.id}`, { method: 'PATCH', cookie: ckSeg, body: { observacoes: 'x' }, headers: { Origin: 'https://outro-site.example' } });
    ok(r.status === 403, 'alteração vinda de outro site bloqueada');
    const [dados, sig] = decodeURIComponent(ckSeg.split('=')[1]).split('.');
    const f = JSON.parse(Buffer.from(dados, 'base64url').toString()); f.i = 999;
    r = await req('/api/contas', { cookie: `cp_sessao=${Buffer.from(JSON.stringify(f)).toString('base64url')}.${sig}` });
    ok(r.status === 401, 'cookie adulterado recusado');
    let ult; for (let i = 0; i < 9; i++) ult = await req('/api/login', { method: 'POST', body: { usuario: 'teste.admin', senha: 'errada' + i + 'xxxxxx' } });
    ok(ult.status === 429, 'bloqueio após várias senhas erradas (guardado no banco)');
  } finally {
    await sim.fechar();
  }
  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
