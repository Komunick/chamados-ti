@echo off
title Chamados de TI - Servidor (Node, porta 8085)
cd /d "%~dp0"
set PORT=8085
set HOST=0.0.0.0

:loop
echo [%date% %time%] Iniciando servidor Node na porta %PORT% >> server.log
"C:\Program Files\nodejs\node.exe" "%~dp0server\server.js" >> server.log 2>&1
echo [%date% %time%] Servidor encerrou (codigo %errorlevel%); reiniciando em 5s... >> server.log
ping -n 6 127.0.0.1 >nul 2>&1
goto loop
