'use strict';

const fsp = require('fs/promises');
const pdfParse = require('pdf-parse');

/** "1.311,56" -> 1311.56 */
function numero(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "17/09/2026" -> "2026-09-17" (ISO, ordenável) */
function isoData(br) {
  const m = String(br || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Extrai os campos financeiros de uma FATURA Vivo em PDF.
 * Boletos costumam ser digitalizados (sem texto) — retornam campos nulos.
 * @param {string} arquivo caminho do PDF
 * @returns {Promise<{numeroDocumento:string|null, dataEmissao:string|null,
 *                    dataVencimento:string|null, valor:number|null}>}
 */
async function extrairCamposFatura(arquivo) {
  let flat = '';
  try {
    const d = await pdfParse(await fsp.readFile(arquivo), { max: 0 });
    flat = String(d.text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return { numeroDocumento: null, dataEmissao: null, dataVencimento: null, valor: null };
  }

  const venc =
    (flat.match(/vencimento[^0-9]{0,25}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    (flat.match(/vencto[^0-9]{0,15}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    (flat.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1] ||
    null;

  const emissao =
    (flat.match(/emiss[aã]o[^0-9]{0,20}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    (flat.match(/data\s+de\s+emiss[aã]o[^0-9]{0,20}(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    null;

  // TOTAL A PAGAR é o valor definitivo da fatura (NÃO o "Subtotal", que é parcial).
  // Ex.: "TOTAL A PAGAR159,96" / "TOTAL A PAGAR: 159,96" / "VALOR TOTAL NF159,96".
  const dinheiro = '(\\d{1,3}(?:\\.\\d{3})*,\\d{2})';
  const valor =
    numero((flat.match(new RegExp('total\\s*a\\s*pagar\\s*:?\\s*r?\\$?\\s*' + dinheiro, 'i')) || [])[1]) ||
    numero((flat.match(new RegExp('valor\\s*total\\s*nf\\s*:?\\s*r?\\$?\\s*' + dinheiro, 'i')) || [])[1]) ||
    numero((flat.match(new RegExp('valor\\s*(?:do\\s*documento|cobrado)\\s*:?\\s*r?\\$?\\s*' + dinheiro, 'i')) || [])[1]) ||
    null;

  const numeroDocumento =
    (flat.match(/(?:n[ºo.]?\s*(?:da\s*)?(?:fatura|documento|nota\s*fiscal|nf-?e?)|documento\s*n[ºo])[^0-9]{0,12}(\d[\d.\-/]{4,})/i) || [])[1] ||
    null;

  return { numeroDocumento, dataEmissao: isoData(emissao), dataVencimento: isoData(venc), valor };
}

module.exports = { extrairCamposFatura, isoData, numero };
