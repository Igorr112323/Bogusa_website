#!/usr/bin/env bash
#
# Установка и запуск сервиса «Анонимная обратная связь» на macOS и Linux.
#
#   ./start.sh                 обычный запуск (установка при необходимости + сервер)
#   ./start.sh --port 8080     другой порт для студентов
#   ./start.sh --staff-port 8081   другой порт для преподавателя и администратора
#   ./start.sh --no-demo       пустая база, без демонстрационных данных
#   ./start.sh --reset         пересоздать базу (удалит текущие анкеты!)
#   ./start.sh --skip-install  не запускать npm install
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT=""
STAFF_PORT=""
NO_DEMO=0
SKIP_INSTALL=0
RESET_FLAG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --staff-port) STAFF_PORT="${2:-}"; shift 2 ;;
    --no-demo) NO_DEMO=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --reset|--force) RESET_FLAG=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (см. ./start.sh --help)"; exit 1 ;;
  esac
done

step() { printf '\n» %s\n' "$1"; }
ok() { printf '  %s\n' "$1"; }
warn() { printf '  %s\n' "$1"; }
fail() { printf '\nОШИБКА: %s\n' "$1" >&2; exit 1; }

printf '\n  Анонимная обратная связь — установка и запуск\n'
printf '  Каталог проекта: %s\n' "$ROOT"

# --- 1. Node.js -------------------------------------------------------------
step 'Проверяю Node.js'
command -v node >/dev/null 2>&1 || fail 'Node.js не найден. Установите LTS-версию: https://nodejs.org/ (macOS: brew install node)'
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
ok "Node.js v${NODE_VERSION}"
[ "$NODE_MAJOR" -ge 18 ] || fail "Нужен Node.js 18.18+ (у вас v${NODE_VERSION}). Обновите Node.js."
[ "$NODE_MAJOR" -ge 20 ] || warn 'Совет: надёжнее Node.js 22 LTS — в нём есть встроенный драйвер SQLite.'
command -v npm >/dev/null 2>&1 || fail 'npm не найден. Установите Node.js заново.'

# --- 2. Зависимости ---------------------------------------------------------
if [ "$SKIP_INSTALL" -eq 0 ]; then
  if [ -d node_modules ]; then
    step 'Зависимости уже установлены (пропускаю npm install)'
  else
    step 'Устанавливаю зависимости (npm install, 1–3 минуты)'
    npm install --no-audit --no-fund || fail 'npm install завершился с ошибкой. Повторите позже: npm install'
    ok 'Зависимости установлены.'
  fi
fi

# --- 3. Настройки -----------------------------------------------------------
if [ ! -f .env ]; then
  step 'Создаю файл настроек .env'
  cp .env.example .env
  ok '.env создан из .env.example (администратор admin, демо-преподаватель ivanova)'
  warn 'Пароли заданы в .env: ADMIN_PASSWORD и DEMO_TEACHER_PASSWORD — замените их на свои.'
  warn 'Если в пароле есть # или ; — заключайте значение в кавычки: ADMIN_PASSWORD="Admin#2026pass"'
else
  step 'Файл настроек .env уже существует (оставляю без изменений)'
fi

# --- 3.5 Проверка драйвера базы данных --------------------------------------
step 'Проверяю драйвер базы данных (npm run dbcheck)'
if ! node scripts/dbcheck.js; then
  warn 'Драйвер базы данных не работает.'
  warn 'Обычно помогает: npm install better-sqlite3@^12 (нужны Node.js 22+ и интернет)'
  warn 'Диагностика: npm run doctor'
  exit 1
fi

# --- 4. База данных ---------------------------------------------------------
DB_FILE="$ROOT/data/feedback.sqlite"

if [ "$RESET_FLAG" -eq 1 ]; then
  step 'Сброс базы данных (--reset)'
  rm -f "$ROOT"/data/feedback.sqlite*
  warn 'Все ранее собранные анкеты удалены.'
fi

if [ ! -f "$DB_FILE" ]; then
  step 'Инициализирую базу данных'
  if [ "$NO_DEMO" -eq 1 ]; then npm run seed; else npm run seed -- --demo; fi
  warn 'Логины и пароли напечатаны выше — сохраните их.'
  warn 'Без --no-demo создаются дисциплины с темами и примеры анонимных ответов.'
else
  step 'База данных уже есть (данные сохранены)'
  ok "Файл: $DB_FILE"
  warn 'Добавить дисциплины, темы и примеры ответов: npm run seed -- --demo'
  warn 'Создать тестового преподавателя «test» с 5 дисциплинами и 20 темами:'
  warn '                                            npm run seed:test'
fi

# --- 5. Запуск --------------------------------------------------------------
env_value() {
  # $1 — имя переменной, $2 — значение по умолчанию
  local value
  value="$(grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\"' | tr -d "'" | tr -d '[:space:]')"
  [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$2"
}

[ -n "$PORT" ] && export PORT="$PORT"
[ -n "$STAFF_PORT" ] && export STAFF_PORT="$STAFF_PORT"
EFFECTIVE_PORT="${PORT:-$(env_value PORT 3000)}"
EFFECTIVE_STAFF_PORT="${STAFF_PORT:-$(env_value STAFF_PORT 3001)}"
export PORT="$EFFECTIVE_PORT"
export STAFF_PORT="$EFFECTIVE_STAFF_PORT"

if [ "$EFFECTIVE_PORT" = "$EFFECTIVE_STAFF_PORT" ]; then
  fail 'PORT и STAFF_PORT совпадают: сайту студентов и входу для преподавателей нужны разные порты.'
fi

STUDENT_BASE="http://localhost:${EFFECTIVE_PORT}"
STAFF_BASE="http://localhost:${EFFECTIVE_STAFF_PORT}"

printf '\n  Адреса для проверки:\n'
printf '    Студенты:              %s/            (и %s/form.html)\n' "$STUDENT_BASE" "$STUDENT_BASE"
printf '    Вход:                  %s/login\n' "$STAFF_BASE"
printf '    Преподаватель:         %s/portal/\n' "$STAFF_BASE"
printf '    Админ-панель:          %s/admin/\n' "$STAFF_BASE"
printf '\n  Ссылки и QR-коды для студентов ведут на %s\n' "$STUDENT_BASE"
printf '\n  Остановить сервер: Ctrl+C\n\n'

step 'Запускаю сервер'
exec npm start
