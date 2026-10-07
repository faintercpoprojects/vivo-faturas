@echo off
REM ============================================================
REM ATALHO MANUAL - Automacao Vivo Empresas
REM Baixa as faturas/boletos do mes (todas as empresas, menos as
REM ignoradas, Movel + Fixo, todas as paginas) e ABRE o dashboard.
REM No fim, envia ao Google Drive os PDFs que ainda nao estao la.
REM ============================================================
setlocal
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"

echo.
echo ====================================================
echo   Baixando faturas do mes... (pode levar alguns min)
echo ====================================================
"%NODE%" "%~dp0operadoras.js" --headless
"%NODE%" "%~dp0index.js" --todos-cnpj --incluir-pagas --headless --no-upload
"%NODE%" "%~dp0scripts\sincronizar-drive.js"

echo.
echo ====================================================
echo   Abrindo o dashboard em http://localhost:4599
echo ====================================================
REM Sobe o dashboard numa janela propria. Se ja estiver rodando,
REM esta instancia apenas fecha (porta ocupada) e usamos a que ja existe.
start "Dashboard Vivo" /min "%NODE%" "%~dp0dashboard\server.js"
timeout /t 3 >nul
start "" "http://localhost:4599"

endlocal
