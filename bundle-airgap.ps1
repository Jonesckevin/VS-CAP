<#
.SYNOPSIS
    VS-CAP Air-Gap Bundler — Creates fully self-contained HTML files with all libraries inlined.
.DESCRIPTION
    Downloads JSZip, sql.js (JS + WASM), marked.js, and Mermaid from CDN and embeds them
    directly into vs-cap-viewer.html and vs-cap-docs.html. The output files work offline
    in air-gapped environments with no internet access required.
.PARAMETER OutputDir
    Directory for the bundled output files. Defaults to a "dist" subfolder.
.PARAMETER TempDir
    Temporary download cache directory. Defaults to ".\_airgap_temp".
.PARAMETER SkipDocs
    Skip bundling the docs page (only bundle the viewer).
.EXAMPLE
    .\bundle-airgap.ps1
    .\bundle-airgap.ps1 -OutputDir C:\evidence\tools
    .\bundle-airgap.ps1 -SkipDocs
.NOTES
    Run from the VS-CAP project directory.
    Requires internet access during bundling (one time only).
    Downloads are cached in the temp directory for repeat runs.
#>

[CmdletBinding()]
param(
    [string]$OutputDir,
    [string]$TempDir = ".\_airgap_temp",
    [switch]$SkipDocs
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = Get-Location }

if (-not $OutputDir) { $OutputDir = Join-Path $scriptDir "dist" }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  VS-CAP Air-Gap Bundler                      ║" -ForegroundColor Cyan
Write-Host "  ║  Creating self-contained offline files...     ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Library definitions ─────────────────────────────────────────
$libs = @{
    jszip = @{
        Url  = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
        File = "jszip.min.js"
    }
    sqljs = @{
        Url  = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.min.js"
        File = "sql-wasm.min.js"
    }
    sqljs_wasm = @{
        Url  = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.wasm"
        File = "sql-wasm.wasm"
    }
    marked = @{
        Url  = "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"
        File = "marked.min.js"
    }
    mermaid = @{
        Url  = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"
        File = "mermaid.min.js"
    }
}

# ── Verify source files ────────────────────────────────────────
$viewerSrc = Join-Path $scriptDir "vs-cap-viewer.html"
$docsSrc   = Join-Path $scriptDir "vs-cap-docs.html"

if (-not (Test-Path $viewerSrc)) {
    Write-Host "  [ERROR] Source not found: $viewerSrc" -ForegroundColor Red
    exit 1
}
if (-not $SkipDocs -and -not (Test-Path $docsSrc)) {
    Write-Host "  [WARN] Docs source not found, skipping: $docsSrc" -ForegroundColor Yellow
    $SkipDocs = $true
}

# ── Create directories ─────────────────────────────────────────
$tempPath = Join-Path $scriptDir $TempDir
if (-not (Test-Path $tempPath))   { New-Item -ItemType Directory -Path $tempPath -Force | Out-Null }
if (-not (Test-Path $OutputDir))  { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }

# ── Download libraries ─────────────────────────────────────────
Write-Host "  [1/4] Downloading libraries..." -ForegroundColor Yellow

foreach ($key in $libs.Keys) {
    $lib = $libs[$key]
    $dest = Join-Path $tempPath $lib.File
    if (Test-Path $dest) {
        $size = [Math]::Round((Get-Item $dest).Length / 1024)
        Write-Host "        Cached:      $($lib.File) (${size} KB)" -ForegroundColor DarkGray
        continue
    }
    Write-Host "        Downloading: $($lib.File)..." -ForegroundColor Gray -NoNewline
    try {
        Invoke-WebRequest -Uri $lib.Url -OutFile $dest -UseBasicParsing
        $size = [Math]::Round((Get-Item $dest).Length / 1024)
        Write-Host " ${size} KB" -ForegroundColor Green
    } catch {
        Write-Host " FAILED" -ForegroundColor Red
        Write-Host "        Error: $_" -ForegroundColor Red
        exit 1
    }
}

# ── Helper: read file as string ────────────────────────────────
function Read-Text([string]$Path) {
    [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

# ── Bundle viewer ──────────────────────────────────────────────
Write-Host ""
Write-Host "  [2/4] Bundling viewer..." -ForegroundColor Yellow

$viewerHtml = Read-Text $viewerSrc

# Replace CDN script tags with inlined content
$cdnReplacements = @(
    @{
        Pattern = '(?s)<script\s+src="https://cdnjs\.cloudflare\.com/ajax/libs/jszip/3\.10\.1/jszip\.min\.js"[^>]*>\s*</script>'
        File    = "jszip.min.js"
        Label   = "JSZip"
    }
    @{
        Pattern = '(?s)<script\s+src="https://cdnjs\.cloudflare\.com/ajax/libs/sql\.js/1\.11\.0/sql-wasm\.min\.js"[^>]*>\s*</script>'
        File    = "sql-wasm.min.js"
        Label   = "sql.js"
    }
    @{
        Pattern = '(?s)<script\s+src="https://cdnjs\.cloudflare\.com/ajax/libs/marked/12\.0\.2/marked\.min\.js"[^>]*>\s*</script>'
        File    = "marked.min.js"
        Label   = "marked"
    }
)

foreach ($r in $cdnReplacements) {
    $jsContent = Read-Text (Join-Path $tempPath $r.File)
    $inlineTag = "<script>/* $($r.Label) - inlined for air-gap */`n$jsContent`n</script>"
    $viewerHtml = [regex]::Replace($viewerHtml, $r.Pattern, $inlineTag)
    Write-Host "        Inlined: $($r.Label)" -ForegroundColor Gray
}

# Embed WASM as base64 data URI and replace the locateFile CDN reference
$wasmBytes  = [System.IO.File]::ReadAllBytes((Join-Path $tempPath "sql-wasm.wasm"))
$wasmBase64 = [Convert]::ToBase64String($wasmBytes)
$wasmSize   = [Math]::Round($wasmBytes.Length / 1024)

# Replace the locateFile CDN URL with a data-URI loader
$locatePattern = 'locateFile:\s*file\s*=>\s*`https://cdnjs\.cloudflare\.com/ajax/libs/sql\.js/1\.11\.0/\$\{file\}`'
$locateReplace = @"
locateFile: file => {
            if (file.endsWith('.wasm')) {
              const b = atob('$wasmBase64');
              const u = new Uint8Array(b.length);
              for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
              return URL.createObjectURL(new Blob([u], {type:'application/wasm'}));
            }
            return file;
          }
"@
$viewerHtml = [regex]::Replace($viewerHtml, $locatePattern, $locateReplace)
Write-Host "        Inlined: sql-wasm.wasm (${wasmSize} KB base64)" -ForegroundColor Gray

# Write output
$viewerOut = Join-Path $OutputDir "vs-cap-viewer-airgap.html"
[System.IO.File]::WriteAllText($viewerOut, $viewerHtml, [System.Text.Encoding]::UTF8)
$viewerSize = [Math]::Round((Get-Item $viewerOut).Length / 1024)
Write-Host "        Output:  $viewerOut (${viewerSize} KB)" -ForegroundColor Green

# ── Bundle docs ────────────────────────────────────────────────
if (-not $SkipDocs) {
    Write-Host ""
    Write-Host "  [3/4] Bundling docs..." -ForegroundColor Yellow

    $docsHtml = Read-Text $docsSrc

    # Replace Mermaid CDN script with inlined content
    $mermaidPattern = '(?s)<script\s+src="https://cdn\.jsdelivr\.net/npm/mermaid@11/dist/mermaid\.min\.js"[^>]*>\s*</script>'
    $mermaidContent = Read-Text (Join-Path $tempPath "mermaid.min.js")
    $mermaidInline  = "<script>/* Mermaid - inlined for air-gap */`n$mermaidContent`n</script>"
    $docsHtml = [regex]::Replace($docsHtml, $mermaidPattern, $mermaidInline)
    Write-Host "        Inlined: Mermaid" -ForegroundColor Gray

    # Update cross-link from docs to the air-gapped viewer filename
    $docsHtml = $docsHtml.Replace('href="vs-cap-viewer.html"', 'href="vs-cap-viewer-airgap.html"')

    $docsOut = Join-Path $OutputDir "vs-cap-docs-airgap.html"
    [System.IO.File]::WriteAllText($docsOut, $docsHtml, [System.Text.Encoding]::UTF8)
    $docsSize = [Math]::Round((Get-Item $docsOut).Length / 1024)
    Write-Host "        Output:  $docsOut (${docsSize} KB)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  [3/4] Docs — skipped" -ForegroundColor DarkGray
}

# ── Update viewer cross-link to air-gapped docs ───────────────
if (-not $SkipDocs) {
    $viewerHtml2 = Read-Text $viewerOut
    $viewerHtml2 = $viewerHtml2.Replace('href="vs-cap-docs.html"', 'href="vs-cap-docs-airgap.html"')
    $viewerHtml2 = $viewerHtml2.Replace("'vs-cap-docs.html'", "'vs-cap-docs-airgap.html'")
    [System.IO.File]::WriteAllText($viewerOut, $viewerHtml2, [System.Text.Encoding]::UTF8)
}

# ── Summary ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [4/4] Done!" -ForegroundColor Yellow
Write-Host ""
Write-Host "    Air-Gap Bundle Complete" -ForegroundColor Cyan
Write-Host "    Viewer : vs-cap-viewer-airgap.html" -ForegroundColor White
if (-not $SkipDocs) {
Write-Host "    Docs   : vs-cap-docs-airgap.html" -ForegroundColor White
}
Write-Host "    Output : $($OutputDir.PadRight(30))" -ForegroundColor White
Write-Host ""
Write-Host "  These files work fully offline — no internet needed." -ForegroundColor Gray
Write-Host ""
