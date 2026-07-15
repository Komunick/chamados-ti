@echo off
title Instalar auto-inicio - Chamados de TI
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\instalar-autostart.ps1"
echo.
echo Pronto. Pode fechar esta janela.
pause
