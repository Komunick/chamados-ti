' Inicia o notificador de chamados em segundo plano, sem janela visivel.
Dim fso, pasta
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & pasta & "\iniciar-notificador.bat" & Chr(34), 0, False
Set WshShell = Nothing
