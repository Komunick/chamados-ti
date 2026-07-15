# Configura o servidor de Chamados de TI para subir sozinho no boot.
# Execute pelo INSTALAR-AUTOINICIO.bat (que pede elevacao). Requer admin.
$ErrorActionPreference = 'Stop'
$bat = Join-Path (Split-Path $PSScriptRoot -Parent) 'start-server.bat'

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f $bat)
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'ChamadosTIWeb' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Servidor de Chamados de TI (Brazil Transports, porta 8085, acesso via ZeroTier). Sobe no boot.' -Force | Out-Null
Write-Host ''
Write-Host 'Auto-inicio configurado: o servidor de Chamados de TI subira sozinho a cada boot.' -ForegroundColor Green

Get-NetTCPConnection -LocalPort 8085 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName 'ChamadosTIWeb'
Start-Sleep -Seconds 2
$c = Get-NetTCPConnection -LocalPort 8085 -State Listen -ErrorAction SilentlyContinue
if ($c) { Write-Host ('Servidor no ar (PID {0}).' -f ($c.OwningProcess | Select-Object -First 1)) -ForegroundColor Green }
else { Write-Host 'Atencao: o servidor nao subiu; verifique ti-web\server.log.' -ForegroundColor Yellow }
