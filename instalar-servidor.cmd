@echo off
REM Duplo clique: instala o dashboard para subir ao ligar o PC (pede admin e a senha do Windows).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-servidor.ps1"
