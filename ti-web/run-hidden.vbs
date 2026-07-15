' Inicia o servidor de Chamados de TI em segundo plano, sem janela visivel.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run Chr(34) & pasta & "\start-server.bat" & Chr(34), 0, False
Set WshShell = Nothing
