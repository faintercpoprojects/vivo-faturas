'use strict';
// Teste das regras da coleta diária com relógio simulado.  node scripts/teste-agenda-diaria.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { criarAgendaDiaria } = require('../src/agendaDiaria');

let falhas = 0;
const ok = (c, n) => { console.log(`${c ? 'OK    ' : 'FALHOU'} ${n}`); if (!c) falhas++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-'));
  let relogio = new Date(2026, 9, 20, 7, 50);           // 20/10 07:50
  let resultado = 0, execucoes = 0;
  const ag = criarAgendaDiaria({
    arquivoEstado: path.join(dir, 'estado.json'), hora: '08:00', log: () => {},
    agora: () => relogio, disparar: async () => { execucoes++; return resultado; },
  });
  const em = (h, m, dia = 20) => { relogio = new Date(2026, 9, dia, h, m); };

  await ag.tick(); ok(execucoes === 0, 'antes das 8h: não roda');
  em(8, 0); await ag.tick(); ok(execucoes === 1, 'às 8h: roda');
  em(8, 40); await ag.tick(); em(15, 0); await ag.tick(); ok(execucoes === 1, 'já rodou com sucesso hoje: não repete');

  em(8, 1, 21); resultado = 2; await ag.tick(); ok(execucoes === 2, 'dia seguinte: roda de novo');
  em(8, 20, 21); await ag.tick(); ok(execucoes === 2, 'falhou: espera 30 min antes de tentar de novo');
  em(8, 32, 21); await ag.tick(); ok(execucoes === 3, 'falhou: 2ª tentativa após 30 min');
  em(9, 5, 21); await ag.tick(); ok(execucoes === 4, '3ª tentativa');
  em(10, 0, 21); await ag.tick(); ok(execucoes === 4, 'no máximo 3 tentativas por dia');

  em(14, 0, 22); resultado = 0; await ag.tick(); ok(execucoes === 5, 'computador ligado só às 14h: roda assim que liga');

  em(9, 0, 23); ag.registrarColetaCompleta(true); await ag.tick();
  ok(execucoes === 5, '"Baixar contas" manual bem-sucedido depois das 8h conta como a coleta do dia');
  em(7, 30, 24); ag.registrarColetaCompleta(true); em(8, 5, 24); await ag.tick();
  ok(execucoes === 6, 'coleta manual ANTES das 8h não substitui a das 8h');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
  process.exit(falhas ? 1 : 0);
})();
