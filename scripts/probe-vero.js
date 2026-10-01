'use strict';
// Diagnóstico do Minha Vero pela mesma API que o site usa:
//   POST /cypher/auth/authenticate -> token; GET /cypher/financeiro/<doc>/faturas
// Nunca imprime a senha nem o token. Saída: logs/probe-vero.json
//   node scripts/probe-vero.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE = 'https://verointernet.com.br/cypher';
const usuario = (process.env.VERO_USUARIO || '').replace(/\D/g, '');
const senha = process.env.VERO_SENHA || '';
if (!usuario || !senha) { console.error('Preencha VERO_USUARIO e VERO_SENHA no .env'); process.exit(2); }

const limpar = (s) => String(s).split(senha).join('***');

(async () => {
  const auth = await fetch(`${BASE}/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: usuario, password: senha }),
  });
  const authTxt = await auth.text();
  if (!auth.ok) { console.log('login falhou:', auth.status, limpar(authTxt).slice(0, 300)); process.exit(1); }
  const a = JSON.parse(authTxt);
  console.log('login OK | campos da resposta:', Object.keys(a).join(', '), '| crm:', a.crm);
  const headers = { Authorization: `Bearer ${a.access_token}`, CRM: String(a.crm ?? 'todos'), Accept: 'application/json' };

  const saida = {};
  for (const rota of [`/cliente/${usuario}/contratos`, `/financeiro/${usuario}/faturas`]) {
    const r = await fetch(BASE + rota, { headers });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* texto */ }
    saida[rota] = { status: r.status, json: json ?? limpar(txt).slice(0, 2000) };
    console.log(`\n${rota} -> ${r.status}`);
    console.log(limpar(JSON.stringify(json ?? txt, null, 1)).slice(0, 3500));
  }
  fs.writeFileSync(path.resolve(__dirname, '..', 'logs', 'probe-vero.json'), limpar(JSON.stringify(saida, null, 2)));
})().catch((e) => { console.error('Falha:', limpar(e.message)); process.exit(1); });
