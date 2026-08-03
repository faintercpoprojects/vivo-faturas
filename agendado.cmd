@echo off
REM ============================================================
REM Execucao agendada da Automacao Vivo Empresas (a cada 15 dias)
REM Chamado pelo Agendador de Tarefas do Windows (tarefa "VivoFaturas").
REM ============================================================
cd /d "%~dp0"
echo ==== Inicio agendado: %date% %time% ==== >> "logs\agendado.log"
"C:\Program Files\nodejs\node.exe" "%~dp0index.js" --headless >> "logs\agendado.log" 2>&1
echo ==== Fim agendado: %date% %time% (exit %errorlevel%) ==== >> "logs\agendado.log"
