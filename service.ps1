<#
  TestTool service supervisor.

  Keeps the server alive: if the process ever exits (crash, unhandled error,
  port conflict at boot), it waits 3 seconds and starts it again. Logs go to
  logs/service.log.

  Deliberately ASCII-only - no Chinese literals - so PowerShell output encoding
  can never corrupt anything we write to the log. The server itself prints
  Chinese, which arrives as UTF-8 through the redirect and is preserved.

  Usage:
    pwsh -NoProfile -File service.ps1          (foreground, Ctrl+C to stop)
    pwsh -NoProfile -WindowStyle Hidden -File service.ps1   (background)
#>

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$log = Join-Path $logDir 'service.log'

# Keep the log from growing without bound: rotate at 5 MB.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    $old = Join-Path $logDir 'service.old.log'
    Remove-Item $old -ErrorAction SilentlyContinue
    Move-Item $log $old -ErrorAction SilentlyContinue
}

function Write-Log {
    param([string]$Message)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$stamp] $Message" | Out-File -FilePath $log -Append -Encoding utf8
}

Write-Log '=== supervisor started ==='
Write-Log "root: $root"

$restarts = 0

while ($true) {
    Write-Log 'starting server'

    try {
        # *>> appends both stdout and stderr to the log
        & node "$root\server\server.ts" *>> $log
        $code = $LASTEXITCODE
        Write-Log "server exited with code $code"
    }
    catch {
        Write-Log "server threw: $_"
    }

    $restarts++
    Write-Log "restart #$restarts in 3s"
    Start-Sleep -Seconds 3
}
