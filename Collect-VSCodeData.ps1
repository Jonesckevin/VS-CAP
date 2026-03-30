<#
.SYNOPSIS
    VS-CAP Evidence Collector — Collects VS Code workspace data for forensic analysis.
.DESCRIPTION
    Gathers VS Code workspaceStorage, globalStorage, settings, and profiles from all
    user profiles on the system. Produces a timestamped ZIP ready for the VS-CAP Viewer.
    Equivalent to the KAPE VSCode_WorkspaceStorage.tkape target but requires no KAPE install.
.PARAMETER OutputDir
    Directory to write the output ZIP. Defaults to the current directory.
.PARAMETER Users
    Specific usernames to collect from. Defaults to all user profiles under C:\Users.
.PARAMETER IncludeInsiders
    Also collect VS Code Insiders data. Enabled by default.
.PARAMETER NoZip
    Keep the raw folder instead of compressing to ZIP.
.PARAMETER ComputerName
    Label stamped into the output filename. Defaults to $env:COMPUTERNAME.
.EXAMPLE
    .\Collect-VSCodeData.ps1
    .\Collect-VSCodeData.ps1 -OutputDir E:\evidence -Users alice,bob
    .\Collect-VSCodeData.ps1 -NoZip
.NOTES
    All operations are read-only — source files are never modified.
#>

[CmdletBinding()]
param(
    [string]$OutputDir = ".",
    [string[]]$Users,
    [switch]$IncludeInsiders = $true,
    [switch]$NoZip,
    [string]$ComputerName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"

# ── Banner ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  VS-CAP Evidence Collector                   ║" -ForegroundColor Cyan
Write-Host "  ║  VS Code Workspace Data Acquisition          ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Resolve users ───────────────────────────────────────────────
$usersDir = "C:\Users"
if ($Users) {
    $userPaths = foreach ($u in $Users) {
        $p = Join-Path $usersDir $u
        if (Test-Path $p) { $p } else { Write-Warning "User profile not found: $p"; $null }
    }
    $userPaths = @($userPaths | Where-Object { $_ })
} else {
    $userPaths = @(Get-ChildItem $usersDir -Directory |
        Where-Object { $_.Name -notin @('Public', 'Default', 'Default User', 'All Users') } |
        ForEach-Object { $_.FullName })
}

if ($userPaths.Count -eq 0) {
    Write-Host "  [ERROR] No user profiles found to collect from." -ForegroundColor Red
    exit 1
}

Write-Host "  Target users: $($userPaths | ForEach-Object { Split-Path $_ -Leaf })" -ForegroundColor Gray

# ── Build collection targets ────────────────────────────────────
# Each target: friendly name, relative path under <user>\AppData\Roaming, recursive flag, file mask
$variants = @(
    @{ Label = "VS Code Stable"; UserRoot = "Code\User"; AppRoot = "Code" }
)
if ($IncludeInsiders) {
    $variants += @{ Label = "VS Code Insiders"; UserRoot = "Code - Insiders\User"; AppRoot = "Code - Insiders" }
}

# Targets under the User\ directory
$userTargets = @(
    @{ Name = "workspaceStorage"; Relative = "workspaceStorage"; Recursive = $true;  Mask = $null }
    @{ Name = "globalStorage";    Relative = "globalStorage";    Recursive = $true;  Mask = $null }
    @{ Name = "settings.json";    Relative = "";                 Recursive = $false; Mask = "settings.json*" }
    @{ Name = "profiles";         Relative = "profiles";         Recursive = $true;  Mask = $null }
    @{ Name = "History";          Relative = "History";           Recursive = $true;  Mask = $null }
)

# Targets under the app root directory (e.g. Code\ or Code - Insiders\)
$appTargets = @(
    @{ Name = "CachedExtensions"; Relative = "CachedExtensions"; Recursive = $false; Mask = "user*" }
    @{ Name = "Preferences";      Relative = "";                  Recursive = $false; Mask = "preferences*" }
    @{ Name = "Network Cookies";  Relative = "Network";           Recursive = $false; Mask = "Cookies*" }
    @{ Name = "Network State";    Relative = "Network";           Recursive = $false; Mask = "Network Persistent State*" }
    @{ Name = "Logs";             Relative = "logs";              Recursive = $true;  Mask = $null }
    @{ Name = "Backups";          Relative = "Backups";           Recursive = $true;  Mask = $null }
)

# ── Prepare output directory ────────────────────────────────────
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$collectName = "VSCode_Collection_${ComputerName}_${timestamp}"
$collectDir = Join-Path (Resolve-Path $OutputDir) $collectName

New-Item -ItemType Directory -Path $collectDir -Force | Out-Null

# ── Copy helper ─────────────────────────────────────────────────
$stats = @{ Files = 0; Bytes = 0; Errors = 0; Skipped = 0 }

function Copy-Artifact {
    param(
        [string]$Source,
        [string]$Destination,
        [bool]$Recursive,
        [string]$Mask
    )
    if (-not (Test-Path $Source)) { return }

    $items = if ($Mask) {
        if ($Recursive) {
            Get-ChildItem -Path $Source -Filter $Mask -Recurse -File -ErrorAction SilentlyContinue
        } else {
            Get-ChildItem -Path $Source -Filter $Mask -File -ErrorAction SilentlyContinue
        }
    } else {
        if ($Recursive) {
            Get-ChildItem -Path $Source -Recurse -File -ErrorAction SilentlyContinue
        } else {
            Get-ChildItem -Path $Source -File -ErrorAction SilentlyContinue
        }
    }

    foreach ($item in $items) {
        $relPath = $item.FullName.Substring($Source.TrimEnd('\').Length + 1)
        $destPath = Join-Path $Destination $relPath
        $destDir = Split-Path $destPath -Parent

        try {
            if (-not (Test-Path $destDir)) {
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            }
            Copy-Item -Path $item.FullName -Destination $destPath -Force -ErrorAction Stop
            $stats.Files++
            $stats.Bytes += $item.Length
        } catch {
            $stats.Errors++
            Write-Verbose "  Access denied or locked: $($item.FullName)"
        }
    }
}

# ── Collect ─────────────────────────────────────────────────────
$stepNum = 0
$totalSteps = $userPaths.Count * $variants.Count

foreach ($userPath in $userPaths) {
    $userName = Split-Path $userPath -Leaf
    $appData = Join-Path $userPath "AppData\Roaming"

    foreach ($variant in $variants) {
        $stepNum++
        $variantUserRoot = Join-Path $appData $variant.UserRoot
        $variantAppRoot  = Join-Path $appData $variant.AppRoot

        $hasUser = Test-Path $variantUserRoot
        $hasApp  = Test-Path $variantAppRoot

        if (-not $hasUser -and -not $hasApp) {
            $stats.Skipped++
            Write-Host "  [$stepNum/$totalSteps] $userName / $($variant.Label) — not found, skipping" -ForegroundColor DarkGray
            continue
        }

        Write-Host "  [$stepNum/$totalSteps] $userName / $($variant.Label)" -ForegroundColor Yellow

        # Targets under User\ (workspaceStorage, globalStorage, settings, profiles, History)
        if ($hasUser) {
            foreach ($target in $userTargets) {
                $sourcePath = if ($target.Relative) {
                    Join-Path $variantUserRoot $target.Relative
                } else {
                    $variantUserRoot
                }

                if (-not (Test-Path $sourcePath)) { continue }

                $destBase = Join-Path $collectDir "Users\$userName\$($variant.UserRoot)"
                $destPath = if ($target.Relative) {
                    Join-Path $destBase $target.Relative
                } else {
                    $destBase
                }

                Write-Host "        $($target.Name)..." -ForegroundColor Gray -NoNewline
                $beforeFiles = $stats.Files
                Copy-Artifact -Source $sourcePath -Destination $destPath -Recursive $target.Recursive -Mask $target.Mask
                $copied = $stats.Files - $beforeFiles
                Write-Host " $copied files" -ForegroundColor DarkGray
            }
        }

        # Targets under app root (CachedExtensions, Preferences, Network, Logs, Backups)
        if ($hasApp) {
            foreach ($target in $appTargets) {
                $sourcePath = if ($target.Relative) {
                    Join-Path $variantAppRoot $target.Relative
                } else {
                    $variantAppRoot
                }

                if (-not (Test-Path $sourcePath)) { continue }

                $destBase = Join-Path $collectDir "Users\$userName\$($variant.AppRoot)"
                $destPath = if ($target.Relative) {
                    Join-Path $destBase $target.Relative
                } else {
                    $destBase
                }

                Write-Host "        $($target.Name)..." -ForegroundColor Gray -NoNewline
                $beforeFiles = $stats.Files
                Copy-Artifact -Source $sourcePath -Destination $destPath -Recursive $target.Recursive -Mask $target.Mask
                $copied = $stats.Files - $beforeFiles
                Write-Host " $copied files" -ForegroundColor DarkGray
            }
        }
    }
}

# ── Write collection manifest ──────────────────────────────────
$manifest = [ordered]@{
    tool             = "VS-CAP Evidence Collector"
    version          = "1.0"
    collectionDate   = (Get-Date -Format "o")
    computerName     = $ComputerName
    collectorUser    = $env:USERNAME
    isElevated       = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    targetUsers      = @($userPaths | ForEach-Object { Split-Path $_ -Leaf })
    includeInsiders  = [bool]$IncludeInsiders
    filesCollected   = $stats.Files
    bytesCollected   = $stats.Bytes
    accessErrors     = $stats.Errors
    variantsSkipped  = $stats.Skipped
}
$manifestPath = Join-Path $collectDir "_collection_manifest.json"
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Path $manifestPath -Encoding UTF8

# ── ZIP output ──────────────────────────────────────────────────
if (-not $NoZip) {
    $zipPath = "$collectDir.zip"
    Write-Host ""
    Write-Host "  Compressing to ZIP..." -ForegroundColor Yellow

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($collectDir, $zipPath)

    $zipSize = (Get-Item $zipPath).Length
    Remove-Item $collectDir -Recurse -Force

    Write-Host "  Output: $zipPath" -ForegroundColor Green
    Write-Host "  Size:   $([Math]::Round($zipSize / 1MB, 2)) MB" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  Output: $collectDir" -ForegroundColor Green
}

# ── Summary ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌──────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │  Collection Summary                      │" -ForegroundColor Cyan
Write-Host "  ├──────────────────────────────────────────┤" -ForegroundColor Cyan
Write-Host "  │  Files collected : $($stats.Files.ToString().PadLeft(8))              │" -ForegroundColor White
Write-Host "  │  Total size      : $("$([Math]::Round($stats.Bytes / 1MB, 2)) MB".PadLeft(8))              │" -ForegroundColor White
Write-Host "  │  Access errors   : $($stats.Errors.ToString().PadLeft(8))              │" -ForegroundColor $(if ($stats.Errors -gt 0) { "Yellow" } else { "White" })
Write-Host "  └──────────────────────────────────────────┘" -ForegroundColor Cyan

Write-Host ""
Write-Host "  Load the output into VS-CAP Viewer for analysis." -ForegroundColor Gray
Write-Host ""
