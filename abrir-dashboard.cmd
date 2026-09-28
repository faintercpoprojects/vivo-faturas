@echo off
REM ============================================================
REM ATALHO - Abrir o Dashboard (sincroniza com o Vivo ao abrir)
REM Sobe o servidor do dashboard (se ainda nao estiver no ar) e
REM abre http://localhost:4599. Ao subir, o servidor baixa os PDFs e
REM atualiza o status no Vivo em segundo plano (AUTO_SYNC=false desliga).
REM ============================================================
setlocal
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"

REM Sobe o dashboard numa janela propria. Se ja estiver rodando,
REM esta instancia apenas fecha (porta ocupada) e usamos a que ja existe.
start "Dashboard Vivo" /min "%NODE%" "%~dp0dashboard\server.js"
timeout /t 3 >nul
start "" "http://localhost:4599"

endlocal
