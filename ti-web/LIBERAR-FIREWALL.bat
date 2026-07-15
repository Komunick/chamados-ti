@echo off
title Liberar firewall - Chamados de TI (porta 8085)
REM Pede elevacao (UAC) se ainda nao estiver como administrador.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -Command ^
  "Get-NetFirewallRule -DisplayName 'Chamados TI 8085' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; " ^
  "New-NetFirewallRule -DisplayName 'Chamados TI 8085' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8085 -RemoteAddress '10.13.47.0/24' -Profile Any | Out-Null; " ^
  "Write-Host 'Porta 8085 liberada somente para a rede ZeroTier (10.13.47.0/24).'"
pause
