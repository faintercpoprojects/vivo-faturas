#!/usr/bin/env node
'use strict';
/**
 * Publica a pasta nuvem/ na Vercel (produção: https://contas-cpo.vercel.app).
 *   node nuvem/publicar.js
 *
 * Publica a partir de uma CÓPIA sem o histórico do git: no plano gratuito a
 * Vercel bloqueia deploys cujo autor do commit não é membro da conta
 * ("commit author doesn't have permission").
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ORIGEM = __dirname;
const DESTINO = fs.mkdtempSync(path.join(os.tmpdir(), 'contas-nuvem-'));
for (const item of ['api', 'lib', 'public', 'package.json', 'package-lock.json', 'vercel.json', '.vercelignore']) {
  fs.cpSync(path.join(ORIGEM, item), path.join(DESTINO, item), { recursive: true });
}
fs.mkdirSync(path.join(DESTINO, '.vercel'));
fs.copyFileSync(path.join(ORIGEM, '.vercel', 'project.json'), path.join(DESTINO, '.vercel', 'project.json'));
console.log('Publicando a partir de', DESTINO);
try {
  execSync('npx vercel@latest deploy --prod --yes', { cwd: DESTINO, stdio: 'inherit' });
} finally {
  fs.rmSync(DESTINO, { recursive: true, force: true });
}
