'use strict';

/**
 * Leitura dos cards de Vivo Fixo na "Central de faturas" (layout de out/2026):
 *
 *   VIVO FIXO
 *   Endereço           Valor        Paga ⓘ          [Baixar agora] [Ver detalhes]
 *   R Herminio Pin...  R$ 79,99     Set/2026
 *   Código do cliente  899926836257
 *
 * O card não traz mais a data de vencimento completa — só o status e o
 * mês/ano. Os textos ficam espalhados em Web Components (shadow DOM), então
 * coletamos todos os textos visíveis com a posição e agrupamos por card,
 * de um título "VIVO FIXO" até o próximo.
 *
 * Roda dentro de page.evaluate (sem dependências externas).
 */
function lerCardsFixoNaPagina() {
  const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  const textos = [];
  const visitar = (raiz) => {
    const w = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.currentNode; n; n = w.nextNode()) {
      if (n.nodeType === 1 && n.shadowRoot) visitar(n.shadowRoot);
      if (n.nodeType !== 3) continue;
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      textos.push({ t, x: r.left, y: r.top + window.scrollY, cor: cs.color });
    }
  };
  visitar(document.body);

  const titulos = textos.filter((o) => /^VIVO FIXO$/i.test(o.t)).sort((a, b) => a.y - b.y);
  const cards = [];
  titulos.forEach((tit, i) => {
    const fim = i + 1 < titulos.length ? titulos[i + 1].y : tit.y + 400;
    const dentro = textos.filter((o) => o.y >= tit.y - 2 && o.y < fim - 2).sort((a, b) => a.y - b.y || a.x - b.x);
    const junto = dentro.map((o) => o.t).join(' | ');
    const valor = (junto.match(/R\$\s*([\d.]+,\d{2})/) || [])[1] || null;
    const mesAno = junto.match(/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*\/\s*(\d{4})\b/i);
    // Só aceita data que aparece sozinha no card — o painel "Download de
    // arquivos" (sobreposto) tem textos como "0320992391 - 17/10/2026 - Boleto".
    const dataCompleta = (dentro.find((o) => /^\d{2}\/\d{2}\/\d{4}$/.test(o.t)) || {}).t || null;
    const codigo = (junto.match(/C[óo]digo do cliente\s*\|?\s*(\d{6,})/i) || [])[1] || null;
    const endereco = (() => {
      const i2 = dentro.findIndex((o) => /^Endere[çc]o$/i.test(o.t));
      if (i2 < 0) return null;
      const prox = dentro.slice(i2 + 1).find((o) => o.y > dentro[i2].y + 5);
      return prox ? prox.t : null;
    })();
    // Status: rótulo curto do card (Paga / A vencer / Vencida / Atrasada / Pronta pra pagar / Em aberto...).
    const rot = dentro.map((o) => o.t).find((t) => /^(paga|pago|quitad[ao]|liquidad[ao]|a vencer|vencid[ao]|atrasad[ao]|em atraso|pronta? pr?a pagar|em aberto|aberta|pendente|pagar at[eé].*|em processamento|processando)$/i.test(t)) || null;
    const st = (rot || '').toLowerCase();
    const paga = /^(paga|pago|quitad|liquidad)/.test(st);
    const status = paga ? 'Paga' : /vencid|atrasad|atraso/.test(st) ? 'Atrasada' : rot ? 'Pendente' : 'desconhecido';
    cards.push({
      y: tit.y - window.scrollY,
      valor,
      mes: mesAno ? MESES[mesAno[1].toLowerCase().slice(0, 3)] : null,
      ano: mesAno ? Number(mesAno[2]) : null,
      vencimento: dataCompleta, // o layout novo normalmente não traz; mantido se aparecer
      codigoCliente: codigo,
      endereco,
      rotuloStatus: rot,
      status,
      paga,
    });
  });
  return cards.filter((c) => c.valor);
}

module.exports = { lerCardsFixoNaPagina };
