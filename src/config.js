'use strict';

const path = require('path');
const fs = require('fs');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'sim', 'y', 's'].includes(String(v).trim().toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function list(v) {
  if (!v) return [];
  return String(v)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Remove tudo que nao for digito. */
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function abs(p, def) {
  const value = p && String(p).trim() ? String(p).trim() : def;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

// ---------------------------------------------------------------------------
// Flags de linha de comando (sobrescrevem o .env)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const cli = {
  headed: hasFlag('--headed'),
  headless: hasFlag('--headless'),
  noUpload: hasFlag('--no-upload'),
  noIa: hasFlag('--no-ia'),
  noCleanup: hasFlag('--no-cleanup'),
  freshSession: hasFlag('--fresh-session'),
  onlyLogin: hasFlag('--only-login'),
  inspecionar: hasFlag('--inspecionar'),
  cnpj: flagValue('--cnpj'),
  meses: flagValue('--meses'),
};

const config = {
  ROOT,
  cli,

  portal: {
    // URL de login (pode conter ?logout=true para forçar sessão nova)
    url: process.env.VIVO_URL || 'https://mve.vivo.com.br/',
    // URL base do painel autenticado (SEM logout) — usada após o login
    baseUrl: (() => {
      const raw = process.env.VIVO_BASE_URL || process.env.VIVO_URL || 'https://mve.vivo.com.br/';
      try {
        return new URL(raw).origin + '/';
      } catch {
        return 'https://mve.vivo.com.br/';
      }
    })(),
    user: process.env.VIVO_USER || '',
    pass: process.env.VIVO_PASS || '',
  },

  cnpj: {
    ignorar: new Set(list(process.env.CNPJ_IGNORAR).map(onlyDigits)),
    somente: new Set(
      list(cli.cnpj || process.env.CNPJ_SOMENTE).map(onlyDigits)
    ),
  },

  browser: {
    headless: cli.headed ? false : cli.headless ? true : bool(process.env.HEADLESS, true),
    slowMo: int(process.env.SLOW_MO, 0),
    navTimeout: int(process.env.NAV_TIMEOUT, 60000),
    actionTimeout: int(process.env.ACTION_TIMEOUT, 30000),
    downloadTimeout: int(process.env.DOWNLOAD_TIMEOUT, 180000),
    locale: 'pt-BR',
    timezone: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1600, height: 950 },
  },

  run: {
    maxRetries: int(process.env.MAX_RETRIES, 3),
    retryBaseDelay: int(process.env.RETRY_BASE_DELAY, 2000),
    concurrency: Math.max(1, int(process.env.CONCURRENCY, 1)),
    mesesRetroativos: int(cli.meses || process.env.MESES_RETROATIVOS, 12),
    reuseSession: cli.freshSession ? false : bool(process.env.REUSE_SESSION, true),
    limparAposUpload: cli.noCleanup ? false : bool(process.env.LIMPAR_APOS_UPLOAD, true),
    onlyLogin: cli.onlyLogin,
  },

  paths: {
    downloads: abs(process.env.DOWNLOAD_DIR, './downloads'),
    logs: abs(process.env.LOG_DIR, './logs'),
    storageState: abs(process.env.STORAGE_STATE, './.auth/state.json'),
    screenshots: abs('./logs/screenshots'),
    state: abs('./.state'),
    manifest: abs('./.state/manifest.json'),
  },

  ia: {
    // Desligada se --no-ia (CLI) OU IA_ENABLED=false (.env).
    enabled: cli.noIa ? false : bool(process.env.IA_ENABLED, true),
    provider: (process.env.IA_PROVIDER || 'anthropic').toLowerCase(),
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    maxChars: int(process.env.IA_MAX_CHARS, 18000),
  },

  drive: {
    enabled: cli.noUpload ? false : bool(process.env.GOOGLE_DRIVE_ENABLED, true),
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE
      ? abs(process.env.GOOGLE_SERVICE_ACCOUNT_FILE)
      : '',
    impersonateUser: process.env.GOOGLE_IMPERSONATE_USER || '',
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '',
    driveId: process.env.GOOGLE_DRIVE_ID || '',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

/**
 * Valida a configuracao minima. Lanca erro com mensagem acionavel.
 */
function validate() {
  const erros = [];

  if (!config.portal.user || !config.portal.pass) {
    erros.push('VIVO_USER e VIVO_PASS sao obrigatorios no .env');
  }

  if (config.ia.enabled) {
    if (config.ia.provider === 'anthropic' && !config.ia.anthropicKey) {
      erros.push('IA_PROVIDER=anthropic exige ANTHROPIC_API_KEY');
    }
    if (config.ia.provider === 'openai' && !config.ia.openaiKey) {
      erros.push('IA_PROVIDER=openai exige OPENAI_API_KEY');
    }
    if (!['anthropic', 'openai'].includes(config.ia.provider)) {
      erros.push(`IA_PROVIDER invalido: ${config.ia.provider} (use anthropic ou openai)`);
    }
  }

  if (config.drive.enabled) {
    const temSa = config.drive.serviceAccountFile && fs.existsSync(config.drive.serviceAccountFile);
    const temOauth = config.drive.clientId && config.drive.clientSecret && config.drive.refreshToken;
    if (!temSa && !temOauth) {
      erros.push(
        'Google Drive habilitado mas sem credenciais: informe GOOGLE_SERVICE_ACCOUNT_FILE (arquivo existente) ' +
          'ou o trio GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN'
      );
    }
    if (!config.drive.rootFolderId) {
      erros.push('GOOGLE_DRIVE_ROOT_FOLDER_ID e obrigatorio quando o upload esta habilitado');
    }
  }

  if (erros.length) {
    const e = new Error('Configuracao invalida:\n  - ' + erros.join('\n  - '));
    e.code = 'ECONFIG';
    throw e;
  }
}

module.exports = { config, validate, onlyDigits, bool, int, list };
