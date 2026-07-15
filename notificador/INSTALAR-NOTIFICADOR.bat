@echo off
title Instalar notificador no inicio do Windows
REM Cria um atalho na pasta Inicializar do usuario atual: o notificador passa
REM a abrir sozinho (escondido) toda vez que o Windows iniciar.
REM Rode este arquivo NA MAQUINA DE QUEM RECEBE OS CHAMADOS (financeiro).
cd /d "%~dp0"

if not exist "%~dp0config.json" (
  echo Primeiro configure o config.json ^(rode o iniciar-notificador.bat uma vez
  echo para gerar o arquivo de exemplo e edite servidor/login/senha^).
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = New-Object -ComObject WScript.Shell; " ^
  "$lnk = $s.CreateShortcut([IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup\Notificador Chamados de TI.lnk')); " ^
  "$lnk.TargetPath = 'wscript.exe'; " ^
  "$lnk.Arguments = '\"%~dp0notificador-oculto.vbs\"'; " ^
  "$lnk.WorkingDirectory = '%~dp0'; " ^
  "$lnk.Description = 'Notificador de Chamados de TI (avisos na barra de tarefas)'; " ^
  "$lnk.Save()"

echo.
echo Instalado! O notificador vai iniciar junto com o Windows.
echo Iniciando agora em segundo plano...
start "" wscript.exe "%~dp0notificador-oculto.vbs"
echo.
echo Pronto. Pode fechar esta janela.
pause
