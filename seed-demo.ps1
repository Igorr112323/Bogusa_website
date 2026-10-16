<#
.SYNOPSIS
    Fill the database with demo data (disciplines, topics, teachers, responses).

.DESCRIPTION
    Shortcut for:
        npm run seed -- --demo

    If the database does not exist yet - it will be created first
    (like on the first run).
    If it exists - new disciplines and topics will be added to the
    existing ones (nothing is deleted).

.EXAMPLE
    .\seed-demo.ps1
    Add demo data to the current database.

.EXAMPLE
    .\seed-demo.ps1 -Reset
    Reset the database first (all previously collected responses
    will be deleted), then recreate it with demo data.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\seed-demo.ps1
    If PowerShell blocks the script.
#>

[CmdletBinding()]
param(
    [switch]$Reset   # reset the database before filling
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "   OK   $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "   .... $text" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  Filling the database with demo data' -ForegroundColor White
Write-Host "  Project directory: $root"

# Check node_modules
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host ''
    Write-Host '  Dependencies are not installed. Run this first:  .\start.ps1' -ForegroundColor Red
    exit 1
}

# Reset if requested
if ($Reset) {
    $dbPattern = Join-Path $root 'data\feedback.sqlite*'
    Write-Step "Resetting the database: removing $dbPattern"
    Remove-Item $dbPattern -Force -ErrorAction SilentlyContinue
    Write-Ok 'old database removed'
}

# Seed
Write-Step 'Running seed --demo (disciplines, topics, responses)'
& npm run seed -- --demo
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  Failed to fill the database. See the message above.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  Done. Open:  http://localhost:3000/' -ForegroundColor Green
Write-Host '  Login and password are printed above.' -ForegroundColor Yellow
Write-Host '  To start the server:  .\start.ps1' -ForegroundColor Green
