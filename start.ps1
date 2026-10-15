<#
.SYNOPSIS
    Установка и запуск сервиса «Анонимная обратная связь» на Windows.

.DESCRIPTION
    Скрипт делает всё сам:
      0. если Node.js не установлен — предложит поставить его через winget
         (встроенный установщик пакетов Windows);
      1. проверяет Node.js и npm;
      2. устанавливает зависимости (npm install), если каталога node_modules нет;
      3. создаёт файл настроек .env из .env.example, если его нет;
      4. создаёт базу данных с администратором и демонстрационными данными
         (только при первом запуске — существующая база не трогается);
      5. запускает сервер и печатает адреса всех ролей.

.EXAMPLE
    .\start.ps1
    Обычный запуск: установить (если нужно) и стартовать сервер.

.EXAMPLE
    .\start.ps1 -InstallNode
    Если Node.js нет: установить его через winget без дополнительных вопросов.

.EXAMPLE
    .\start.ps1 -Port 8080
    Запустить на другом порту.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\start.ps1
    Если PowerShell запрещает запуск скриптов.
#>

[CmdletBinding()]
param(
    [int]$Port = 0,          # 0 = взять порт из .env или 3000
    [switch]$InstallNode,    # установить Node.js через winget без вопросов
    [switch]$NoDemo,         # не загружать демонстрационные данные
    [switch]$SkipInstall,    # пропустить npm install
    [switch]$Reset           # ПЕРЕсоздать базу (удалит текущие данные!)
)

$ErrorActionPreference = 'Stop'

function Write-Step($text)  { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Write-Ok($text)    { Write-Host "   $text" -ForegroundColor Green }
function Write-Note($text)  { Write-Host "   $text" -ForegroundColor Yellow }
function Fail($text) {
    Write-Host "`nОШИБКА: $text`n" -ForegroundColor Red
    exit 1
}

# Работаем в каталоге скрипта, а не в текущем каталоге PowerShell
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ''
Write-Host '  Анонимная обратная связь — установка и запуск' -ForegroundColor White
Write-Host "  Каталог проекта: $root"

# --- 0. Проверка и при необходимости установка Node.js ----------------------

function Test-Node {
    return [bool](Get-Command node -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    <# Перечитывает PATH из реестра — winget ставит Node.js, но текущая
       сессия PowerShell ещё не знает об этом. #>
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'

    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs",
        "$env:LOCALAPPDATA\Programs\nodejs",
        "${env:ProgramFiles(x86)}\nodejs"
    )) {
        if ($candidate -and (Test-Path $candidate) -and ($env:Path -notlike "*$candidate*")) {
            $env:Path += ";$candidate"
        }
    }
}

function Show-NodeHelp {
    Write-Host ''
    Write-Host 'Node.js не найден. Как установить (любой из способов):' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Способ 1 — одна команда в этом же окне (быстрее всего):'
    Write-Host '      winget install --exact --id OpenJS.NodeJS.LTS'
    Write-Host ''
    Write-Host '  Способ 2 — установщик с сайта:'
    Write-Host '      https://nodejs.org/ru/download  →  скачайте "LTS" (.msi) и установите'
    Write-Host '      со стандартными настройками'
    Write-Host ''
    Write-Host '  Затем ЗАКРОЙТЕ это окно PowerShell, откройте новое и выполните:'
    Write-Host '      cd "' -NoNewline
    Write-Host $root -NoNewline
    Write-Host '"'
    Write-Host '      .\start.ps1'
    Write-Host ''
    Write-Host '  Проверка, что всё встало:  node -v   (ожидается v22.x, v24.x или v26.x)'
    Write-Host ''
}

Write-Step 'Проверяю Node.js'

if (-not (Test-Node)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $install = $false

    if ($winget) {
        if ($InstallNode) {
            $install = $true
        } else {
            Write-Note 'Node.js на этом компьютере не найден.'
            $answer = ''
            try {
                $answer = Read-Host '   Установить Node.js LTS автоматически через winget? (y/n)'
            } catch {
                $answer = 'n'
            }
            $install = ($answer -match '^(y|yes|д|да)$')
        }
    }

    if ($install -and $winget) {
        Write-Step 'Устанавливаю Node.js LTS через winget (это займёт 1–3 минуты)'
        Write-Host '   Может открыться окно установщика Node.js — согласитесь с настройками по умолчанию.'
        & winget install --exact --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Note 'winget не смог установить Node.js автоматически.'
            Show-NodeHelp
            exit 1
        }
        Update-SessionPath
        Write-Ok 'Установка завершена, обновляю PATH текущего окна.'
    }

    if (-not (Test-Node)) {
        Show-NodeHelp
        exit 1
    }
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
Write-Ok "Node.js v$nodeVersion"

if ($nodeMajor -lt 18) {
    Fail "Нужен Node.js 18.18 или новее (у вас v$nodeVersion). Обновите: winget upgrade --id OpenJS.NodeJS.LTS"
}
if ($nodeMajor -lt 22) {
    Write-Note 'Совет: надежнее Node.js 22 или новее — в нем есть встроенный драйвер SQLite (без компиляции).'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail 'npm не найден. Переустановите Node.js: winget install --exact --id OpenJS.NodeJS.LTS'
}

# --- 1. Зависимости --------------------------------------------------------
if (-not $SkipInstall) {
    if (Test-Path (Join-Path $root 'node_modules')) {
        Write-Step 'Зависимости уже установлены (пропускаю npm install)'
        Write-Ok 'Чтобы переустановить: удалите каталог node_modules и запустите скрипт заново.'
    } else {
        Write-Step 'Устанавливаю зависимости: npm install (обычно 1-3 минуты)'
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Host ''
            Write-Host 'npm install завершился с ошибкой.' -ForegroundColor Red
            Write-Host 'Частые причины: нет интернета, корпоративный прокси или антивирус.'
            Write-Host 'Повторите установку командой: npm install'
            Write-Host 'Пакеты bcrypt и better-sqlite3 — опциональные: если они не соберутся,'
            Write-Host 'сервис всё равно заработает (пароли через scrypt, база через встроенный SQLite).'
            Write-Host ''
            exit 1
        }
        Write-Ok 'Зависимости установлены.'
    }
}

# --- 2. Файл настроек ------------------------------------------------------
$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) {
    Write-Step 'Создаю файл настроек .env'
    Copy-Item (Join-Path $root '.env.example') $envPath
    Write-Ok 'Файл .env создан из .env.example (логин администратора по умолчанию: admin)'
    Write-Note 'Если меняете пароль в .env и в нём есть # или ; — берите значение в кавычки:'
    Write-Note 'ADMIN_PASSWORD="Admin#2026pass"  (иначе пароль обрежется)'
} else {
    Write-Step 'Файл настроек .env уже существует (оставляю без изменений)'
}

# --- 3. База данных --------------------------------------------------------
$dbFile = Join-Path $root 'data\feedback.sqlite'

if ($Reset) {
    Write-Step 'Сброс базы данных (-Reset): удаляю старую базу'
    Remove-Item (Join-Path $root 'data\feedback.sqlite*') -Force -ErrorAction SilentlyContinue
    Write-Note 'Все ранее собранные анкеты удалены.'
}

if (-not (Test-Path $dbFile)) {
    Write-Step 'Инициализирую базу данных и создаю администратора'
    if ($NoDemo) {
        & npm run seed
    } else {
        & npm run seed -- --demo
    }
    if ($LASTEXITCODE -ne 0) { Fail 'Не удалось создать базу данных. Смотрите сообщение выше.' }
    Write-Note 'Пароль администратора напечатан выше — сохраните его.'
} else {
    Write-Step 'База данных уже есть (данные сохранены)'
    Write-Ok "Файл: $dbFile"
}

# --- 4. Запуск -------------------------------------------------------------
if ($Port -gt 0) { $env:PORT = "$Port" }

# Если порт не задан параметром — берём его из .env, иначе 3000
$effectivePort = '3000'
if (-not $env:PORT) {
    if (Test-Path $envPath) {
        foreach ($line in Get-Content $envPath) {
            if ($line -match '^\s*PORT\s*=\s*(.+)$') {
                $effectivePort = $Matches[1].Trim().Trim('"').Trim("'")
                break
            }
        }
    }
    if (-not $effectivePort) { $effectivePort = '3000' }
    $env:PORT = $effectivePort
} else {
    $effectivePort = $env:PORT
}

$base = "http://localhost:$effectivePort"
Write-Host ''
Write-Host '  Адреса для проверки:' -ForegroundColor White
Write-Host "    Студенты:       $base/            (и $base/form.html)"
Write-Host "    Вход:           $base/login"
Write-Host "    Преподаватель:  $base/portal/"
Write-Host "    Админ:          $base/admin/"
Write-Host ''
Write-Host '  Остановить сервер: Ctrl+C в этом окне' -ForegroundColor DarkGray
Write-Host '  Проверка окружения: npm run doctor | Шпаргалка: npm run help' -ForegroundColor DarkGray
Write-Host ''

Write-Step 'Запускаю сервер'
& npm start
