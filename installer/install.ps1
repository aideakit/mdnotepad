# MD Notepad installer: copies the plugin folder (next to this script) and the mdnotepad.dll that matches Notepad++
# (bin\x64 for 64-bit, bin\x86 for 32-bit) into <Notepad++>\plugins\mdnotepad.
#
#   install.cmd                         double-click; finds Notepad++ by itself
#   install.cmd -NppDir "D:\Tools\npp"  a specific (for example portable) Notepad++
#   install.cmd -Quiet                  no questions (for scripts and AI assistants): stops with a message instead
#
# Exit codes: 0 installed, 1 error, 2 Notepad++ is running (close it and run again), 3 Notepad++ folder not found or
# not unique (pass -NppDir).
#
# Checks: Notepad++ is 64-bit or 32-bit (not ARM64), it is closed, the WebView2 Runtime is present. Asks for administrator rights only when
# the Notepad++ folder is not writable (for example under Program Files). Updating replaces the plugin's files; files
# of an older version that the new one no longer has are removed from plugins\mdnotepad\web.
# Written for Windows PowerShell 5.1 (preinstalled), also runs in PowerShell 7.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$NppDir = '',
    [switch]$Quiet,     # never wait for an answer
    [switch]$Elevated   # set when the script restarts itself as administrator
)
$ErrorActionPreference = 'Stop'
$package = Join-Path $PSScriptRoot 'mdnotepad'
$bin = Join-Path $PSScriptRoot 'bin'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Finish([int]$code) {
    if ($Elevated -and -not $Quiet) { Read-Host 'Press Enter to close this window' | Out-Null }  # its own window would vanish at once
    exit $code
}
function Fail([string]$text, [int]$code = 1) { Say "ERROR: $text" Red; Finish $code }

function Test-NppDir([string]$dir) {
    return $dir -and (Test-Path -LiteralPath (Join-Path $dir 'notepad++.exe'))
}

# Notepad++ folder: the parameter, a running Notepad++, the registry (installer), the default folder; else ask.
function Find-NppDir {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='notepad++.exe'" -ErrorAction SilentlyContinue) {
        if ($p.ExecutablePath) { $candidates.Add((Split-Path $p.ExecutablePath)) }
    }
    foreach ($key in 'HKLM:\SOFTWARE\Notepad++', 'HKCU:\SOFTWARE\Notepad++', 'HKLM:\SOFTWARE\WOW6432Node\Notepad++') {
        $value = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)'
        if ($value) { $candidates.Add($value) }
    }
    $appPath = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\notepad++.exe' -ErrorAction SilentlyContinue).'(default)'
    if ($appPath) { $candidates.Add((Split-Path $appPath.Trim('"'))) }
    $candidates.Add((Join-Path $env:ProgramFiles 'Notepad++'))

    $found = @($candidates | Where-Object { Test-NppDir $_ } | ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\') } | Select-Object -Unique)
    if ($found.Count -eq 1) { return $found[0] }
    if ($found.Count -gt 1) {
        Say 'Several Notepad++ folders were found:'
        for ($i = 0; $i -lt $found.Count; $i++) { Say ("  {0}) {1}" -f ($i + 1), $found[$i]) }
        if ($Quiet) { Fail 'choose one with -NppDir "<folder>".' 3 }
        $choice = Read-Host 'Number of the one to install into'
        $n = 0
        if ([int]::TryParse($choice, [ref]$n) -and $n -ge 1 -and $n -le $found.Count) { return $found[$n - 1] }
        Fail 'no folder chosen.'
    }
    if ($Quiet) { Fail 'Notepad++ was not found; pass -NppDir "<folder that contains notepad++.exe>".' 3 }
    $typed = Read-Host 'Notepad++ was not found. Folder that contains notepad++.exe'
    if (Test-NppDir $typed) { return $typed.TrimEnd('\') }
    Fail "notepad++.exe not found in '$typed'."
}

function Get-ExeMachine([string]$exe) {
    $stream = [System.IO.File]::OpenRead($exe)
    try {
        $reader = New-Object System.IO.BinaryReader($stream)
        $stream.Position = 0x3C
        $stream.Position = $reader.ReadInt32() + 4
        return $reader.ReadUInt16()
    } finally { $stream.Dispose() }
}

# Creates the plugin folder and opens one of the plugin's own files for writing (nothing is changed or removed).
function Test-Writable([string]$dir) {
    try {
        [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        $stream = [System.IO.File]::Open((Join-Path $dir 'LICENSE'), 'OpenOrCreate', 'Write', 'ReadWrite')
        $stream.Dispose()
        return $true
    } catch [System.UnauthorizedAccessException] {
        return $false
    } catch {
        return $true  # e.g. a file locked by a running Notepad++: that is checked below
    }
}

function Test-WebView2 {
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id",
                     "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id") {
        $pv = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).pv
        if ($pv -and $pv -ne '0.0.0.0') { return $pv }
    }
    return $null
}

function Get-RunningNpp([string]$dir) {
    $exe = Join-Path $dir 'notepad++.exe'
    # a Notepad++ started as administrator hides its path from a normal process; count it as possibly this one
    return @(Get-CimInstance Win32_Process -Filter "Name='notepad++.exe'" -ErrorAction SilentlyContinue |
        Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -ieq $exe })
}

# ---------------------------------------------------------------------------- checks

if (-not (Test-Path -LiteralPath (Join-Path $package 'web\index.html')) -or -not (Test-Path -LiteralPath $bin)) {
    Fail "the plugin files next to '$PSCommandPath' are missing. Unpack the whole archive and run install.cmd from it."
}
if ($NppDir) {
    if (-not (Test-NppDir $NppDir)) { Fail "notepad++.exe not found in '$NppDir'." }
    $NppDir = (Resolve-Path -LiteralPath $NppDir).Path.TrimEnd('\')
} else {
    $NppDir = Find-NppDir
}
Say "Notepad++: $NppDir"

$machine = Get-ExeMachine (Join-Path $NppDir 'notepad++.exe')
$arch = switch ($machine) { 0x8664 { 'x64' } 0x14C { 'x86' } default { '' } }
if (-not $arch) { Fail ('this Notepad++ is for ARM64 or another processor (machine 0x{0:X}); MD Notepad supports 64-bit (x64) and 32-bit (x86) Notepad++.' -f $machine) }
$dll = Join-Path $bin "$arch\mdnotepad.dll"
if (-not (Test-Path -LiteralPath $dll)) { Fail "'$dll' is missing. Unpack the whole archive and run install.cmd from it." }
Say "Notepad++ type: $(if ($arch -eq 'x64') { '64-bit' } else { '32-bit' })"

$webView2 = Test-WebView2
if ($webView2) {
    Say "WebView2 Runtime: $webView2"
} else {
    Say 'WARNING: the Microsoft Edge WebView2 Runtime was not found; the preview will not start without it.' Yellow
    Say '         Get it from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Runtime).' Yellow
}

$plugins = Join-Path $NppDir 'plugins'
$target = Join-Path $plugins 'mdnotepad'
if (-not (Test-Writable $target)) {
    if ($Elevated) { Fail "no write access to '$plugins' even as administrator." }
    Say 'The Notepad++ folder needs administrator rights; Windows will ask for them.' Yellow
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-NppDir', "`"$NppDir`"", '-Elevated')
    if ($Quiet) { $arguments += '-Quiet' }
    try {
        $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    } catch { Fail 'administrator rights were not given; nothing was installed.' }
    exit $child.ExitCode
}

while (@(Get-RunningNpp $NppDir).Count -gt 0) {
    if ($Quiet) { Fail 'Notepad++ is running. Save your files, close Notepad++ and run the installer again.' 2 }
    Say 'Notepad++ is running. Save your files, close Notepad++, then press Enter (or type q to cancel).' Yellow
    if ((Read-Host) -eq 'q') { Fail 'cancelled; nothing was installed.' }
}

# ---------------------------------------------------------------------------- copy

$update = (Test-Path -LiteralPath (Join-Path $target 'mdnotepad.dll'))
try {
    if ($PSCmdlet.ShouldProcess($target, 'Copy plugin files')) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        # the shared files, then the DLL of the right type (a DLL in the shared folder, e.g. from an old build, is skipped)
        Get-ChildItem -LiteralPath $package | Where-Object { $_.Name -ne 'mdnotepad.dll' } |
            Copy-Item -Destination $target -Recurse -Force
        Copy-Item -LiteralPath $dll -Destination (Join-Path $target 'mdnotepad.dll') -Force
    }
} catch {
    Fail "copying failed: $($_.Exception.Message)"
}

# files of an older version that this one does not have (the preview's script parts have versioned names)
$oldWeb = Join-Path $target 'web'
if (Test-Path -LiteralPath $oldWeb) {
    $keep = @{}
    Get-ChildItem -LiteralPath (Join-Path $package 'web') -Recurse -File | ForEach-Object {
        $keep[$_.FullName.Substring($package.Length).ToLowerInvariant()] = $true
    }
    Get-ChildItem -LiteralPath $oldWeb -Recurse -File | Where-Object {
        -not $keep.ContainsKey($_.FullName.Substring($target.Length).ToLowerInvariant())
    } | ForEach-Object {
        if ($PSCmdlet.ShouldProcess($_.FullName, 'Remove file of the previous version')) { Remove-Item -LiteralPath $_.FullName -Force }
    }
}

if ($update) { Say "Updated: $target" Green } else { Say "Installed: $target" Green }
Say 'Start Notepad++ and click the "mn" button on the toolbar, or Plugins > MD Notepad > Show/hide preview panel (Ctrl+Alt+Shift+M).'
Finish 0
