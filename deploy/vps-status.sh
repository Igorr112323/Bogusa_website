#!/usr/bin/env bash
#
# Только чтение: что уже настроено на сервере и чего не хватает.
#
#   bash deploy/vps-status.sh
#
# Никуда не записывает, ничего не перезапускает и не удаляет. Если скрипт установки
# оборвался на середине (закрылось окно SSH, не хватило батареи ноутбука) - этот
# скрипт покажет, на каком шаге встало; лечится повторным запуском deploy/vps-setup.sh,
# он идемпотентен: .env, пароль и базу не перебивает.
#
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"
OK=0
WARN=0
BAD=0

say() { printf '%s\n' "$*"; }
good() { printf '  ok    %s\n' "$*"; OK=$((OK + 1)); }
warn() { printf '  проверьте  %s\n' "$*"; WARN=$((WARN + 1)); }
bad()  { printf '  НЕТ     %s\n' "$*"; BAD=$((BAD + 1)); }

env_get() { sed -n "s/^[[:space:]]*${1}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r' | sed "s/^[\"']//; s/[\"']\$//"; }

say ""
say "=================================================="
say "  Сервис «Анонимная обратная связь»: что готово"
say "=================================================="

# --- пакеты ---------------------------------------------------------------
say ""
say "Программа и пакеты"
app_version="$(node -p 'require(process.argv[1]).version' "$APP_DIR/package.json" 2>/dev/null || echo '')"
if [ -n "$app_version" ]; then
  say "        версия приложения: $app_version"
else
  bad "в $APP_DIR нет package.json - похоже, репозиторий тут не скачан (нужен /opt/anketa)"
fi
if command -v node >/dev/null 2>&1; then
  node_version="$(node -v 2>/dev/null)"
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -ge 22 ] 2>/dev/null; then
    good "Node.js $node_version (нужен 22+)"
  else
    bad "Node.js $node_version - слишком старый, нужен 22 (сервер на нём не запустится)"
  fi
else
  bad "Node.js не установлен"
fi
for tool in nginx sqlite3 fail2ban-client ufw git certbot; do
  if command -v "$tool" >/dev/null 2>&1; then
    good "$tool установлен"
  elif [ "$tool" = certbot ]; then
    warn "certbot не установлен - нужен только для https на домене"
  else
    bad "$tool не установлен"
  fi
done
if [ -d "$APP_DIR/node_modules/express" ]; then
  good "зависимости приложения на месте (node_modules)"
else
  bad "нет node_modules - выполните: cd $APP_DIR && npm install --omit=dev"
fi

# --- фаервол --------------------------------------------------------------
say ""
say "Доступ извне"
ufw_status="$(ufw status 2>/dev/null || echo 'нет ufw')"
if printf '%s' "$ufw_status" | grep -qi 'Status: active'; then
  good "ufw включён"
  for port in 22 80 443; do
    if printf '%s' "$ufw_status" | grep -qE "^${port}/tcp +ALLOW IN"; then
      good "порт $port открыт"
    else
      bad "порт $port закрыт - студенты не дойдут до сайта"
    fi
  done
  if grep -q "listen 8080;" /etc/nginx/sites-enabled/feedback 2>/dev/null || printf '%s' "$ufw_status" | grep -qE '^8080(/tcp)? +ALLOW IN'; then
    warn "панели опубликованы на 8080 (PUBLISH_PANELS=1): вход доступен из любой сети и без шифрования - заведите домен, тогда https включится сам"
  fi
  if printf '%s' "$ufw_status" | grep -qE '^(3000|3001)/tcp +ALLOW IN'; then
    warn "порты 3000/3001 открыты наружу: панели лучше прятать за SSH-туннель (команды: ufw deny 3001, ufw delete allow 3001)"
  else
    good "порты 3000/3001 наружу закрыты (панели - через туннель)"
  fi
  if printf '%s' "$ufw_status" | grep -qE '^3389'; then
    warn "открыт 3389 (RDP) - на Linux-сервере он не нужен, закройте"
  fi
else
  bad "ufw выключен - фаервол не работает ($APP_DIR: bash deploy/vps-setup.sh шаг 3/9)"
fi

# --- SSH и перебор пароля -------------------------------------------------
say ""
say "Вход на сервер"
keys=0
if [ -s /root/.ssh/authorized_keys ]; then
  keys="$(grep -c -e 'ssh-ed25519' -e 'ssh-rsa' -e 'ecdsa-' -e 'sk-' /root/.ssh/authorized_keys 2>/dev/null || echo 0)"
fi
if [ "${keys:-0}" -ge 1 ]; then
  good "SSH-ключей в authorized_keys: $keys"
else
  warn "в /root/.ssh/authorized_keys ключей нет - вход по-прежнему только по паролю"
fi
passauth="$(sshd -T 2>/dev/null | awk '/^passwordauthentication /{print $2}' | head -n 1)"
case "$passauth" in
  no) good "вход по паролю отключён (PasswordAuthentication no)" ;;
  yes) warn "вход по паролю включён - пароль root светился в чате, его точно стоит сменить и перейти на ключ" ;;
  *) warn "не удалось прочитать Effective конфигурацию sshd (sshd -T)" ;;
esac
if command -v fail2ban-client >/dev/null 2>&1 && fail2ban-client status sshd >/dev/null 2>&1; then
  good "fail2ban: jail sshd работает (перебор пароля блокируется)"
else
  bad "fail2ban jail sshd не отвечает - выполните: systemctl enable --now fail2ban && systemctl restart fail2ban"
fi
if [ "$(passwd -S root 2>/dev/null | awk '{print $2}')" = "LK" ]; then
  warn "у root заблокирован пароль: вход по ключу есть, но через консоль провайдера не зайти"
fi

# --- .env -----------------------------------------------------------------
say ""
say "Настройки приложения (.env)"
if [ -f "$ENV_FILE" ]; then
  good ".env есть: $ENV_FILE"
  for key in NODE_ENV PUBLIC_BASE_URL ALLOWED_HOSTS JWT_SECRET ADMIN_PASSWORD; do
    value="$(env_get "$key")"
    case "$key" in
      JWT_SECRET|ADMIN_PASSWORD)
        if [ -n "$value" ]; then good "$key задан"; else bad "$key пуст - вход и сессии будут ненадёжны"; fi ;;
      *)
        if [ -n "$value" ]; then good "$key=$value"; else bad "$key пуст"; fi ;;
    esac
  done
  [ "$(env_get COOKIE_SECURE)" = "true" ] && good "COOKIE_SECURE=true" || warn "COOKIE_SECURE=false (нормально, пока сайт по http://IP)"
  allow_hosts="$(env_get ALLOWED_HOSTS)"
  case "$allow_hosts" in
    "") bad "ALLOWED_HOSTS пуст: ссылки и QR-коды будут вести на localhost, студент откроет пустую страницу" ;;
    *localhost*|*127.0.0.1*) warn "в ALLOWED_HOSTS только локальные адреса ($allow_hosts) - по IP сервера ссылки не откроются" ;;
    *) good "ALLOWED_HOSTS=$allow_hosts - ссылки и QR-код поведут на сайт, а не на localhost" ;;
  esac
  case "$(env_get PUBLIC_BASE_URL)" in
    http://localhost*|https://localhost*|http://127.0.0.1*) bad "PUBLIC_BASE_URL = локальный адрес, студенты по такой ссылке не откроют анкету" ;;
  esac
else
  bad ".env нет - настройки не созданы (bash deploy/vps-setup.sh шаг 7/9)"
fi

# --- база и служба --------------------------------------------------------
say ""
say "Сервис и база"
db_file="$(env_get DB_FILE)"
[ -n "$db_file" ] || db_file="$APP_DIR/data/feedback.sqlite"
if [ -f "$db_file" ]; then
  size="$(du -h "$db_file" 2>/dev/null | cut -f1)"
  good "база на месте: $db_file ($size)"
  unit_owner="$(awk -F= '/^User=/{print $2; exit}' /etc/systemd/system/feedback.service 2>/dev/null)"
  db_owner="$(stat -c '%U' "$db_file" 2>/dev/null)"
  if [ -n "$unit_owner" ] && [ -n "$db_owner" ] && [ "$unit_owner" != "$db_owner" ] && [ "$unit_owner" != "root" ]; then
    bad "базой владеет $db_owner, а служба работает от $unit_owner - починка: chown -R $unit_owner '$(env_get DATA_DIR || echo "$APP_DIR/data")' && systemctl restart feedback"
  elif [ -n "$unit_owner" ] && [ -n "$db_owner" ]; then
    good "владелец базы ($db_owner) совпадает с пользователем службы ($unit_owner)"
  fi
  users="$(sqlite3 "$db_file" 'select count(*) from users;' 2>/dev/null || echo '')"
  resp="$(sqlite3 "$db_file" 'select count(*) from responses;' 2>/dev/null || echo '')"
  [ -n "$users" ] && good "учётных записей: $users" || warn "базу не прочитать через sqlite3 - проверьте: sqlite3 $db_file 'PRAGMA integrity_check;'"
  [ -n "$resp" ] && say "        ответов в базе: $resp"
  if [ "$users" = "0" ]; then bad "в базе нет ни одной учётной записи - выполните: cd $APP_DIR && npm run seed"; fi
else
  bad "базы нет ($db_file) - выполните: cd $APP_DIR && npm run seed"
fi
if systemctl list-unit-files feedback.service >/dev/null 2>&1 && [ -n "$(systemctl list-unit-files 'feedback.service' 2>/dev/null | grep feedback)" ]; then
  good "служба feedback зарегистрирована в systemd"
  [ "$(systemctl is-enabled feedback 2>/dev/null)" = "enabled" ] && good "включается сама при запуске сервера" \
    || warn "служба не включена в автозапуск: systemctl enable feedback"
  case "$(systemctl is-active feedback 2>/dev/null)" in
    active)
      good "служба работает"
      restarts="$(systemctl show feedback -p NRestarts --value 2>/dev/null || echo 0)"
      [ "${restarts:-0}" -gt 3 ] 2>/dev/null && warn "служба перезапускалась $restarts раз - смотрите journalctl -u feedback -n 50" || true ;;
    *) bad "служба не запущена - логи: journalctl -u feedback -n 50 --no-pager" ;;
  esac
else
  bad "службы feedback нет - bash deploy/vps-setup.sh шаг 8/9"
fi

# --- nginx / http ---------------------------------------------------------
say ""
say "Веб-сервер"
if [ -x "$(command -v nginx)" ]; then
  if nginx -t >/dev/null 2>&1; then good "конфиг nginx корректен"; else bad "nginx -t ругается: $(nginx -t 2>&1 | tail -n 1)"; fi
  if [ -e /etc/nginx/sites-enabled/feedback ]; then good "сайт feedback подключён"; else bad "нет /etc/nginx/sites-enabled/feedback - шаг 8/9"; fi
fi
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/ 2>/dev/null)"
  code="${code:-000}"
  case "$code" in
    200) good "по http://127.0.0.1/ nginx отдаёт страницу (код 200)" ;;
    000) bad "порт 80 не отвечает: nginx не работает или слушает другой порт" ;;
    *) warn "порт 80 отвечает кодом $code - обычно означает, что прокси до приложения не дошёл" ;;
  esac
  app_port="$(env_get PORT)"; app_port="${app_port:-3000}"
  code_app="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${app_port}/healthz" 2>/dev/null)"
  code_app="${code_app:-000}"
  if [ "$code_app" = "200" ]; then good "само приложение отвечает на :${app_port}"; else warn "порт приложения :${app_port} не отвечает (код $code_app) - логи: journalctl -u feedback -n 50"; fi
  staff_port="$(env_get STAFF_PORT)"; staff_port="${staff_port:-3001}"
  code_staff="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${staff_port}/login" 2>/dev/null)"
  code_staff="${code_staff:-000}"
  if [ "$code_staff" = "200" ]; then good "панели отвечают на 127.0.0.1:${staff_port} (доступ по SSH-туннелю)"; else warn "порт панелей :${staff_port} не отвечает (код $code_staff)"; fi
fi
if [ -d /etc/letsencrypt/live ] && [ -n "$(ls /etc/letsencrypt/live 2>/dev/null | grep -v README)" ]; then
  good "сертификат Let's Encrypt выдан: $(ls /etc/letsencrypt/live | grep -v README | head -n 1)"
else
  warn "сертификата нет - сайт работает по http; для https нужен домен и DOMAIN=ваш.домен ADMIN_EMAIL=вы@почта bash deploy/vps-setup.sh"
fi

# --- что видит посетитель извне --------------------------------------------
# это главный ответ на "почему не открывается": слушает ли nginx и проходит ли
# запрос через фаервол на публичный адрес
say ""
say "Что видит посетитель извне"
pub_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
site_conf="/etc/nginx/sites-enabled/feedback"
listen_ports="$(grep -hoE 'listen [0-9]+' "$site_conf" 2>/dev/null | awk '{print $2}' | sort -un | tr '\n' ' ')"
[ -n "${listen_ports// /}" ] || listen_ports="80 "
for port in $listen_ports; do
  if [ -z "$(ss -lnt 2>/dev/null | awk -v p="$port" '$4 ~ (":" p "$") { print; exit }')" ]; then
    bad "порт $port: nginx его не слушает - проверьте: nginx -t && systemctl status nginx --no-pager | head -20"
    continue
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://${pub_ip:-127.0.0.1}:${port}/" 2>/dev/null || true)"
  code="${code:-000}"
  if [ "$code" = "000" ]; then
    if ufw status 2>/dev/null | grep -qE "^${port}(/tcp)? +ALLOW IN"; then
      bad "порт $port: приложение слушает, но запрос на ${pub_ip}:${port} не проходит - фильтр провайдера или iptables в обход ufw"
    else
      bad "порт $port: правила нет в ufw - откройте его: cd $APP_DIR && PUBLISH_PANELS=1 bash deploy/vps-setup.sh"
    fi
  elif [ "$code" = "404" ]; then
    warn "порт $port: корень отвечает 404 - для панелей это норма, проверьте /login и /admin/"
  else
    good "порт $port: на ${pub_ip:-127.0.0.1}:${port} отвечает с кодом $code"
  fi
done
if ! grep -q "listen 8080;" "$site_conf" 2>/dev/null; then
  warn "панели не опубликованы (:8080 и :8090 в конфиге нет) - вход только через ssh -L 3001:localhost:3001"
fi

# --- бэкапы ---------------------------------------------------------------
say ""
say "Бэкапы"
if [ -f /etc/cron.d/feedback-backup ] || crontab -l 2>/dev/null | grep -q feedback-backup; then
  good "задание на ежедневную копию базы стоит"
else
  bad "копия базы не настроена: диск с базой - единственное место, где живут ответы студентов"
fi
if [ -d /var/backups/feedback ] && ls /var/backups/feedback/feedback-*.sqlite.gz >/dev/null 2>&1; then
  newest="$(ls -1t /var/backups/feedback/feedback-*.sqlite.gz | head -n 1)"
  good "копии есть, свежая: $(basename "$newest") ($(du -h "$newest" | cut -f1))"
  say "        раз в неделю скачивайте её к себе: scp root@СЕРВЕР:$newest ./"
else
  warn "копий пока нет - первое срабатывание в 03:00; можно сделать сейчас: bash $APP_DIR/deploy/backup.sh"
fi

# --- итог -----------------------------------------------------------------
say ""
say "=================================================="
if [ "$BAD" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  say "  Всё готово: $OK пунктов, замечаний нет."
elif [ "$BAD" -eq 0 ]; then
  say "  Работает: $OK пунктов. Замечаний: $WARN (обычно это про https и ключ SSH)."
else
  say "  Работает: $OK пунктов. Замечаний: $WARN. Не сделано: $BAD."
  say ""
  say "  Чаще всего лечится повторным запуском установки (он ничего уже сделанного не ломает):"
  say "    cd $APP_DIR && bash deploy/vps-setup.sh"
fi
say ""
say "  Куда смотреть в браузере:"
base="$(env_get PUBLIC_BASE_URL)"
say "    анкеты:        ${base:-http://АДРЕС_СЕРВЕРА/}"
say "    вход и панели: http://localhost:3001/login  (после ssh -L 3001:localhost:3001 root@АДРЕС_СЕРВЕРА)"
say "=================================================="
[ "$BAD" -eq 0 ] || exit 1
exit 0
