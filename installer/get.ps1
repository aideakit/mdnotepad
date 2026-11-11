# Downloads an MD Notepad release from GitHub, checks its SHA-256 and runs the install.ps1 inside it.
#
#   irm https://raw.githubusercontent.com/aideakit/mdnotepad/main/installer/get.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/aideakit/mdnotepad/main/installer/get.ps1))) -Quiet
#   powershell -ExecutionPolicy Bypass -File get.ps1 [-NppDir <folder>] [-Quiet] [-Version 1.0.1] [-ZipPath <local zip>]
#
# -Quiet, -NppDir: passed to install.ps1 (see there; exit codes 2 = Notepad++ is running, 3 = folder not found).
# -ZipPath: install from an already downloaded MDNotepad-<version>.zip instead of downloading.
# The archive holds the plugin for 64-bit and 32-bit Notepad++ (releases before 1.0.1: MDNotepad-<version>-x64.zip).
# The download goes to a new folder in %TEMP% and is left there.
# Written for Windows PowerShell 5.1 (preinstalled), also runs in PowerShell 7.
param(
    [string]$NppDir = '',
    [switch]$Quiet,
    [string]$Version = 'latest',
    [string]$ZipPath = '',
    [string]$ApiBase = 'https://api.github.com'   # only for testing with a local copy of the release API
)
$ErrorActionPreference = 'Stop'
$repo = 'aideakit/mdnotepad'
# Hashing and unpacking use .NET directly: the matching cmdlets live in modules that fail to load when Windows
# PowerShell inherits PowerShell 7's PSModulePath (for example when started from a pwsh session).
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256([string]$path) {
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $stream.Dispose() }
}

function Install-MdNotepad {
    if (-not $ZipPath) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $headers = @{ 'User-Agent' = 'mdnotepad-installer'; 'Accept' = 'application/vnd.github+json' }
        $api = if ($Version -eq 'latest') { "$ApiBase/repos/$repo/releases/latest" } else { "$ApiBase/repos/$repo/releases/tags/v$Version" }
        Write-Host "Looking up the MD Notepad release ($Version)..."
        try { $release = Invoke-RestMethod -Uri $api -Headers $headers } catch {
            Write-Host "ERROR: cannot read $api : $($_.Exception.Message)" -ForegroundColor Red
            return 1
        }
        if ($release -is [string]) { $release = $release | ConvertFrom-Json }
        # case-sensitive: the plugin list archives are named mdnotepad-<version>-<arch>-plugins-admin.zip
        $asset = @($release.assets | Where-Object { $_.name -cmatch '^MDNotepad-\d+\.\d+\.\d+\.zip$' }) +
            @($release.assets | Where-Object { $_.name -cmatch '^MDNotepad-\d+\.\d+\.\d+-x64\.zip$' }) | Select-Object -First 1
        if (-not $asset) {
            Write-Host "ERROR: release $($release.tag_name) has no MDNotepad-<version>.zip file." -ForegroundColor Red
            return 1
        }
        $work = Join-Path $env:TEMP ("mdnotepad-" + $release.tag_name + "-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $work | Out-Null
        $zip = Join-Path $work $asset.name
        Write-Host "Downloading $($asset.name)..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -Headers @{ 'User-Agent' = 'mdnotepad-installer' }

        $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
        if ($sums) {
            $text = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing -Headers @{ 'User-Agent' = 'mdnotepad-installer' }).Content
            if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
            $line = ($text -split "`n") | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($asset.name) + '\s*$') } | Select-Object -First 1
            $expected = if ($line) { ($line -split '\s+')[0].ToLowerInvariant() } else { '' }
            $actual = Get-Sha256 $zip
            if (-not $expected -or $expected -ne $actual) {
                Write-Host "ERROR: checksum mismatch for $($asset.name) (expected '$expected', got '$actual'). Nothing was installed." -ForegroundColor Red
                return 1
            }
            Write-Host 'Checksum OK.'
        } else {
            Write-Host 'WARNING: the release has no SHA256SUMS.txt; the download was not checked.' -ForegroundColor Yellow
        }
    } else {
        $zip = (Resolve-Path -LiteralPath $ZipPath).Path
        $work = Join-Path $env:TEMP ("mdnotepad-local-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $work | Out-Null
    }

    $unpacked = Join-Path $work 'package'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
    $installer = Join-Path $unpacked 'install.ps1'
    if (-not (Test-Path -LiteralPath $installer)) {
        Write-Host "ERROR: $zip does not contain install.ps1." -ForegroundColor Red
        return 1
    }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer)
    if ($NppDir) { $arguments += @('-NppDir', $NppDir) }
    if ($Quiet) { $arguments += '-Quiet' }
    & powershell.exe @arguments | Out-Host   # its output is shown, not returned
    return $LASTEXITCODE
}

$code = Install-MdNotepad
# "exit" would close the window when this script runs through "irm ... | iex"; only a script file exits
if ($PSCommandPath) { exit $code }
$global:LASTEXITCODE = $code
