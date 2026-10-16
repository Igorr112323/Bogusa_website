<#
.SYNOPSIS
    Diagnose the anonymous feedback service on Windows.

.DESCRIPTION
    Checks everything needed to run the app:
      - Node.js (version 22+);
      - npm;
      - installed dependencies (node_modules);
      - .env file;
      - database driver (npm run dbcheck);
      - environment integrity (npm run doctor);
      - whether ports 3000 and 3001 are free;
      - whether the running server actually answers.

    Exit codes:
      0 - all good;
      1 - problems that prevent launch;
      2 - Node.js not installed.

.EXAMPLE
    .\check.ps1
    Full diagnostics.

.EXAMPLE
    .\check.ps1 -Quick
    Only critical checks: Node.js, npm, .env, database driver.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\check.ps1
    If PowerShell blocks the script.
#>

[CmdletBinding()]
param(
    [switch]$Quick   # only critical checks
)

$ErrorActionPreference = 'Stop'

function Write-Step($text)  { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Write-Ok($text)    { Write-Host "   OK   $text" -ForegroundColor Green }
function Write-Note($text)  { Write-Host "   .... $text" -ForegroundColor Yellow }
function Write-Fail($text)  { Write-Host "   FAIL $text" -ForegroundColor Red }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$failCount = 0

# --- 1. Node.js ------------------------------------------------------------

Write-Step 'Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail 'node is not found in PATH.'
    Write-Host '   Install:  winget install --exact --id OpenJS.NodeJS.LTS'
    Write-Host '   Or download LTS from https://nodejs.org/ and reopen this PowerShell window.'
    exit 2
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
    Write-Fail "Node.js v$nodeVersion - need 22 or newer (for better-sqlite3 binaries)."
    $failCount++
} else {
    Write-Ok "Node.js v$nodeVersion"
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Fail 'npm is not found. Reinstall Node.js (npm ships with it).'
    $failCount++
} else {
    Write-Ok "npm $(& npm -v)"
}

# --- 2. Dependencies --------------------------------------------------------

Write-Step 'Dependencies'
if (Test-Path (Join-Path $root 'node_modules')) {
    $modules = (Get-ChildItem (Join-Path $root 'node_modules') -Directory -ErrorAction SilentlyContinue).Count
    Write-Ok "node_modules: $modules packages"
} else {
    Write-Fail 'node_modules directory is missing. Run: .\start.ps1'
    $failCount++
}

# --- 3. .env file ----------------------------------------------------------

Write-Step 'Configuration file'
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
    Write-Ok '.env exists'
} else {
    Write-Note '.env is missing - it will be created on the first run of .\start.ps1'
}

# --- 4. DB driver ---------------------------------------------------------

if (-not $Quick) {
    Write-Step 'Database driver (npm run dbcheck)'
    if (Test-Path (Join-Path $root 'node_modules')) {
        & npm run dbcheck 2>&1 | Tee-Object -Variable dbOut | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'DB driver works'
        } else {
            Write-Fail 'npm run dbcheck returned an error. See the output above.'
            $failCount++
        }
    } else {
        Write-Note 'skipped (no node_modules)'
    }
}

# --- 5. Environment integrity ---------------------------------------------

if (-not $Quick) {
    Write-Step 'Environment (npm run doctor)'
    if (Test-Path (Join-Path $root 'node_modules')) {
        & npm run doctor 2>&1 | Tee-Object -Variable docOut | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'npm run doctor: all good'
        } else {
            Write-Fail 'npm run doctor: there are warnings.'
            $failCount++
        }
    } else {
        Write-Note 'skipped (no node_modules)'
    }
}

# --- 6. Ports --------------------------------------------------------------

Write-Step 'Free ports'
function Test-Port([int]$port) {
    $listener = Get-NetTCPListener -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -ne $PID }
    if ($listener) {
        $proc = Get-Process -Id $listener[0].OwningProcess -ErrorAction SilentlyContinue
        return $proc
    }
    return $null
}

foreach ($pair in @( @{ Port = 3000; Name = 'student site' }, @{ Port = 3001; Name = 'login/portal/admin' } )) {
    $port = $pair.Port
    $name = $pair.Name
    $busy = Test-Port $port
    if ($busy) {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmd -like '*node*' -and $cmd -like '*server*') {
            Write-Ok "port $port ($name): occupied by our server (PID $($busy.Id))"
        } else {
            Write-Note "port $port ($name): occupied by another process (PID $($busy.Id), $($busy.ProcessName))"
            Write-Note '   to free it: stop that process or set a different port in .env'
        }
    } else {
        Write-Ok "port $port ($name): free"
    }
}

# --- 7. Server response ----------------------------------------------------

if (-not $Quick) {
    Write-Step 'Is the server responding?'
    foreach ($pair in @( @{ Url = 'http://localhost:3000/'; Name = 'student home' },
                         @{ Url = 'http://localhost:3001/login'; Name = 'login for staff' },
                         @{ Url = 'http://localhost:3001/portal/'; Name = 'teacher portal' } )) {
        $url = $pair.Url
        $name = $pair.Name
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            Write-Ok "$name ($url) - HTTP $($r.StatusCode)"
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            if ($code) {
                Write-Note "$name ($url) - HTTP $code"
            } else {
                Write-Note "$name ($url) - not responding. Server is not running."
            }
        }
    }
}

# --- Result ----------------------------------------------------------------

Write-Host ''
if ($failCount -eq 0) {
    Write-Host '  All good. You can run:  .\start.ps1' -ForegroundColor Green
    exit 0
} else {
    Write-Host "  There are problems: $failCount." -ForegroundColor Red
    Write-Host '  See the red FAIL lines above for instructions.' -ForegroundColor Red
    exit 1
}
