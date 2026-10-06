'use strict';
/**
 * Simula a Vercel neste computador: Postgres em memória (PGlite), a API da
 * pasta nuvem/api e as telas de nuvem/public. Copia os dados reais do banco
 * local (somente leitura) pelo mesmo agente que roda em produção.
 *   node test/servidor-local.js      -> http://localhost:4610
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function iniciar({ porta = 4610, silencioso = false } = {}) {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET_TESTE || crypto.randomBytes(48).toString('base64url');
  process.env.NUVEM_LOCAL = '1';
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const query = async (t, p = []) => (await pg.query(t, p)).rows;

  require('../lib/db').usarBanco(query);
  const agente = require('../../src/nuvem');
  agente.usarBanco({ query, executar: (s) => pg.exec(s) });
  await agente.esquema();
  await agente.migrarUsuarios({ log: silencioso ? () => {} : console.log });
  const envio = await agente.enviar({ log: silencioso ? () => {} : console.log });

  const handler = require('../api/index.js');
  const PUB = path.join(__dirname, '..', 'public');
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      req.query = Object.fromEntries(url.searchParams);
      req.query.rota = url.pathname.slice(5);
      return handler(req, res);
    }
    const arq = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const p = path.join(PUB, path.normalize(arq));
    if (!p.startsWith(PUB) || !fs.existsSync(p)) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => servidor.listen(porta, r));
  if (!silencioso) console.log(`Nuvem simulada em http://localhost:${porta}`);
  return { servidor, pg, query, agente, envio, fechar: () => new Promise((r) => servidor.close(() => pg.close().then(r))) };
}

if (require.main === module) iniciar().catch((e) => { console.error(e); process.exit(1); });
module.exports = { iniciar };
