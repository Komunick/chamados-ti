@echo off
title Notificador de Chamados de TI
cd /d "%~dp0"

:loop
"C:\Program Files\nodejs\node.exe" "%~dp0notificador.js"
echo [%date% %time%] Notificador encerrou (codigo %errorlevel%); reiniciando em 10s... >> notificador.log
ping -n 11 127.0.0.1 >nul 2>&1
goto loop
