@echo off
rem Double-click this to start TestTool with a tray icon.
rem It launches PowerShell hidden, so no console window stays open.
rem The tray script itself enforces single-instance - running this twice
rem just shows a "already running" message instead of starting a second copy.

start "" pwsh.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tray.ps1"
