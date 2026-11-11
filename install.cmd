@echo off
rem Installs MD Notepad into Notepad++ from a clone of this repository.
rem   If you built the plugin yourself (build.ps1), the build in dist\ is installed;
rem   otherwise the latest release is downloaded from GitHub (checked by SHA-256) and installed.
rem Options: -NppDir "<Notepad++ folder>"   -Quiet (no questions)
setlocal
rem a PSModulePath inherited from PowerShell 7 breaks Windows PowerShell's own modules
set "PSModulePath="
if exist "%~dp0dist\install.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dist\install.ps1" %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\get.ps1" %*
)
set code=%errorlevel%
echo %* | find /i "-quiet" >nul || (echo. & pause)
exit /b %code%
