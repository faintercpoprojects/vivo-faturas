#!/usr/bin/env node
'use strict';

/**
 * ---------------------------------------------------------------------------
 * Gera o GOOGLE_REFRESH_TOKEN para o upload ao Google Drive (OAuth2).
 * ---------------------------------------------------------------------------
 * Uso:
 *   npm run google:token
 *
 * O script sobe um servidor local temporário em http://localhost:53682,
 * abre o navegador na tela de consentimento do Google e captura o código
 * automaticamente no redirect — você não precisa copiar/colar nada.
 *
 * Requisitos no Google Cloud Console (credencial OAuth "App para Desktop"):
 *   - adicione o URI de redirecionamento:  http://localhost:53682
 *   - em "Tela de consentimento OAuth", adicione seu e-mail como usuário de teste
 *     (enquanto o app estiver em modo de teste).
 */

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const PORTA = 53682;
const REDIRECT = `http://localhost:${PORTA}`;
const ESCOPOS = ['https://www.googleapis.com/auth/drive'];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function abrirNavegador(url) {
  const plataforma = process.platform;
  const cmd =
    plataforma === 'win32'
      ? `start "" "${url}"`
      : plataforma === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log('\nNão consegui abrir o navegador automaticamente.');
      console.log('Abra este endereço manualmente:\n');
      console.log(url + '\n');
    }
  });
}

/** Grava/atualiza a linha GOOGLE_REFRESH_TOKEN no .env sem tocar no resto. */
function salvarNoEnv(refreshToken) {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return false;
  let conteudo = fs.readFileSync(envPath, 'utf8');
  if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(conteudo)) {
    conteudo = conteudo.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${refreshToken}`);
  } else {
    conteudo += `\nGOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
  }
  fs.writeFileSync(envPath, conteudo, 'utf8');
  return true;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('ERRO: preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env antes de rodar.');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // força emissão de refresh_token mesmo em reautorizações
    scope: ESCOPOS,
  });

  const codigo = await new Promise((resolve, reject) => {
    const servidor = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, REDIRECT);
        const code = url.searchParams.get('code');
        const erro = url.searchParams.get('error');
        if (erro) {
          res.end(`Falha na autorização: ${erro}. Pode fechar esta aba.`);
          servidor.close();
          return reject(new Error(erro));
        }
        if (code) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<h2>Autorização concluída!</h2><p>Pode fechar esta aba e voltar ao terminal.</p>');
          servidor.close();
          return resolve(code);
        }
        res.end('Aguardando autorização...');
      } catch (e) {
        reject(e);
      }
    });

    servidor.on('error', reject);
    servidor.listen(PORTA, () => {
      console.log('='.repeat(70));
      console.log('Autorização do Google Drive');
      console.log('='.repeat(70));
      console.log('\nAbrindo o navegador para você autorizar o acesso...');
      console.log('Faça login com: tecnologia.unicpo@gmail.com\n');
      console.log('Se o navegador não abrir, acesse manualmente:\n');
      console.log(authUrl + '\n');
      abrirNavegador(authUrl);
    });
  });

  console.log('Código recebido. Trocando por tokens...');
  const { tokens } = await oauth2.getToken(codigo);

  if (!tokens.refresh_token) {
    console.error(
      '\nERRO: o Google não retornou refresh_token. Isso acontece quando o app já foi autorizado antes.\n' +
        'Remova o acesso em https://myaccount.google.com/permissions e rode novamente.'
    );
    process.exit(1);
  }

  const gravado = salvarNoEnv(tokens.refresh_token);
  console.log('\n' + '='.repeat(70));
  console.log('SUCESSO! Refresh token obtido.');
  console.log('='.repeat(70));
  if (gravado) {
    console.log('\nGOOGLE_REFRESH_TOKEN foi gravado automaticamente no seu .env.');
  } else {
    console.log('\nAdicione esta linha ao seu .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  }

  // Teste rápido: confirma acesso à pasta configurada.
  try {
    oauth2.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const folderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (folderId) {
      const r = await drive.files.get({ fileId: folderId, fields: 'id, name', supportsAllDrives: true });
      console.log(`Acesso confirmado à pasta: "${r.data.name}" (${r.data.id})`);
    }
  } catch (e) {
    console.log(`Aviso: não consegui validar a pasta (${e.message}). Confira o GOOGLE_DRIVE_ROOT_FOLDER_ID.`);
  }

  console.log('\nPronto. Agora você pode rodar a automação completa: npm start');
}

main().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
