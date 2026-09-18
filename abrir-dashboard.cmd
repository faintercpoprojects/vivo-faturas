@echo off
REM ============================================================
REM ATALHO - Abrir o Dashboard (sem baixar faturas)
REM Sobe o servidor do dashboard (se ainda nao estiver no ar) e
REM abre http://localhost:4599 no navegador. NAO baixa nada.
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
