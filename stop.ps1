<#
.SYNOPSIS
    Stop the anonymous feedback server.

.DESCRIPTION
    Finds the Node.js process running server/index.js (or launched via
    .\start.ps1) and terminates it. The port is released automatically.

    By default only the server from the current directory is killed.
    Use the -All flag to kill any Node.js process on ports 3000/3001.

.EXAMPLE
    .\stop.ps1
    Stop only the server from the current directory.

.EXAMPLE
    .\stop.ps1 -All
    Stop any Node.js process occupying ports 3000 or 3001.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\stop.ps1
    If PowerShell blocks the script.
#>

[CmdletBinding()]
param(
    [switch]$All     # stop any Node.js on ports 3000/3001
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "   OK   $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "   .... $text" -ForegroundColor Yellow }

Write-Step 'Stopping server'

# 1. Find Node.js processes listening on ports 3000/3001.
$targetPorts = @(3000, 3001)
$listener = Get-NetTCPListener -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $targetPorts -contains $_.LocalPort -and $_.OwningProcess -ne $PID }

if (-not $listener) {
    Write-Note 'nothing is listening on ports 3000/3001.'
    exit 0
}

$killed = 0
foreach ($entry in $listener) {
    $pid3000 = $entry.OwningProcess
    $proc = Get-Process -Id $pid3000 -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -ne 'node') { continue }

    # Find the directory the process was launched from via CIM.
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid3000" -ErrorAction SilentlyContinue).CommandLine
    $isOurs = $All -or ($cmd -and $cmd -like "*$root*")
    $isOurEntry = $cmd -like '*server/index.js*' -or $cmd -like '*server\index.js*'

    if (-not $isOurs -and -not $isOurEntry) {
        Write-Note "port $($entry.LocalPort): PID $pid3000 - foreign Node.js process, not touching. Use -All to stop it."
        continue
    }

    Write-Step "Stopping PID $pid3000 (port $($entry.LocalPort))"
    try {
        Stop-Process -Id $pid3000 -Force -ErrorAction Stop
        Write-Ok "PID $pid3000 stopped"
        $killed++
    } catch {
        Write-Note "failed to stop PID $pid3000 : $($_.Exception.Message)"
    }
}

# 2. If the server was started via .\start.ps1 in another window, there is an
# npm wrapper process there. Stop it too so no window hangs around.
$npmProcs = Get-Process -Name 'npm' -ErrorAction SilentlyContinue
foreach ($npm in $npmProcs) {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($npm.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and ($cmd -like "*$root*" -or $All)) {
        Write-Step "Stopping npm wrapper PID $($npm.Id)"
        try {
            Stop-Process -Id $npm.Id -Force -ErrorAction Stop
            Write-Ok "PID $($npm.Id) stopped"
            $killed++
        } catch {
            Write-Note "failed to stop PID $($npm.Id)"
        }
    }
}

if ($killed -eq 0) {
    Write-Note 'nothing was stopped.'
} else {
    Write-Host "`n  Stopped $killed process(es)." -ForegroundColor Green
    Write-Host "  To start again:  .\start.ps1" -ForegroundColor Green
}
