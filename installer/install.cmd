@echo off
rem MD Notepad installer: double-click, or run "install.cmd -NppDir <Notepad++ folder>" / "install.cmd -Quiet".
setlocal
rem a PSModulePath inherited from PowerShell 7 breaks Windows PowerShell's own modules
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%errorlevel%
echo %* | find /i "-quiet" >nul || (echo. & pause)
exit /b %code%
