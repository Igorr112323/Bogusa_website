<#
.SYNOPSIS
    Установка и запуск сервиса «Анонимная обратная связь» на Windows.

.DESCRIPTION
    Скрипт делает всё сам:
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
    .\start.ps1 -Port 8080
    Запустить на другом порту.

.EXAMPLE
    .\start.ps1 -NoDemo
    Создать пустую базу (без демонстрационных дисциплины и ответов).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\start.ps1
    Если PowerShell запрещает запуск скриптов.
#>

[CmdletBinding()]
param(
    [int]$Port = 0,          # 0 = взять порт из .env или 3000
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

# --- 1. Проверка Node.js ---------------------------------------------------
Write-Step 'Проверяю Node.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'Node.js не найден. Что делать:' -ForegroundColor Red
    Write-Host '  1) скачайте LTS-версию (рекомендуется 22.x): https://nodejs.org/ru/download'
    Write-Host '  2) установите со стандартными настройками'
    Write-Host '  3) ЗАКРОЙТЕ это окно PowerShell, откройте новое и повторите запуск'
    Write-Host '  4) проверка версии: node -v'
    Write-Host ''
    exit 1
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
Write-Ok "Node.js v$nodeVersion"

if ($nodeMajor -lt 18) {
    Fail "Нужен Node.js 18.18 или новее (у вас v$nodeVersion). Скачайте LTS: https://nodejs.org/ru/download"
}
if ($nodeMajor -lt 20) {
    Write-Note 'Совет: надёжнее использовать Node.js 22 LTS — в нём есть встроенный драйвер SQLite.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail 'npm не найден. Переустановите Node.js со стандартными настройками.'
}

# --- 2. Зависимости --------------------------------------------------------
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

# --- 3. Файл настроек ------------------------------------------------------
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

# --- 4. База данных --------------------------------------------------------
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

# --- 5. Запуск -------------------------------------------------------------
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
