' In_Fate desktop launcher.
' Runs run.mjs hidden so Explorer shortcuts never leave a console window,
' and run.mjs strips ELECTRON_RUN_AS_NODE before starting Electron.
Option Explicit

Dim fso, shell, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
shell.Run "node run.mjs", 0, False
