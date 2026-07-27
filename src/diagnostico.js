'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { logger } = require('./logger');

/**
 * Faz um dump (atravessando shadow DOM) dos elementos interativos e de tudo que
 * pareça conter CNPJ / "contrato" na página atual. Usado para descobrir os
 * seletores reais do MVE sem depender de inspeção manual.
 *
 * @param {import('playwright').Page} page
 * @param {string} rotulo  nome do arquivo de saída
 */
async function dumpDashboard(page, rotulo = 'dashboard') {
  const dump = await page.evaluate(() => {
    const out = { interativos: [], comCNPJ: [], titulo: document.title, url: location.href };
    const cnpjRe = /\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}/;

    const texto = (el) =>
      ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 70);

    const seletor = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      dtid: (el.getAttribute && el.getAttribute('data-testid')) || null,
      aria: (el.getAttribute && el.getAttribute('aria-label')) || null,
      role: (el.getAttribute && el.getAttribute('role')) || null,
      cls: (el.className || '').toString().slice(0, 60),
    });

    function walk(root, depth) {
      if (depth > 15) return;
      let els;
      try { els = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of els) {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const role = el.getAttribute && el.getAttribute('role');
        if (['button', 'a', 'select'].includes(tag) || role === 'button' || role === 'combobox') {
          const t = texto(el);
          out.interativos.push({ ...seletor(el), text: t });
        }
        const ownText =
          (el.childNodes && [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')) || '';
        if (cnpjRe.test(ownText)) {
          out.comCNPJ.push({ ...seletor(el), text: ownText.replace(/\s+/g, ' ').trim().slice(0, 90) });
        }
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    }
    walk(document, 0);

    const vistos = new Set();
    out.interativos = out.interativos
      .filter((i) => i.text)
      .filter((i) => {
        const k = i.tag + i.text + (i.aria || '') + (i.dtid || '');
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      })
      .slice(0, 80);
    out.comCNPJ = out.comCNPJ.slice(0, 50);
    return out;
  });

  const file = path.join(config.paths.logs, `inspecao-${rotulo}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');

  logger.info(`[diagnóstico] ${dump.titulo} | ${dump.url}`);
  logger.info(`[diagnóstico] Elementos com CNPJ: ${dump.comCNPJ.length} | Interativos: ${dump.interativos.length}`);
  logger.info(`[diagnóstico] Dump salvo em ${file}`);
  return { dump, file };
}

module.exports = { dumpDashboard };
