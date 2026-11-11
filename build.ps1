# Builds the plugin into dist\ (x64 only):
#   dist\mdnotepad\                                the plugin folder (mdnotepad.dll + web\)
#   dist\MDNotepad-<version>-x64.zip               for people: mdnotepad\ + install.cmd + install.ps1
#   dist\mdnotepad-<version>-x64-plugins-admin.zip for the Notepad++ plugin list (mdnotepad.dll at the zip root)
#   dist\SHA256SUMS.txt, dist\pl.x64-entry.json    checksums; the entry for src/pl.x64.json of nppPluginList
#
#   pwsh -File build.ps1 [-VcVars <path to vcvars64.bat>] [-Install [-NppDir <Notepad++ folder>]]
# Needs Node.js (npm) and Visual Studio Build Tools with the C++ workload and a Windows SDK.
# First run installs the npm packages and downloads the Microsoft.Web.WebView2 NuGet package (pinned, checked by SHA-256).
# The version comes from package.json; $repository below is used in the plugin list entry.
param(
    [string]$VcVars = '',
    [switch]$Install,      # then install the result into Notepad++ (dist\install.ps1)
    [string]$NppDir = ''
)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webView2Version = '1.0.4314.35'
$webView2Sha256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$thirdParty = Join-Path $root 'third_party'
$wv2Dir = Join-Path $thirdParty "webview2-$webView2Version"
$out = Join-Path $root 'dist\mdnotepad'
$web = Join-Path $out 'web'
$obj = Join-Path $root 'build'
$repository = 'https://github.com/aideakit/mdnotepad'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "package.json version must be x.y.z: $version" }
$verDefines = "/d VER_MAJOR=$($Matches[1]) /d VER_MINOR=$($Matches[2]) /d VER_PATCH=$($Matches[3])"
New-Item -ItemType Directory -Force $web, $obj, $thirdParty | Out-Null

# --- 1. npm packages
if (-not (Test-Path (Join-Path $root 'node_modules\.bin\esbuild.cmd'))) {
    Push-Location $root
    try { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } } finally { Pop-Location }
}

# --- 2. WebView2 SDK (headers + static loader)
if (-not (Test-Path (Join-Path $wv2Dir 'build\native\include\WebView2.h'))) {
    $package = Join-Path $thirdParty "webview2-$webView2Version.zip"
    if (-not (Test-Path $package)) {
        Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webView2Version/microsoft.web.webview2.$webView2Version.nupkg" -OutFile $package
    }
    $hash = (Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $webView2Sha256) { throw "WebView2 package checksum mismatch: $hash" }
    Expand-Archive $package -DestinationPath $wv2Dir -Force
}
$wv2 = Join-Path $wv2Dir 'build\native'

# --- 3. Preview page: bundle marked + DOMPurify + Mermaid (Mermaid loads diagram chunks on demand)
$meta = Join-Path $obj 'esbuild-meta.json'
Push-Location $root   # the paths in the metafile are relative to the working directory
try {
    & (Join-Path $root 'node_modules\.bin\esbuild.cmd') (Join-Path $root 'web\preview.js') `
        --bundle --splitting --format=esm --minify --legal-comments=none --target=chrome120 `
        "--outdir=$web" "--metafile=$meta" --log-level=warning
    if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }
} finally { Pop-Location }
$css = Join-Path $root 'node_modules\github-markdown-css'
Copy-Item (Join-Path $root 'web\index.html'), (Join-Path $root 'web\preview.css'), `
    (Join-Path $css 'github-markdown-light.css'), (Join-Path $css 'github-markdown-dark-dimmed.css') $web -Force

# --- 4. Plugin DLL (static CRT and static WebView2 loader: no extra runtime files)
if (-not $VcVars) {
    $candidates = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -property installationPath
        if ($vsPath) { $candidates += Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat' }
    }
    $VcVars = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $VcVars -or -not (Test-Path $VcVars)) { throw 'vcvars64.bat not found; pass -VcVars <path>' }

$dll = Join-Path $out 'mdnotepad.dll'
$cmd = "`"$VcVars`" >nul && rc /nologo $verDefines /fo `"$obj\mdnotepad.res`" `"$root\resources\mdnotepad.rc`" && cl /nologo /std:c++17 /O2 /MT /EHsc /W3 /LD " +
    "/I `"$wv2\include`" `"$root\src\plugin.cpp`" /Fo`"$obj\\`" /Fe`"$dll`" " +
    "/link /nologo /IMPLIB:`"$obj\mdnotepad.lib`" `"$obj\mdnotepad.res`" `"$wv2\x64\WebView2LoaderStatic.lib`" " +
    "user32.lib ole32.lib oleaut32.lib shell32.lib shlwapi.lib advapi32.lib comdlg32.lib gdi32.lib version.lib"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw 'cl failed' }

Copy-Item (Join-Path $root 'LICENSE'), (Join-Path $root 'THIRD-PARTY-NOTICES.md') $out -Force
Write-Host "Built: $out"

# --- 5. Archives, checksums and the plugin list entry
# Only the files of this build go in (dist\mdnotepad\web may still hold script parts of older builds).
$dist = Split-Path $out
Copy-Item (Join-Path $root 'installer\install.cmd'), (Join-Path $root 'installer\install.ps1') $dist -Force
$files = @('mdnotepad.dll', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'web\index.html', 'web\preview.css',
    'web\github-markdown-light.css', 'web\github-markdown-dark-dimmed.css')
$outputs = (Get-Content $meta -Raw | ConvertFrom-Json).outputs.PSObject.Properties.Name
foreach ($o in $outputs) {
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $o))
    if ($full.StartsWith($out + '\', [StringComparison]::OrdinalIgnoreCase)) { $files += $full.Substring($out.Length + 1) }
}
if ($files -notcontains 'web\preview.js') { throw 'the archive would be incomplete: web\preview.js is not among the build outputs' }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
# $entries: ordered map <name inside the zip> -> <file on disk>
function New-Zip([string]$path, $entries) {
    $stream = [System.IO.File]::Open($path, 'Create')
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $entries.Keys) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entries[$name], $name) | Out-Null
        }
    } finally {
        $archive.Dispose()
        $stream.Dispose()
    }
}
$people = [ordered]@{}
$pluginsAdmin = [ordered]@{}
foreach ($f in $files) {
    $people['mdnotepad/' + ($f -replace '\\', '/')] = Join-Path $out $f
    $pluginsAdmin[($f -replace '\\', '/')] = Join-Path $out $f   # Plugins Admin unpacks into plugins\mdnotepad\
}
$people['install.cmd'] = Join-Path $dist 'install.cmd'
$people['install.ps1'] = Join-Path $dist 'install.ps1'
$zipPeople = "MDNotepad-$version-x64.zip"
$zipAdmin = "mdnotepad-$version-x64-plugins-admin.zip"
New-Zip (Join-Path $dist $zipPeople) $people
New-Zip (Join-Path $dist $zipAdmin) $pluginsAdmin

$sums = foreach ($z in $zipPeople, $zipAdmin) {
    '{0}  {1}' -f (Get-FileHash (Join-Path $dist $z) -Algorithm SHA256).Hash.ToLowerInvariant(), $z
}
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), ($sums -join "`n") + "`n")
$entry = [ordered]@{
    'folder-name'  = 'mdnotepad'
    'display-name' = 'MD Notepad'
    'version'      = $version
    'id'           = (Get-FileHash (Join-Path $dist $zipAdmin) -Algorithm SHA256).Hash.ToLowerInvariant()
    'repository'   = "$repository/releases/download/v$version/$zipAdmin"
    'description'  = 'Markdown preview panel next to the editor: GitHub style, Mermaid diagrams, dark theme, PDF export. Text can be edited in the preview too; the change goes into the Markdown source. Uses the Microsoft Edge WebView2 Runtime that is part of Windows 10/11.'
    'author'       = 'aideakit'
    'homepage'     = $repository
}
[System.IO.File]::WriteAllText((Join-Path $dist 'pl.x64-entry.json'), ($entry | ConvertTo-Json) + "`n")
Write-Host "Archives: dist\$zipPeople ($($people.Count) files), dist\$zipAdmin ($($pluginsAdmin.Count) files)"
Write-Host 'Checksums: dist\SHA256SUMS.txt; plugin list entry: dist\pl.x64-entry.json'

if ($Install) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dist 'install.ps1'))
    if ($NppDir) { $arguments += @('-NppDir', $NppDir) }
    & powershell.exe @arguments
    exit $LASTEXITCODE
}
