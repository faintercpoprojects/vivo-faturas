'use strict';

/**
 * ---------------------------------------------------------------------------
 * Utilitários para o portal MVE, que é construído inteiramente com Web
 * Components e Shadow DOM aberto. Os locators padrão do Playwright NÃO acham
 * esses elementos de forma confiável (o texto fica em shadow aninhado, sem
 * aria-label), então interagimos via page.evaluate percorrendo os shadow roots.
 * ---------------------------------------------------------------------------
 */

// As funções abaixo rodam DENTRO do browser (via page.evaluate). São escritas
// como fábricas de string/execução para poderem ser serializadas.

/** Gera um iterador que percorre todo o DOM incluindo shadow roots. */
function _walkerSource() {
  // Retorna a função como string para injeção — mantém o código em um lugar só.
  return `function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}`;
}

const _visivel = `const __vis = el => !!(el.offsetParent || el.getClientRects().length);`;

/**
 * Conta elementos (clicáveis) visíveis cujo texto/aria casa a regex.
 * @param {import('playwright').Page} page
 */
async function contar(page, regexStr, { tags = ['button', 'a', 'li'] } = {}) {
  return page.evaluate(
    ({ rs, tags }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const re = new RegExp(rs, 'i');
      let n = 0;
      for (const el of __deep(document)) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        if (!tags.includes(tag) && role !== 'button') continue;
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t) && vis(el)) n++;
      }
      return n;
    },
    { rs: regexStr, tags }
  );
}

/**
 * Clica no n-ésimo elemento VISÍVEL cujo texto/aria casa a regex.
 * @returns {Promise<string|null>} texto do elemento clicado, ou null.
 */
async function clicar(page, regexStr, { nth = 0, tags = ['button', 'a', 'li'] } = {}) {
  return page.evaluate(
    ({ rs, nth, tags }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const re = new RegExp(rs, 'i');
      let count = 0;
      for (const el of __deep(document)) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        if (!tags.includes(tag) && role !== 'button') continue;
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t) && vis(el)) {
          if (count++ === nth) { el.scrollIntoView({ block: 'center' }); el.click(); return t.slice(0, 80); }
        }
      }
      return null;
    },
    { rs: regexStr, nth, tags }
  );
}

/** Verifica se existe elemento visível cujo texto casa a regex. */
async function existe(page, regexStr, { tags = ['a', 'button', 'li', 'span', 'p', 'div'] } = {}) {
  return page.evaluate(
    ({ rs, tags }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const re = new RegExp(rs, 'i');
      for (const el of __deep(document)) {
        if (tags.length && !tags.includes(el.tagName.toLowerCase())) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t) && vis(el)) return true;
      }
      return false;
    },
    { rs: regexStr, tags }
  );
}

/** Clica no elemento (visível) cujo className contém o padrão, subindo até um clicável. */
async function clicarPorClasse(page, classePattern) {
  return page.evaluate(
    ({ cp }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const re = new RegExp(cp, 'i');
      for (const el of __deep(document)) {
        if (re.test((el.className || '').toString())) {
          let n = el;
          for (let i = 0; i < 5 && n; i++) {
            if (['button', 'a'].includes(n.tagName.toLowerCase()) || n.getAttribute('role') === 'button') { n.click(); return true; }
            n = n.parentElement;
          }
          el.click();
          return true;
        }
      }
      return false;
    },
    { cp: classePattern }
  );
}

/** Lê o texto (trim) do primeiro elemento cujo className casa o padrão. */
async function textoPorClasse(page, classePattern) {
  return page.evaluate(
    ({ cp }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const re = new RegExp(cp, 'i');
      for (const el of __deep(document)) {
        if (re.test((el.className || '').toString())) return (el.textContent || '').replace(/\s+/g, ' ').trim();
      }
      return null;
    },
    { cp: classePattern }
  );
}

/**
 * Clica no item da lista de empresas (slider) cujo texto contém o CNPJ.
 * Considera apenas itens VISÍVEIS (o slider precisa estar aberto).
 */
async function clicarItemEmpresa(page, cnpjFormatado) {
  return page.evaluate(
    ({ cnpj }) => {
      function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      for (const el of __deep(document)) {
        if (/list-item-wrapper/i.test(el.className || '') && el.getAttribute('role') === 'button') {
          if (vis(el) && (el.textContent || '').includes(cnpj)) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          }
        }
      }
      return null;
    },
    { cnpj: cnpjFormatado }
  );
}

/** Lista os CNPJs presentes no slider de empresas (visíveis ou não). */
async function listarCnpjsSlider(page) {
  return page.evaluate(() => {
    function* __deep(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* __deep(el.shadowRoot);}}
    const re = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
    const out = [];
    for (const el of __deep(document)) {
      if (/list-item-wrapper/i.test(el.className || '') && el.getAttribute('role') === 'button') {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const m = t.match(re);
        if (m) out.push({ cnpj: m[0], texto: t.slice(0, 100) });
      }
    }
    return out;
  });
}

module.exports = {
  contar,
  clicar,
  existe,
  clicarPorClasse,
  textoPorClasse,
  clicarItemEmpresa,
  listarCnpjsSlider,
};
