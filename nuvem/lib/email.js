'use strict';

/**
 * Envio de e-mail (link de "Esqueci minha senha").
 * Configuração na Vercel (Settings > Environment Variables):
 *   SMTP_USER  = conta que envia (ex.: tecnologia.unicpo@gmail.com)
 *   SMTP_PASS  = senha de app do Gmail (16 letras) — NÃO é a senha normal
 *   SMTP_HOST  = smtp.gmail.com (padrão)   SMTP_PORT = 465 (padrão)
 *   SMTP_FROM  = "Contas a Pagar <tecnologia.unicpo@gmail.com>" (opcional)
 */
let envioTeste = null;

/** Testes: captura os e-mails em vez de enviar. */
function usarEnvio(fn) { envioTeste = fn; }

const configurado = () => !!(envioTeste || (process.env.SMTP_USER && process.env.SMTP_PASS));

async function enviarEmail({ para, assunto, texto, html }) {
  if (envioTeste) return envioTeste({ para, assunto, texto, html });
  if (!configurado()) throw new Error('E-mail não configurado (SMTP_USER/SMTP_PASS).');
  const nodemailer = require('nodemailer');
  const porta = Number(process.env.SMTP_PORT || 465);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: porta,
    secure: porta === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.SMTP_FROM || `Contas a Pagar <${process.env.SMTP_USER}>`, to: para, subject: assunto, text: texto, html });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function emailRedefinicao({ nome, usuario, link, minutos }) {
  const texto = `Olá, ${nome}.

Recebemos um pedido para redefinir a senha do usuário "${usuario}" no Contas a Pagar.
Para criar uma nova senha, abra o link abaixo (vale por ${minutos} minutos e só pode ser usado uma vez):

${link}

Se não foi você, ignore este e-mail: sua senha continua a mesma.`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2937;max-width:520px">
  <p>Olá, ${esc(nome)}.</p>
  <p>Recebemos um pedido para redefinir a senha do usuário <b>${esc(usuario)}</b> no <b>Contas a Pagar</b>.</p>
  <p><a href="${esc(link)}" style="display:inline-block;background:#3b6ef6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Criar nova senha</a></p>
  <p style="color:#6b7280;font-size:13px">O link vale por ${minutos} minutos e só pode ser usado uma vez.<br>Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
</div>`;
  return { assunto: 'Redefinir sua senha — Contas a Pagar', texto, html };
}

module.exports = { enviarEmail, configurado, usarEnvio, emailRedefinicao };
