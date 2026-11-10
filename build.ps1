# Builds the plugin into dist\mdnotepad\ (mdnotepad.dll + web\). x64 only.
#   pwsh -File build.ps1 [-VcVars <path to vcvars64.bat>]
# Needs Node.js (npm) and Visual Studio Build Tools with the C++ workload and a Windows SDK.
# First run installs the npm packages and downloads the Microsoft.Web.WebView2 NuGet package (pinned, checked by SHA-256).
param(
    [string]$VcVars = ''
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
& (Join-Path $root 'node_modules\.bin\esbuild.cmd') (Join-Path $root 'web\preview.js') `
    --bundle --splitting --format=esm --minify --legal-comments=none --target=chrome120 `
    "--outdir=$web" --log-level=warning
if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }
$css = Join-Path $root 'node_modules\github-markdown-css'
Copy-Item (Join-Path $root 'web\index.html'), (Join-Path $root 'web\preview.css'), `
    (Join-Path $css 'github-markdown-light.css'), (Join-Path $css 'github-markdown-dark-dimmed.css') $web -Force

# --- 4. Plugin DLL (static CRT and static WebView2 loader: no extra runtime files)
if (-not $VcVars) {
    $candidates = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $install = & $vswhere -latest -products * -property installationPath
        if ($install) { $candidates += Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat' }
    }
    $VcVars = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $VcVars -or -not (Test-Path $VcVars)) { throw 'vcvars64.bat not found; pass -VcVars <path>' }

$dll = Join-Path $out 'mdnotepad.dll'
$cmd = "`"$VcVars`" >nul && rc /nologo /fo `"$obj\mdnotepad.res`" `"$root\resources\mdnotepad.rc`" && cl /nologo /std:c++17 /O2 /MT /EHsc /W3 /LD " +
    "/I `"$wv2\include`" `"$root\src\plugin.cpp`" /Fo`"$obj\\`" /Fe`"$dll`" " +
    "/link /nologo /IMPLIB:`"$obj\mdnotepad.lib`" `"$obj\mdnotepad.res`" `"$wv2\x64\WebView2LoaderStatic.lib`" " +
    "user32.lib ole32.lib oleaut32.lib shell32.lib shlwapi.lib advapi32.lib comdlg32.lib gdi32.lib version.lib"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw 'cl failed' }

Copy-Item (Join-Path $root 'LICENSE'), (Join-Path $root 'THIRD-PARTY-NOTICES.md') $out -Force
Write-Host "Built: $out"
