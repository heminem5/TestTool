' Launch the TestTool tray with no console window at all.
'
' Why this exists: a shortcut (.lnk) or a .cmd always flashes a console window
' when the target is a console program like pwsh.exe, because Windows creates
' the console before the program gets a chance to hide it. WScript.Shell.Run
' with 0 as the second argument tells Windows not to create the window in the
' first place - no flash, nothing to accidentally close.
'
' Path is resolved from the script's own location, so it stays correct if you
' move the folder. The file name contains Chinese characters; VBScript handles
' paths as Unicode so that is fine - it is the .cmd/cmd.exe path that breaks.

Dim fso, shell, here, script

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\tray.ps1"

shell.Run "pwsh.exe -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
