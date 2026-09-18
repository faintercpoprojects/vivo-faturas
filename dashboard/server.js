'use strict';

/**
 * Dashboard local de Contas a Pagar (Vivo). Servidor Express que lê o banco
 * SQLite alimentado pela automação e serve uma página única para o financeiro.
 * Roda só na máquina local: http://localhost:<porta>.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* opcional */ }

const DB_FILE = process.env.DB_PATH
  ? path.resolve(ROOT, process.env.DB_PATH)
  : path.join(ROOT, '.state', 'contas.db');
const PORT = Number(process.env.DASHBOARD_PORT) || 4599;

// Link da pasta no Google Drive (botão de validação). Configurável por env;
// padrão = pasta raiz "Contas Telefonia" (ID já conhecido). Troque com
// DRIVE_FOLDER_URL no .env quando quiser um link específico.
const DRIVE_FOLDER_URL =
  process.env.DRIVE_FOLDER_URL ||
  (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID
    ? `https://drive.google.com/drive/folders/${process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID}`
    : '');

function db() {
  // Abre a cada requisição (leitura barata; garante ver dados de outros processos).
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const d = new DatabaseSync(DB_FILE);
  d.exec(`CREATE TABLE IF NOT EXISTS contas (id INTEGER PRIMARY KEY);`); // no-op se já existe
  return d;
}

const hoje = () => new Date().toISOString().slice(0, 10);

/** Situação consolidada para exibição (portal + interno + vencimento). */
function situacao(c) {
  const interno = (c.status_interno || '').toLowerCase();
  if (interno.includes('pag') || interno.includes('baix')) return c.status_interno;
  if ((c.status_portal || '').toLowerCase().includes('pag')) return 'Paga (portal)';
  if (c.data_vencimento && c.data_vencimento < hoje()) return 'Vencida';
  return 'A vencer';
}

const app = express();
app.use(express.json());

// ---- API ------------------------------------------------------------------

app.get('/api/contas', (req, res) => {
  try {
    const d = db();
    const rows = d.prepare(`SELECT * FROM contas ORDER BY data_vencimento IS NULL, data_vencimento`).all();
    d.close();
    res.json(rows.map((c) => ({ ...c, situacao: situacao(c) })));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/resumo', (req, res) => {
  try {
    const d = db();
    const rows = d.prepare(`SELECT * FROM contas`).all();
    d.close();
    const t = hoje();
    const pago = (c) => /pag|baix/i.test(c.status_interno || '') || /pag/i.test(c.status_portal || '');
    let valorTotal = 0, valorPendente = 0, valorVencido = 0, valorAVencer = 0;
    let emAberto = 0, pagas = 0, vencidas = 0, aVencer = 0;
    const prox = [];
    for (const c of rows) {
      const v = c.valor_original || 0;
      valorTotal += v;
      if (pago(c)) { pagas++; continue; }
      emAberto++;
      valorPendente += v;
      if (c.data_vencimento && c.data_vencimento < t) { vencidas++; valorVencido += v; }
      else { aVencer++; valorAVencer += v; prox.push(c); }
    }
    prox.sort((a, b) => String(a.data_vencimento).localeCompare(String(b.data_vencimento)));
    res.json({
      total: rows.length, emAberto, pagas, vencidas, aVencer,
      valorTotal, valorPendente, valorVencido, valorAVencer,
      proximosVencimentos: prox.slice(0, 5).map((c) => ({
        empresa: c.empresa, linha: c.linha, valor: c.valor_original, vencimento: c.data_vencimento,
      })),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Campos que o FINANCEIRO pode editar
const EDITAVEIS = ['status_interno', 'valor_pago', 'data_pagamento', 'data_baixa',
  'forma_pagamento', 'banco_conta', 'comprovante', 'observacoes'];

app.patch('/api/contas/:id', (req, res) => {
  try {
    const campos = Object.keys(req.body || {}).filter((k) => EDITAVEIS.includes(k));
    if (!campos.length) return res.status(400).json({ erro: 'nada para atualizar' });
    const d = db();
    const set = campos.map((c) => `${c} = ?`).join(', ') + ', updated_at = ?';
    const vals = campos.map((c) => req.body[c]);
    vals.push(new Date().toISOString(), Number(req.params.id));
    d.prepare(`UPDATE contas SET ${set} WHERE id = ?`).run(...vals);
    const row = d.prepare(`SELECT * FROM contas WHERE id = ?`).get(Number(req.params.id));
    d.close();
    res.json({ ...row, situacao: situacao(row) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Abrir PDF: serve o arquivo local; se não existir, redireciona para o Drive.
function servirPdf(campoPath, campoLink, rotulo) {
  return (req, res) => {
    try {
      const d = db();
      const c = d.prepare(`SELECT ${campoPath} p, ${campoLink} l, linha, competencia FROM contas WHERE id = ?`).get(Number(req.params.id));
      d.close();
      // Serve o PDF local por streaming (evita o bloqueio de "dotfiles" do sendFile,
      // já que o caminho passa pela pasta .claude).
      if (c && c.p && fs.existsSync(c.p)) {
        res.type('application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${rotulo}-${c.linha}-${String(c.competencia).replace('/', '-')}.pdf"`);
        return fs.createReadStream(c.p).pipe(res);
      }
      if (c && c.l) return res.redirect(c.l); // fallback: Drive
      res.status(404).send('PDF não disponível para esta conta.');
    } catch (e) {
      res.status(500).send(e.message);
    }
  };
}
app.get('/api/contas/:id/fatura', servirPdf('pdf_path', 'drive_link', 'Fatura'));
app.get('/api/contas/:id/boleto', servirPdf('boleto_pdf_path', 'boleto_drive_link', 'Boleto'));

// Disparar a ingestão em segundo plano.
//   modo padrão  -> baixa faturas/boletos + banco (completo)
//   modo=status  -> só LÊ e atualiza o status no portal (Fixo sem download;
//                   Móvel baixa só a fatura p/ identificar a linha). Bem rápido.
let rodando = false;
let modoAtual = null;
app.post('/api/run', (req, res) => {
  if (rodando) return res.json({ ok: true, jaRodando: true, modo: modoAtual });
  const modo = (req.query.modo || (req.body && req.body.modo) || '').toString();
  const args = modo === 'status'
    ? ['index.js', '--todos-cnpj', '--somente-status', '--headless', '--no-upload']
    : ['index.js', '--todos-cnpj', '--incluir-pagas', '--headless', '--no-upload'];
  rodando = true; modoAtual = modo === 'status' ? 'status' : 'completo';
  const child = spawn(process.execPath, args, {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('exit', () => { rodando = false; modoAtual = null; });
  child.unref();
  res.json({ ok: true, iniciado: true, modo: modoAtual });
});
app.get('/api/run/status', (req, res) => {
  try {
    const d = db();
    let ultima = null;
    try { ultima = d.prepare(`SELECT * FROM execucoes ORDER BY id DESC LIMIT 1`).get(); } catch { /* sem tabela */ }
    d.close();
    res.json({ rodando, modo: modoAtual, ultima });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ driveFolderUrl: DRIVE_FOLDER_URL });
});

// ---- estático -------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// IPs IPv4 da máquina na rede local (para mostrar a URL de acesso dos colegas).
function ipsLocais() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const iface of Object.values(nets)) {
    for (const n of iface || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

// Escuta em TODAS as interfaces (0.0.0.0) para permitir acesso pela rede local.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard Contas a Pagar (Vivo)`);
  console.log(`  local ...... http://localhost:${PORT}`);
  for (const ip of ipsLocais()) console.log(`  na rede .... http://${ip}:${PORT}`);
  console.log(`Banco: ${DB_FILE}`);
});
