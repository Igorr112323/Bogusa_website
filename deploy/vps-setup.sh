#!/usr/bin/env bash
#
# Развёртывание на чистом VPS (Ubuntu 22.04 / 24.04, доступ root) - одна команда,
# без интерактивных вопросов: apt ничего не спрашивает, ufw не просит "y".
#
#   bash deploy/vps-setup.sh                фаервол, fail2ban, Node 22, .env, база,
#                                           systemd, nginx, бэкапы и проверка безопасности
#   DOMAIN=feedback.uni.ru bash deploy/vps-setup.sh    со своим доменом: сертификат
#                                           Let's Encrypt, https и Secure-куки
#   DRY_RUN=1 bash deploy/vps-setup.sh      ничего не ставить и не перезапускать: только
#                                           показать действия, а файлы подготовить в /tmp
#
# Переменные окружения (все необязательные):
#   DOMAIN            публичный домен без протокола; пусто - работаем по IP и по http
#   ADMIN_EMAIL       почта для Let's Encrypt (без неё certbot не запускается, а печатается команда)
#   STAFF_DOMAIN      отдельный домен для входа и панелей (иначе они доступны только через туннель)
#   STAFF_ALLOW_CIDRS   через запятую: подсети, которым разрешён доступ к панелям (например 10.0.0.0/8)
#   PUBLISH_PANELS=1    опубликовать вход и панели на порту 8080: заходить можно с любого
#                       устройства, но без шифрования; PUBLISH_PANELS_PORT - другой порт
#   DATA_OWNER        пользователь-владелец (по умолчанию feedback; если создать не удалось - root)
#   SKIP_TESTS=1      не запускать npm test
#   SSH_KEY_ONLY=off  не трогать вход по паролю, даже когда ключ уже лежит в authorized_keys
#   DRY_RUN=1, ROOT_PREFIX   режим подготовки файлов без системных изменений
#
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN="${DRY_RUN:-0}"
[ -n "${ROOT_PREFIX:-}" ] || ROOT_PREFIX=""
if [ "$DRY_RUN" = "1" ]; then
  ROOT_PREFIX="${ROOT_PREFIX:-/tmp/feedback-dryroot}"
fi

DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
STAFF_DOMAIN="${STAFF_DOMAIN:-}"
STAFF_ALLOW_CIDRS="${STAFF_ALLOW_CIDRS:-}"
# Публикация входа и панелей наружу: 0 - только SSH-туннель (безопасно по умолчанию),
# 1 - nginx будет отдавать их на отдельном порту, и заходить можно с любого устройства.
PUBLISH_PANELS="${PUBLISH_PANELS:-0}"
PUBLISH_PANELS_PORT="${PUBLISH_PANELS_PORT:-8080}"
DATA_OWNER="${DATA_OWNER:-feedback}"
SKIP_TESTS="${SKIP_TESTS:-0}"
SSH_KEY_ONLY="${SSH_KEY_ONLY:-auto}"
PUBLIC_PORT_ENV="${PORT:-3000}"
STAFF_PORT_ENV="${STAFF_PORT:-3001}"

# apt никогда не спрашивает: и про конфигы (тот самый фиолетовый экран sshd_config), и про перезапуск служб
# confdef/confold: при обновлении пакетов существующие правки конфигов сохраняются -
# тот самый вопрос про sshd_config, на который вы отвечали вручную
APT="apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
export DEBIAN_FRONTEND=noninteractive

TARGET_DIR="$ROOT_PREFIX$APP_DIR"

log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
sys() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   (dry-run) %s\n' "$*"
  else
    "$@"
  fi
}
p() { printf '%s%s' "$ROOT_PREFIX" "$1"; }   # путь с префиксом: в dry-run всё уходит в /tmp

if [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
  echo "Нужны права root: bash deploy/vps-setup.sh от root или sudo -s."
  exit 1
fi

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

# --- 1. Пакеты ---------------------------------------------------------------
log "1/9 пакеты (nginx, sqlite3, ufw, fail2ban, git)"
sys $APT update -y
sys $APT -y install nginx sqlite3 ufw fail2ban git curl ca-certificates openssl acl cron unattended-upgrades

# обновления безопасности ставятся сами; это не перезагрузка, службы не роняет
sys systemctl enable --now apt-daily-upgrade.timer
if [ -n "${TIMEZONE:-}" ]; then
  sys timedatectl set-timezone "$TIMEZONE"
  note "часовой пояс: $TIMEZONE"
fi

# --- 2. Node.js 22 -----------------------------------------------------------
log "2/9 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -ge 22 ] 2>/dev/null; then
    need_node=0
    note "уже стоит $(node -v)"
  fi
fi
if [ "$need_node" = "1" ]; then
  note "ставим Node.js 22 из NodeSource"
  sys bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  sys $APT -y install nodejs
fi

# --- 3. Фаервол --------------------------------------------------------------
# --force принципиален: без него ufw задаёт вопрос про SSH, а ответ на вставленный
# блок съедает следующую команду - так на этой машине и получилось в первый раз.
log "3/9 фаервол: 22, 80, 443; порты приложения наружу не выпускаем"
sys ufw allow OpenSSH
sys ufw allow 80
sys ufw allow 443
if [ "$PUBLISH_PANELS" = "1" ]; then
  sys ufw --force allow "${PUBLISH_PANELS_PORT}/tcp"
else
  # публиковали раньше - при обычном запуске закрываем обратно
  sys ufw --force delete "${PUBLISH_PANELS_PORT}/tcp" || true
fi
sys ufw --force enable
sys ufw status verbose

# --- 4. fail2ban -------------------------------------------------------------
log "4/9 fail2ban (перебор SSH)"
mkdir -p "$(p /etc/fail2ban)"
cat > "$(p /etc/fail2ban/jail.local)" <<'EOF'
# создан deploy/vps-setup.sh
[DEFAULT]
backend = systemd

[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
EOF
sys systemctl enable --now fail2ban
sys systemctl restart fail2ban
if [ "$DRY_RUN" = "1" ]; then
  note "(dry-run) fail2ban-client status sshd"
else
  jail_ok=0
  for attempt in 1 2 3 4 5; do
    if fail2ban-client status sshd >/dev/null 2>&1; then jail_ok=1; break; fi
    sleep 2   # сокет появляется на секунду позже, чем systemd считает службу запущенной
  done
  if [ "$jail_ok" = "1" ]; then
    note "jail sshd активен: $(fail2ban-client status sshd 2>/dev/null | tr '\n' ' ' | tr -s ' ')"
  else
    note "внимание: sshd jail не отвечает - проверьте: systemctl status fail2ban --no-pager"
  fi
fi

# --- 5. SSH: вход по ключу, пароль не нужен ---------------------------------
log "5/9 SSH"
keys=0
if [ -s "$(p /root/.ssh/authorized_keys)" ]; then
  keys="$(grep -c -e 'ssh-ed25519' -e 'ssh-rsa' -e 'ecdsa-' -e 'sk-' "$(p /root/.ssh/authorized_keys)" || true)"
fi
keys="${keys:-0}"
if [ "$SSH_KEY_ONLY" = "off" ]; then
  note "SSH_KEY_ONLY=off - вход по паролю не трогаем"
elif [ "$keys" -lt 1 ]; then
  mkdir -p "$(p /run/sshd)"
  note "в /root/.ssh/authorized_keys ключей нет - вход по паролю ОСТАВЛЕН"
  note "ключ генерируют НА СВОЁМ КОМПЬЮТЕРЕ (PowerShell: ssh-keygen -t ed25519), а не на сервере"
  note "его публичную часть - в /root/.ssh/authorized_keys, затем запустить скрипт ещё раз"
else
  note "ключей в authorized_keys: $keys - отключаем вход по паролю для root"
  mkdir -p "$(p /etc/ssh/sshd_config.d)" "$(p /run/sshd)"   # /run/sshd нужен sshd при рестарте
  cat > "$(p /etc/ssh/sshd_config.d/00-hardening.conf)" <<'EOF'
# создан deploy/vps-setup.sh: файл читается раньше 50-cloud-init.conf, поэтому значение имеет силу
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 4
LoginGraceTime 30
EOF
  if [ "$DRY_RUN" != "1" ]; then
    if sshd -t; then
      systemctl restart ssh
      note "проверено: sshd -t ок, служба перезапущена"
    else
      note "внимание: sshd -t ругается - конфиг НЕ применён, вход по паролю всё ещё работает"
    fi
  else
    note "(dry-run) sshd -t && systemctl restart ssh"
  fi
fi

# --- 6. Зависимости приложения ----------------------------------------------
log "6/9 зависимости приложения"
if [ -d "$APP_DIR/node_modules" ] && [ "$DRY_RUN" != "1" ]; then
  note "node_modules уже есть - npm install пропущен"
else
  sys npm install --omit=dev --no-audit --no-fund
fi

# --- 7. .env ----------------------------------------------------------------
log "7/9 настройки .env"
if [ -z "$DOMAIN" ]; then
  BASE_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  BASE_HOST="${BASE_HOST:-127.0.0.1}"
  SCHEME=http
  note "домен не задан - работаем по http://$BASE_HOST (для теста этого хватает)"
else
  BASE_HOST="$DOMAIN"
  SCHEME=https
fi

ENV_FILE="$TARGET_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    note ".env создан из .env.example"
  else
    : > "$ENV_FILE"
    note ".env создан пустой"
  fi
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# Пароль администратора генерируется один раз и остаётся в файле: при повторном
# запуске скрипта он подхватится, и доступ не собьётся.
if [ ! -s "$TARGET_DIR/.deploy-admin-password" ]; then
  gen="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 17)Aa1"
  printf '%s\n' "$gen" > "$TARGET_DIR/.deploy-admin-password"
fi
chmod 600 "$TARGET_DIR/.deploy-admin-password" "$ENV_FILE"
ADMIN_PASSWORD="$(tr -d '\r\n' < "$TARGET_DIR/.deploy-admin-password")"

set_env NODE_ENV production
set_env HOST 0.0.0.0
set_env PORT "$PUBLIC_PORT_ENV"
set_env STAFF_PORT "$STAFF_PORT_ENV"
set_env TRUST_PROXY_HOPS 1
set_env PUBLIC_BASE_URL "$SCHEME://$BASE_HOST"
set_env ALLOWED_HOSTS "$BASE_HOST"
set_env COOKIE_SECURE "$([ "$SCHEME" = https ] && echo true || echo false)"
# секрет оставляем, если он уже был: иначе при повторном запуске у всех слетят сессии
jwt_current="$(sed -n 's/^JWT_SECRET=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
if [ -z "$jwt_current" ]; then
  set_env JWT_SECRET "$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  note "JWT_SECRET сгенерирован"
else
  note "JWT_SECRET уже был в .env - оставлен как есть"
fi
set_env ADMIN_LOGIN admin
set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
# DEMO_TEACHER_PASSWORD из .env.example напечатан в публичном репозитории - убираем,
# чтобы `npm run seed -- --demo` на сервере не создал преподавателя с известным паролем
if grep -q '^DEMO_TEACHER_PASSWORD=' "$ENV_FILE"; then
  sed -i 's/^DEMO_TEACHER_PASSWORD=/#DEMO_TEACHER_PASSWORD=/' "$ENV_FILE"
  note "DEMO_TEACHER_PASSWORD закомментирован: seed сгенерирует свой и напечатает его один раз"
fi
set_env MIN_ANSWERS_TO_SHOW "${MIN_ANSWERS_TO_SHOW:-5}"
# FRAME_ANCESTORS не трогаем без запроса: значение берётся из .env.example, а кавычки
# для CSP приложение подставляет само (запись self и 'self' работают одинаково)
if [ -n "${FRAME_ANCESTORS:-}" ]; then
  set_env FRAME_ANCESTORS "$FRAME_ANCESTORS"
  note "FRAME_ANCESTORS=$FRAME_ANCESTORS (встраивание анкеты ограничено)"
fi
set_env DATA_DIR "$APP_DIR/data"
set_env DB_FILE "$APP_DIR/data/feedback.sqlite"
note "PUBLIC_BASE_URL=$SCHEME://$BASE_HOST, логин админа: admin"

# --- 8. База, тесты, служба, nginx -----------------------------------------
log "8/9 база, автотесты, systemd, nginx"
mkdir -p "$TARGET_DIR/data"
if [ "$DRY_RUN" = "1" ]; then
  note "(dry-run) npm run seed, npm test, systemctl - пропущено"
  TESTS_RESULT="пропущены (dry-run)"
else
  cd "$APP_DIR"
  if [ "$(node scripts/needs-seed.js 2>/dev/null || echo empty)" = "empty" ]; then
    note "база пустая - создаём администратора"
    npm run seed
  else
    note "база уже наполнена - seed пропущен (анкеты не тронуты)"
  fi
  if [ "$SKIP_TESTS" = "1" ]; then
    TESTS_RESULT="пропущены (SKIP_TESTS=1)"
  elif npm test >/tmp/feedback-tests.log 2>&1; then
    TESTS_RESULT="$(grep -aoE '(tests|pass|fail) [0-9]+' /tmp/feedback-tests.log | tr '\n' ' ')"
    TESTS_RESULT="${TESTS_RESULT:-см. /tmp/feedback-tests.log}"
  else
    TESTS_RESULT="НЕ ПРОШЛИ - подробности выше и в /tmp/feedback-tests.log"
    grep -aE "not ok|error: |# (tests|pass|fail) " /tmp/feedback-tests.log | head -n 10 | sed 's/^/   /'
  fi
fi

owner_final="$DATA_OWNER"
if [ "$DRY_RUN" != "1" ]; then
  if ! id -u "$DATA_OWNER" >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" --comment "feedback app" "$DATA_OWNER" 2>/dev/null || true
  fi
  if id -u "$DATA_OWNER" >/dev/null 2>&1; then
    # Репозиторий остаётся собственностью root: служба не сможет переписать собственный
    # код, и `git pull` под root не падает с "detected dubious ownership". На запись
    # пользователю службы отдаём только каталог данных и файлы настроек.
    chown -R root:root "$APP_DIR" 2>/dev/null || true
    chown -R "$owner_final:$owner_final" "$APP_DIR/data" 2>/dev/null || true
    chown root:"$owner_final" "$APP_DIR/.env" "$APP_DIR/.deploy-admin-password" 2>/dev/null || true
    chmod 640 "$APP_DIR/.env" "$APP_DIR/.deploy-admin-password" 2>/dev/null || true
    git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  else
    owner_final=root
    note "не удалось создать пользователя $DATA_OWNER - служба пойдёт от root"
  fi
fi

unit_file="$(p /etc/systemd/system/feedback.service)"
mkdir -p "$(dirname "$unit_file")"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__OWNER__|$owner_final|g" "$APP_DIR/deploy/feedback.service" > "$unit_file"
sys systemctl daemon-reload
sys systemctl enable --now feedback
sys systemctl restart feedback

nginx_conf="$(p /etc/nginx/sites-available/feedback)"
mkdir -p "$(dirname "$nginx_conf")" "$(p /etc/nginx/sites-enabled)"
{
  echo "# создан deploy/vps-setup.sh; правки после этого теряются только при повторном запуске скрипта"
  echo "upstream feedback_student {"
  echo "    server 127.0.0.1:${PUBLIC_PORT_ENV};"
  echo "    keepalive 16;"
  echo "}"
  echo
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name ${DOMAIN:-_};"
  echo
  echo "    client_max_body_size 512k;"
  echo "    access_log /var/log/nginx/feedback.access.log;"
  echo
  echo "    location / {"
  echo "        proxy_pass http://feedback_student;"
  echo "        proxy_http_version 1.1;"
  echo "        proxy_set_header Host \$host;"
  echo "        proxy_set_header X-Real-IP \$remote_addr;"
  echo "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
  echo "        proxy_set_header X-Forwarded-Proto \$scheme;"
  echo '        proxy_set_header Connection "";'
  echo "    }"
  echo "}"
  if [ "$PUBLISH_PANELS" = "1" ]; then
    echo
    echo "# вход и панели на отдельном порту: доступен всем, кто знает адрес (http без шифрования)"
    echo "server {"
    echo "    listen ${PUBLISH_PANELS_PORT};"
    echo "    listen [::]:${PUBLISH_PANELS_PORT};"
    echo "    server_name _;"
    echo
    echo "    client_max_body_size 512k;"
    echo "    access_log /var/log/nginx/feedback-staff.access.log;"
    echo
    echo "    location / {"
    echo "        proxy_pass http://127.0.0.1:${STAFF_PORT_ENV};"
    echo "        proxy_set_header Host \$host;"
    echo "        proxy_set_header X-Real-IP \$remote_addr;"
    echo "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
    echo "        proxy_set_header X-Forwarded-Proto \$scheme;"
    echo "    }"
    echo "}"
  fi
  if [ -n "$STAFF_DOMAIN" ]; then
    echo
    echo "server {"
    echo "    listen 80;"
    echo "    server_name ${STAFF_DOMAIN};"
    if [ -n "$STAFF_ALLOW_CIDRS" ]; then
      echo
      echo "    # доступ к панелям только из перечисленных подсетей"
      IFS=',' read -r -a cidrs <<< "$STAFF_ALLOW_CIDRS"
      for cidr in "${cidrs[@]}"; do
        echo "    allow $(echo "$cidr" | tr -d ' ');"
      done
      echo "    deny all;"
    fi
    echo
    echo "    location / {"
    echo "        proxy_pass http://127.0.0.1:${STAFF_PORT_ENV};"
    echo "        proxy_set_header Host \$host;"
    echo "        proxy_set_header X-Forwarded-Proto \$scheme;"
    echo "    }"
    echo "}"
  fi
} > "$nginx_conf"
ln -sf "$nginx_conf" "$(p /etc/nginx/sites-enabled/feedback)"
if [ "$DRY_RUN" != "1" ]; then
  if [ -e "$(p /etc/nginx/sites-enabled/default)" ]; then
    rm -f "$(p /etc/nginx/sites-enabled/default)"
    note "дефолтный сайт nginx отключён (он занял бы порт 80)"
  fi
  if nginx -t; then
    systemctl reload nginx
    note "nginx: конфиг принят, служба перезагружена"
  else
    note "внимание: nginx -t ругается - сайт пока доступен напрямую на :${PUBLIC_PORT_ENV}"
  fi
else
  note "(dry-run) nginx -t && systemctl reload nginx"
fi

# Ответ приложения: без этого "Готово" ничего не значит (сервис мог упасть на старте)
app_state="пропущено (dry-run)"
if [ "$DRY_RUN" != "1" ]; then
  health=000
  for attempt in 1 2 3 4 5 6; do
    health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:${PUBLIC_PORT_ENV}/healthz" 2>/dev/null)"
    [ "$health" = "200" ] && break
    sleep 2
  done
  if [ "$health" = "200" ]; then
    app_state="отвечает (код 200, проверка $attempt попытки)"
  else
    app_state="НЕ отвечает (код ${health:-000}) - последние строки журнала службы:"
    echo
    printf '%s\n' "$app_state"
    journalctl -u feedback -n 25 --no-pager 2>/dev/null | tail -n 25 | sed 's/^/   /'
    app_state="НЕ отвечает - код ${health:-000}, смотри журнал выше"
  fi
fi

# Let's Encrypt - только когда есть домен и почта
certbot_state="пропущен (домен не задан: сертификат выдаётся только на домен)"
if [ -n "$DOMAIN" ] && [ "$DRY_RUN" != "1" ]; then
  if [ -n "$ADMIN_EMAIL" ]; then
    sys $APT -y install certbot python3-certbot-nginx
    if certbot --nginx -d "$DOMAIN" -m "$ADMIN_EMAIL" --non-interactive --agree-tos --redirect; then
      set_env COOKIE_SECURE true
      set_env PUBLIC_BASE_URL "https://$DOMAIN"
      systemctl restart feedback
      certbot_state="выдан и автопродлевается nginx-плагином"
    else
      certbot_state="ошибка - проверьте, что A-запись $DOMAIN указывает на этот сервер"
    fi
  else
    certbot_state="нет ADMIN_EMAIL - выполните: certbot --nginx -d $DOMAIN -m you@mail.ru --agree-tos -n --redirect"
  fi
fi

# --- 9. Бэкапы ---------------------------------------------------------------
log "9/9 ежедневный бэкап базы"
mkdir -p "$(p /usr/local/bin)" "$(p /etc/cron.d)" "$(p /var/backups/feedback)"
install -m 755 "$APP_DIR/deploy/backup.sh" "$(p /usr/local/bin/feedback-backup)"
# seed и setadminpass запускаются под root - после них файлы базы возвращаем пользователю службы
if [ "$owner_final" != "root" ]; then
  chown -R "$owner_final:$owner_final" "$APP_DIR/data" 2>/dev/null || true
fi
cat > "$(p /etc/cron.d/feedback-backup)" <<EOF
# создан deploy/vps-setup.sh: копия базы в 03:00, хранятся 14 дней
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root APP_DIR=$APP_DIR BACKUP_DIR=$ROOT_PREFIX/var/backups/feedback /usr/local/bin/feedback-backup >> /var/log/feedback-backup.log 2>&1
EOF
chmod 644 "$(p /etc/cron.d/feedback-backup)"

# --- Итог --------------------------------------------------------------------
echo
echo "=================================================================="
echo "  Готово"
echo "  Версия приложения: $(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?')  (если вместо номера стоит ?, git pull не сработал)"
echo "=================================================================="
echo "  Сайт студентов:   $SCHEME://$BASE_HOST/"
if [ -z "$DOMAIN" ]; then
  echo "  Внимание: http без сертификата - анкеты идут по сети открытым текстом. Как только"
  echo "  домен будет, пустите скрипт ещё раз: DOMAIN=ваш.домен ADMIN_EMAIL=вы@почта bash deploy/vps-setup.sh"
fi
echo "  Анкета:           $SCHEME://$BASE_HOST/form.html"
echo "  Проверка:         systemctl status feedback --no-pager"
echo "  Логи:             journalctl -u feedback -n 50 --no-pager"
echo "  Приложение:       $app_state"
echo "  Автотесты:        $TESTS_RESULT"
echo "  Let's Encrypt:    $certbot_state"
echo "  Вход и панели:"
if [ "$PUBLISH_PANELS" = "1" ]; then
  echo "    http://$BASE_HOST:$PUBLISH_PANELS_PORT/login   (опубликовано: PUBLISH_PANELS=1)"
  echo "    внимание: вход идёт по http, пароль в сети читается любыми - заведите домен и"
  echo "    пустите скрипт с DOMAIN=..., после этого сертификат и https включятся сами"
elif [ -n "$STAFF_DOMAIN" ]; then
  echo "    http://$STAFF_DOMAIN/login   (на сервере порт $STAFF_PORT_ENV наружу не открыт)"
else
  echo "    на своём компьютере:  ssh -L 3001:localhost:3001 root@$BASE_HOST"
  echo "    затем в браузере:       http://localhost:3001/login"
fi
echo "  Логин администратора: admin, пароль - в файле $APP_DIR/.deploy-admin-password"
echo "                        (cat $APP_DIR/.deploy-admin-password)"
echo "  Бэкапы:  $ROOT_PREFIX/var/backups/feedback (ежедневно в 03:00); скопируйте хотя бы раз в неделю к себе"
echo "  Проверка безопасности: cd $APP_DIR && npm run secaudit -- --student $SCHEME://$BASE_HOST --staff http://127.0.0.1:$STAFF_PORT_ENV"
echo "=================================================================="
