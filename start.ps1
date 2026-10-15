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
      3. проверяет, что драйвер базы данных работает (npm run dbcheck);
      4. создаёт базу данных с администратором, преподавателем, дисциплинами
         и темами (только при первом запуске — существующая база не трогается);
      5. запускает сервер и печатает адреса: отдельно для студентов и отдельно
         для преподавателя и администратора.

.EXAMPLE
    .\start.ps1
    Обычный запуск: установить (если нужно) и стартовать сервер.

.EXAMPLE
    .\start.ps1 -InstallNode
    Если Node.js нет: установить его через winget без дополнительных вопросов.

.EXAMPLE
    .\start.ps1 -Port 8080 -StaffPort 8081
    Запустить на других портах: 8080 для студентов, 8081 для преподавателя и администратора.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\start.ps1
    Если PowerShell запрещает запуск скриптов.
#>

[CmdletBinding()]
param(
    [int]$Port = 0,          # 0 = взять порт студентов из .env или 3000
    [int]$StaffPort = 0,     # 0 = взять порт преподавателя и админа из .env или 3001
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

if ($nodeMajor -lt 22) {
    Write-Host ''
    Write-Host "Node.js v$nodeVersion — версия слишком старая." -ForegroundColor Red
    Write-Host 'Нужен Node.js 22 или новее: только для него есть готовые бинарники'
    Write-Host 'драйвера базы данных (better-sqlite3 12) — компилятор не потребуется.'
    Write-Host ''
    Write-Host 'Обновление в одну команду:' -ForegroundColor Yellow
    Write-Host '   winget install --exact --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements'
    Write-Host '   (после установки закройте и снова откройте PowerShell)'
    Write-Host ''
    exit 1
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

        # Нативный драйвер базы данных: npm 11.19+ и 12 запускают install-скрипты
        # только у пакетов из allowScripts, поэтому проверяем бинарник отдельно
        # и при необходимости доустанавливаем драйвер ещё раз явно.
        $driverBinary = Join-Path $root 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
        if (-not (Test-Path $driverBinary)) {
            Write-Note 'Готовый бинарник драйвера базы данных не установился — ставлю его отдельно.'
            & npm install better-sqlite3@^12 --no-audit --no-fund
            if (Test-Path $driverBinary) {
                Write-Ok 'Драйвер базы данных (better-sqlite3) установлен.'
            } else {
                Write-Note 'Скачать готовый бинарник не удалось: он берётся с github.com.'
                Write-Note 'Если сеть ограничена прокси или антивирусом — повторите в другой сети:'
                Write-Note '   npm install better-sqlite3@^12'
                Write-Note 'Работа без него возможна, но на Node.js 24 встроенный SQLite может падать —'
                Write-Note 'см. подсказки ниже и npm run doctor.'
            }
        } else {
            Write-Ok 'Драйвер базы данных (better-sqlite3) на месте.'
        }
    }
}

# --- 2. Файл настроек ------------------------------------------------------
$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) {
    Write-Step 'Создаю файл настроек .env'
    Copy-Item (Join-Path $root '.env.example') $envPath
    Write-Ok 'Файл .env создан из .env.example'
    Write-Note 'Учётные записи из .env: администратор admin и преподаватель ivanova.'
    Write-Note 'Пароли заданы там же (ADMIN_PASSWORD и DEMO_TEACHER_PASSWORD) — для'
    Write-Note 'работы вне сети их лучше заменить на свои. Если в пароле есть # или ;,'
    Write-Note 'значение берите в кавычки: ADMIN_PASSWORD="Admin#2026pass".'
} else {
    Write-Step 'Файл настроек .env уже существует (оставляю без изменений)'
}

# --- 3. Проверка драйвера базы данных --------------------------------------
# Отдельный процесс: если нативный модуль падает, мы увидим понятное сообщение
# вместо загадочного «Assertion failed» из недр Node.js.
Write-Step 'Проверяю драйвер базы данных (npm run dbcheck)'
& node scripts/dbcheck.js
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Драйвер базы данных не работает.' -ForegroundColor Red
    Write-Host 'Чаще всего причина в том, что npm не выполнил install-скрипты'
    Write-Host 'нативных пакетов (bcrypt, better-sqlite3) — так ведут себя npm 11.19+ и 12,'
    Write-Host 'если в package.json нет поля allowScripts.'
    Write-Host ''
    Write-Host 'Что сделать по шагам:' -ForegroundColor Yellow
    Write-Host '   1. убедитесь, что Node.js версии 22 или новее:  node -v'
    Write-Host '   2. установите драйвер с готовым бинарником:     npm install better-sqlite3@^12'
    Write-Host '   3. если npm пишет про allowScripts — выполните: npm pkg set allowScripts.better-sqlite3=true'
    Write-Host '   4. повторите:                                   npm run dbcheck'
    Write-Host ''
    Write-Host 'Подробная диагностика: npm run doctor'
    Write-Host ''
    exit 1
}
Write-Ok 'База данных и драйвер работают.'

# --- 4. База данных --------------------------------------------------------
$dbFile = Join-Path $root 'data\feedback.sqlite'

if ($Reset) {
    Write-Step 'Сброс базы данных (-Reset): удаляю старую базу'
    Remove-Item (Join-Path $root 'data\feedback.sqlite*') -Force -ErrorAction SilentlyContinue
    Write-Note 'Все ранее собранные анкеты удалены.'
}

if (-not (Test-Path $dbFile)) {
    Write-Step 'Инициализирую базу данных'
    if ($NoDemo) {
        & npm run seed
    } else {
        & npm run seed -- --demo
    }
    if ($LASTEXITCODE -ne 0) { Fail 'Не удалось создать базу данных. Смотрите сообщение выше.' }
    Write-Note 'Выше напечатаны логин и пароль администратора и демо-преподавателя — сохраните их.'
    Write-Note 'Без -NoDemo создаются дисциплины «Информатика», «Программирование», «Базы данных»'
    Write-Note 'с темами занятий и примерами анонимных ответов: отчёты и выгрузки не будут пустыми.'
} else {
    Write-Step 'База данных уже есть (данные сохранены)'
    Write-Ok "Файл: $dbFile"
    Write-Note 'Добавить дисциплины, темы и примеры ответов:  npm run seed -- --demo'
    Write-Note 'Сбросить всё и создать базу заново:          .\start.ps1 -Reset'
}

# --- 5. Запуск -------------------------------------------------------------

function Read-EnvFileValue([string]$name, [string]$fallback) {
    <# Значение из .env; если его там нет — fallback. #>
    if (Test-Path $envPath) {
        foreach ($line in Get-Content $envPath) {
            if ($line -match "^\s*$name\s*=\s*(.*)$") {
                $value = $Matches[1].Trim().Trim('"').Trim("'")
                if ($value) { return $value }
            }
        }
    }
    return $fallback
}

if ($Port -gt 0) { $env:PORT = "$Port" }
if ($StaffPort -gt 0) { $env:STAFF_PORT = "$StaffPort" }
if (-not $env:PORT) { $env:PORT = Read-EnvFileValue 'PORT' '3000' }
if (-not $env:STAFF_PORT) { $env:STAFF_PORT = Read-EnvFileValue 'STAFF_PORT' '3001' }

$studentPort = $env:PORT
$staffPort = $env:STAFF_PORT

if ($studentPort -eq $staffPort) {
    Fail 'PORT и STAFF_PORT совпадают. Сайт студентов и вход для преподавателей должны работать на разных портах (например, 3000 и 3001).'
}

$studentBase = "http://localhost:$studentPort"
$staffBase = "http://localhost:$staffPort"

Write-Host ''
Write-Host '  Адреса после запуска:' -ForegroundColor White
Write-Host ''
Write-Host '  Студенты (без входа, порт ' -NoNewline
Write-Host "$studentPort" -NoNewline -ForegroundColor Cyan
Write-Host '):'
Write-Host "    Список дисциплин:      $studentBase/"
Write-Host "    Анкета:                $studentBase/form.html"
Write-Host ''
Write-Host '  Преподаватель и администратор (порт ' -NoNewline
Write-Host "$staffPort" -NoNewline -ForegroundColor Cyan
Write-Host '):'
Write-Host "    Вход:                  $staffBase/login"
Write-Host "    Портал преподавателя:  $staffBase/portal/"
Write-Host "    Админ-панель:          $staffBase/admin/"
Write-Host ''
Write-Host "  Ссылки и QR-коды для студентов всегда ведут на $studentBase" -ForegroundColor DarkGray
Write-Host '  На студенческом порту вход, портал и админ-панель не работают (404).' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Остановить сервер: Ctrl+C в этом окне' -ForegroundColor DarkGray
Write-Host '  Проверка окружения: npm run doctor | Шпаргалка: npm run help' -ForegroundColor DarkGray
Write-Host ''

Write-Step 'Запускаю сервер'
& npm start
