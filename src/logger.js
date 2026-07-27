'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const { config } = require('./config');

fs.mkdirSync(config.paths.logs, { recursive: true });

const REDACT = [config.portal.pass, config.ia.anthropicKey, config.ia.openaiKey, config.drive.refreshToken]
  .filter((v) => v && v.length > 4);

/** Remove segredos de qualquer string que va para o log. */
function redact(text) {
  let out = String(text);
  for (const secret of REDACT) out = out.split(secret).join('***');
  return out;
}

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') info.message = redact(info.message);
  if (info.stack) info.stack = redact(info.stack);
  return info;
});

const consoleFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(({ timestamp, level, message, ctx, ...rest }) => {
    const escopo = ctx ? ` [${ctx}]` : '';
    const extra = Object.keys(rest).filter((k) => !k.startsWith('Symbol')).length
      ? ' ' + JSON.stringify(rest, replacerErro)
      : '';
    return `${timestamp} ${level}${escopo} ${message}${extra}`;
  })
);

const fileFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json({ replacer: replacerErro })
);

function replacerErro(_key, value) {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack, code: value.code };
  }
  return value;
}

const logger = winston.createLogger({
  level: config.log.level,
  format: fileFormat,
  transports: [
    new winston.transports.Console({ format: consoleFormat, level: config.log.level }),
    new winston.transports.DailyRotateFile({
      dirname: config.paths.logs,
      filename: 'vivo-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: true,
    }),
    new winston.transports.DailyRotateFile({
      dirname: config.paths.logs,
      filename: 'vivo-erros-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '90d',
      zippedArchive: true,
    }),
  ],
  exitOnError: false,
});

/**
 * Cria um logger filho com contexto fixo (ex.: CNPJ atual).
 * @param {string} ctx
 */
function child(ctx) {
  return logger.child({ ctx });
}

/** Grava o relatorio final consolidado em logs/relatorio-<timestamp>.json */
function salvarRelatorio(relatorio) {
  const file = path.join(
    config.paths.logs,
    `relatorio-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(file, JSON.stringify(relatorio, replacerErro, 2), 'utf8');
  return file;
}

module.exports = { logger, child, salvarRelatorio, redact };
