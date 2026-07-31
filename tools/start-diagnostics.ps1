$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$healthUrl = 'http://127.0.0.1:47831/health'

try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
        Write-Host "[Emby Multi Window] Diagnostics is already running."
        Write-Host "Log: $($health.logFile)"
        exit 0
    }
} catch {
    # A failed health probe means the local-only collector is not running yet.
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '[Emby Multi Window] Node.js was not found in PATH.'
    Write-Host 'Install Node.js, then run start-diagnostics.cmd again.'
    Read-Host 'Press Enter to close'
    exit 1
}

$collector = Join-Path $PSScriptRoot 'diagnostics-collector.js'
Start-Process `
    -FilePath $node.Source `
    -ArgumentList @($collector) `
    -WorkingDirectory $root `
    -WindowStyle Hidden

Start-Sleep -Milliseconds 700
$health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
Write-Host '[Emby Multi Window] Diagnostics started.'
Write-Host "Log: $($health.logFile)"
