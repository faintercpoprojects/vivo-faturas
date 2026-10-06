@echo off
REM ============================================================
REM Servidor do Dashboard (usado pela tarefa "DashboardVivo").
REM Sobe o dashboard em http://localhost:4599 e grava a saida em
REM logs\servidor.log. Ao subir, sincroniza com as operadoras.
REM ============================================================
cd /d "%~dp0"
if not exist logs mkdir logs
echo ==== Servidor iniciado: %date% %time% ==== >> "logs\servidor.log"
"C:\Program Files\nodejs\node.exe" "%~dp0dashboard\server.js" >> "logs\servidor.log" 2>&1
echo ==== Servidor parou: %date% %time% (exit %errorlevel%) ==== >> "logs\servidor.log"
exit /b %errorlevel%
