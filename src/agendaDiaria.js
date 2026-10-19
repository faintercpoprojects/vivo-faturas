'use strict';

/**
 * Coleta diária automática (padrão 08:00): baixa as contas de todas as
 * operadoras, atualiza o status, envia os PDFs ao Drive e atualiza o
 * dashboard online — o mesmo que o botão "Baixar contas".
 *
 *  - Roda uma vez por dia, a partir do horário (se o computador estava
 *    desligado/dormindo às 8h, roda assim que ele voltar).
 *  - Qualquer "Baixar contas" completo e bem-sucedido feito depois das 8h já
 *    conta como a coleta do dia (não repete à toa).
 *  - Se falhar, tenta de novo (até 3 vezes no dia, a cada 30 min).
 *
 * Estado em .state/coleta-diaria.json. Horário: COLETA_DIARIA=08:00 no .env
 * (COLETA_DIARIA=false desliga).
 */
const fs = require('fs');
const path = require('path');

const MAX_TENTATIVAS = 3;
const INTERVALO_TENTATIVAS_MS = 30 * 60 * 1000;

function criarAgendaDiaria({ arquivoEstado, hora = '08:00', disparar, log = console.log, agora = () => new Date() }) {
  const [hh, mm] = String(hora).split(':').map(Number);
  const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ler = () => { try { return JSON.parse(fs.readFileSync(arquivoEstado, 'utf8')); } catch { return {}; } };
  const gravar = (e) => { fs.mkdirSync(path.dirname(arquivoEstado), { recursive: true }); fs.writeFileSync(arquivoEstado, JSON.stringify(e, null, 2)); };
  const passouDoHorario = (d) => d.getHours() > hh || (d.getHours() === hh && d.getMinutes() >= mm);
  let ocupado = false;

  /** Chamado ao fim de QUALQUER coleta completa: se deu certo depois do horário, vale como a do dia. */
  function registrarColetaCompleta(ok) {
    const d = agora();
    if (!ok || !passouDoHorario(d)) return;
    const e = ler();
    if (e.dia === diaLocal(d) && e.ok) return;
    gravar({ ...e, dia: diaLocal(d), ok: true, concluidaEm: d.toISOString() });
  }

  async function tick() {
    const d = agora();
    if (ocupado || !passouDoHorario(d)) return null;
    let e = ler();
    const hoje = diaLocal(d);
    if (e.dia !== hoje) e = { dia: hoje, tentativas: 0, ok: false };
    if (e.ok || e.tentativas >= MAX_TENTATIVAS) return null;
    if (e.ultimaTentativa && d - new Date(e.ultimaTentativa) < INTERVALO_TENTATIVAS_MS) return null;

    ocupado = true;
    e.tentativas += 1;
    e.ultimaTentativa = d.toISOString();
    gravar(e);
    log(`Coleta diária (${hora}): tentativa ${e.tentativas}/${MAX_TENTATIVAS} — iniciando.`);
    try {
      const codigo = await disparar();
      const ok = codigo === 0 || codigo === 1;
      const atual = { ...ler(), dia: hoje };
      if (ok) { atual.ok = true; atual.concluidaEm = agora().toISOString(); }
      atual.ultimoCodigo = codigo;
      gravar(atual);
      log(`Coleta diária: ${ok ? 'concluída' : `falhou (código ${codigo})`}.`);
      return codigo;
    } catch (err) {
      log(`Coleta diária: erro — ${err.message}`);
      return -1;
    } finally {
      ocupado = false;
    }
  }

  /** Já houve coleta completa bem-sucedida hoje (depois do horário)? */
  function concluidaHoje() { const e = ler(); return e.dia === diaLocal(agora()) && !!e.ok; }

  return { tick, registrarColetaCompleta, concluidaHoje, iniciar: (ms = 60 * 1000) => { setTimeout(tick, 15000); return setInterval(tick, ms); } };
}

module.exports = { criarAgendaDiaria };
