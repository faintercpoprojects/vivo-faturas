@echo off
REM ============================================================
REM Execucao agendada da Automacao Vivo Empresas (a cada 10 dias).
REM Ingestao completa: todas as empresas (menos as ignoradas), Movel+Fixo,
REM todas as paginas, incluindo pagas -> baixa PDFs e grava no banco SQLite
REM (que alimenta o dashboard do financeiro). Chamado pela tarefa "VivoFaturas".
REM No fim, envia ao Google Drive os PDFs que ainda nao estao la.
REM ============================================================
cd /d "%~dp0"
echo ==== Inicio agendado: %date% %time% ==== >> "logs\agendado.log"
"C:\Program Files\nodejs\node.exe" "%~dp0operadoras.js" --headless >> "logs\agendado.log" 2>&1
"C:\Program Files\nodejs\node.exe" "%~dp0index.js" --todos-cnpj --incluir-pagas --headless --no-upload >> "logs\agendado.log" 2>&1
"C:\Program Files\nodejs\node.exe" "%~dp0scripts\sincronizar-drive.js" >> "logs\agendado.log" 2>&1
echo ==== Fim agendado: %date% %time% (exit %errorlevel%) ==== >> "logs\agendado.log"
