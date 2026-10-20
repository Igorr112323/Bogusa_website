'use strict';

/**
 * Проверка файлов установки на VPS: `deploy/vps-setup.sh`, `deploy/feedback.service`,
 * `deploy/backup.sh`.
 *
 * Скрипт запускают раз и в панике (сервер только что куплен, доступ по паролю,
 * рядом открыт порт 3389), поэтому важны именно его свойства:
 *  - он не должен ни о чём спрашивать: интерактивный `ufw enable` съедает следующую
 *    строку вставленного блока, и фаервол остаётся выключенным;
 *  - он не должен перетирать `.env` и пароль администратора при повторном запуске;
 *  - вход по паролю он отключает только когда в `authorized_keys` уже лежит ключ,
 *    иначе владелец сервера остаётся за дверью;
 *  - порты приложения (3000/3001) наружу не открываются, панели - через туннель.
 *
 * Последняя проверка запускает скрипт в режиме DRY_RUN с временным ROOT_PREFIX:
 * он реально генерирует `.env`, unit-файл и конфиг nginx, и мы читаем результат.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'deploy', 'vps-setup.sh');
const UNIT = path.join(ROOT, 'deploy', 'feedback.service');
const BACKUP = path.join(ROOT, 'deploy', 'backup.sh');
const STATUS = path.join(ROOT, 'deploy', 'vps-status.sh');

const read = (file) => fs.readFileSync(file, 'utf8');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const haveBash = bash.status === 0;

test('файлы deploy/ лежат в LF, без BOM (CRLF ломает shebang на сервере)', () => {
  for (const file of [SETUP, UNIT, BACKUP, STATUS]) {
    const buf = fs.readFileSync(file);
    assert.ok(!buf.includes(0x0d), `${path.basename(file)} содержит CR - bash скажет bad interpreter`);
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${path.basename(file)}: BOM не нужен`);
  }
});

test('синтаксис shell-скриптов (bash -n)', { skip: haveBash ? false : 'bash недоступен на этой платформе' }, () => {
  for (const file of [SETUP, BACKUP, STATUS]) {
    const res = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${path.basename(file)}: ${res.stderr}`);
  }
});

test('vps-setup.sh не задаёт вопросов и ничего не перетирает', () => {
  const s = read(SETUP);
  assert.match(s, /set -E?euo pipefail/);
  assert.match(s, /DEBIAN_FRONTEND=noninteractive/);
  // тот самый фиолетовый экран про sshd_config: ответы берутся из существующего конфига
  assert.match(s, /--force-confdef/);
  assert.match(s, /--force-confold/);
  assert.match(s, /ufw --force enable/, 'обычный ufw enable спрашивает "y" и глотает следующую команду');
  assert.ok(!/\bread\b\s+(-p\b|--prompt)/.test(s), 'никаких интерактивных read: ответ утащит следующую строку блока');
  for (const line of s.split('\n')) {
    if (/apt-get .*install/.test(line)) assert.match(line, /-y/, `нужен -y: ${line.trim()}`);
  }
  assert.match(s, /\[ ! -f "\$ENV_FILE" \]/, '.env создаётся только если его ещё нет');
  assert.match(s, /if \[ ! -s "\$TARGET_DIR\/\.deploy-admin-password" \]/, 'пароль генерируется один раз');
});

test('vps-setup.sh: секреты генерируются, а не хранятся в репозитории', () => {
  const s = read(SETUP);
  assert.match(s, /openssl rand -base64 48/, 'JWT_SECRET должен быть случайным');
  assert.match(s, /set_env ADMIN_PASSWORD "\$ADMIN_PASSWORD"/);
  assert.ok(!/set_env ADMIN_PASSWORD "[^"$]*"/.test(s), 'пароль не должен быть прописан в скрипте');
  assert.ok(!/chmod 644 "\$TARGET_DIR\/\.deploy-admin-password"/.test(s));
  assert.match(s, /chmod 600 "\$TARGET_DIR\/\.deploy-admin-password"/);
});

test('vps-setup.sh: пароль SSH отключает только при наличии ключа, с проверкой конфига', () => {
  const s = read(SETUP);
  const keysCheck = s.indexOf('authorized_keys');
  const disable = s.indexOf('PasswordAuthentication no');
  assert.ok(keysCheck >= 0 && disable > keysCheck, 'сначала проверяем authorized_keys, потом отключаем пароль');
  assert.match(s, /ключей нет - вход по паролю ОСТАВЛЕН/);
  assert.match(s, /00-hardening\.conf/, 'файл 00-* читается раньше 50-cloud-init.conf');
  assert.ok(s.indexOf('sshd -t') < s.indexOf('systemctl restart ssh'), 'конфиг проверяется до перезапуска ssh');
  assert.match(s, /mkdir -p "\$\(p \/run\/sshd\)"/, 'без /run/sshd sshd не перезапускается');
});

test('vps-setup.sh: наружу 80/443, порты приложения и панели - нет', () => {
  const s = read(SETUP);
  assert.match(s, /ufw allow OpenSSH/);
  assert.match(s, /ufw allow 80/);
  assert.match(s, /ufw allow 443/);
  assert.ok(!/ufw allow (3000|3001)/.test(s), '3000/3001 не должны открываться: за ними только localhost');
  const staffProxy = 'proxy_pass http://127.0.0.1:${STAFF_PORT_ENV};';
  // два способа опубликовать панели - и оба только по явному флагу владельца
  assert.equal(s.split(staffProxy).length - 1, 2, 'staff-порт проксируется из блоков STAFF_DOMAIN и PUBLISH_PANELS');
  assert.ok(s.indexOf('if [ -n "$STAFF_DOMAIN" ]') < s.lastIndexOf(staffProxy), 'staff-блок nginx только при заданном STAFF_DOMAIN');
  assert.ok(s.indexOf('if [ "$PUBLISH_PANELS" = "1" ]; then') < s.indexOf(staffProxy), 'публикация на 8080 только при PUBLISH_PANELS=1');
  assert.match(s, /client_max_body_size/);
});

test('vps-setup.sh: production-настройки ссылок и Host', () => {
  const s = read(SETUP);
  assert.match(s, /set_env PUBLIC_BASE_URL/);
  assert.match(s, /set_env ALLOWED_HOSTS/);
  assert.match(s, /set_env NODE_ENV production/);
  assert.match(s, /set_env TRUST_PROXY_HOPS 1/, 'иначе ставка на одного ученика считает IP nginx вместо IP ученика');
  assert.match(s, /set_env COOKIE_SECURE "\$\(\[ "\$SCHEME" = https \] && echo true \|\| echo false\)"/);
});

test('vps-setup.sh: репозиторий остаётся у root, службе - только data (git pull и защита кода)', () => {
  const s = read(SETUP);
  const block = s.slice(s.indexOf('owner_final="$DATA_OWNER"'), s.indexOf('unit_file='));
  assert.match(block, /chown -R root:root "\$APP_DIR"/, 'иначе git pull падает с detected dubious ownership');
  assert.ok(!/chown -R "\$DATA_OWNER:\$DATA_OWNER" "\$APP_DIR"\b/.test(block), 'весь репозиторий пользователю службы не отдаётся');
  assert.match(block, /chown -R "\$owner_final:\$owner_final" "\$APP_DIR\/data"/);
  assert.match(block, /git config --global --add safe\.directory/);
  assert.match(s, /chown -R "\$owner_final:\$owner_final" "\$APP_DIR\/data" 2>\/dev\/null \|\| true\nfi/, 'после seed файлы базы возвращаются пользователю службы');
});

test('feedback.service: перезапуск и изоляция (обычный node, без pm2)', () => {
  const u = read(UNIT);
  assert.match(u, /ExecStart=\/usr\/bin\/env node server\/index\.js/);
  assert.match(u, /Restart=always/);
  assert.match(u, /After=network-online\.target/);
  assert.match(u, /EnvironmentFile=__APP_DIR__\/\.env/);
  assert.match(u, /ReadWritePaths=__APP_DIR__\/data/);
  assert.match(u, /NoNewPrivileges=true/);
  assert.match(u, /User=__OWNER__/);
  assert.match(u, /WantedBy=multi-user\.target/);
});

test('backup.sh: копия через sqlite3 .backup с проверкой и ротацией', () => {
  const b = read(BACKUP);
  assert.match(b, /sqlite3 "\$DB_FILE" "\.backup '\$out'"/, 'cp по живой базе недопустим');
  assert.match(b, /integrity_check/);
  assert.match(b, /KEEP:-14/);
  assert.match(b, /DB_FILE=/, 'путь к базе берётся из .env, а не захардкожен');
  assert.ok(!/rm -rf /.test(b), 'в ротации нет rm -rf');
});

test('репозиторий не должен утащить пароль администратора', () => {
  const ignored = read(path.join(ROOT, '.gitignore'));
  assert.match(ignored, /\.deploy-admin-password/);
});

test('README отправляет на сервер одну команду установки', () => {
  const readme = read(path.join(ROOT, 'README.md'));
  assert.match(readme, /bash deploy\/vps-setup\.sh/);
  assert.match(readme, /DRY_RUN=1/);
  assert.match(readme, /bash deploy\/vps-status\.sh/, 'про состояние сервера тоже должно быть написано');
});

test('vps-status.sh только читает: ни одного изменения системы', () => {
  const s = read(STATUS);
  assert.match(s, /set -uo pipefail/, 'без -e: проверка не должна падать на первом же отсутствии пакета');
  assert.match(s, /\[ "\$BAD" -eq 0 \] \|\| exit 1/, 'код возврата 1, если что-то не настроено');
  const dangerous = /^\s*(systemctl|service|sed -i|rm |mv |cp |install |mkdir|touch|ufw |apt-get |apt |ln |nginx -s|fail2ban-client set|chmod|chown)\b/gm;
  assert.deepEqual(s.match(dangerous) || [], [], 'скрипт статуса не имеет права ничего менять');
  assert.ok(!/(cat|echo|printf)[^\n]*>\s*\/(etc|var|usr|run|root)\//.test(s), 'нет записи в системные файлы');
  assert.match(s, /curl -s -o \/dev\/null/);
  assert.match(s, /ALLOWED_HOSTS пуст/);
  // и главный вопрос владельца: "ссылка есть, а почему не открывается"
  assert.match(s, /Что видит посетитель извне/);
  assert.match(s, /ss -lnt/, 'сначала проверяем, слушает ли nginx порт');
  assert.match(s, /отвечает с кодом \$code/);
  assert.match(s, /правила нет в ufw - откройте его/);
  assert.match(s, /фильтр провайдера/, 'ответ должен отличаться от "внутри всё хорошо"');
  assert.match(s, /панели не опубликованы \(:8080 и :8090 в конфиге нет\)/);
});

test('vps-status.sh читает .env и не падает без него', { skip: haveBash ? false : 'bash недоступен на этой платформе' }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-status-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, '.env'), [
    'NODE_ENV=production',
    'PUBLIC_BASE_URL=https://feedback.example.ru',
    'ALLOWED_HOSTS=feedback.example.ru',
    'COOKIE_SECURE=true',
    'JWT_SECRET=abcdef',
    'ADMIN_LOGIN=admin',
    'ADMIN_PASSWORD=Sup3rSecret!',
    'PORT=3000',
    'STAFF_PORT=3001',
    `DB_FILE=${tmp}/feedback.sqlite`,
    '',
  ].join('\n'), 'utf8');

  const withEnv = spawnSync('bash', [STATUS], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, APP_DIR: tmp } });
  assert.ok(withEnv.status === 0 || withEnv.status === 1, `статус упал: ${withEnv.stderr}`);
  assert.match(withEnv.stdout, /Настройки приложения \(\.env\)/);
  assert.match(withEnv.stdout, /PUBLIC_BASE_URL=https:\/\/feedback\.example\.ru/);
  assert.match(withEnv.stdout, /ADMIN_PASSWORD задан/);
  assert.ok(!/НЕТ\s+\.env есть/.test(withEnv.stdout), 'секрет не должен попадать в вывод');
  assert.ok(!withEnv.stdout.includes('Sup3rSecret'), 'пароль администратора в выводе быть не должно');

  const empty = spawnSync('bash', [STATUS], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, APP_DIR: path.join(tmp, 'нет-такого-каталога') } });
  assert.equal(empty.status, 1, 'без .env код возврата обязан быть 1');
  assert.match(empty.stdout, /\.env нет/);
});

test('vps-setup.sh проверяет, что приложение отвечает, и не навязывает CSP', () => {
  const s = read(SETUP);
  assert.match(s, /\/healthz/, 'после запуска службы обязана быть проверка ответа приложения');
  assert.match(s, /journalctl -u feedback/, 'иначе падение сервиса выглядит как "Готово"');
  assert.match(s, /if \[ -n "\${FRAME_ANCESTORS:-}" \]/, 'FRAME_ANCESTORS меняется только по запросу');
  assert.match(s, /for attempt in 1 2 3 4 5; do[\s\S]{0,200}fail2ban-client status sshd/, 'fail2ban: сокет появляется с задержкой');
  assert.match(s, /grep -aE "not ok\|error: /, 'упавший npm test должен показывать первую ошибку, а не хвост');
  assert.match(s, /echo "  Приложение:       \$app_state"/);
  assert.match(s, /Ссылки \(в скобках код ответа/);
  assert.match(s, /code_t_hidden="\$\(probe "\$PUBLISH_PANELS_PORT" "\/admin\/"\)"/, 'скрытие админки проверяется кодом ответа');
  assert.match(s, /не скрыта со своего порта/);
  assert.match(s, /curl -sL --max-redirs 3/, 'probe следует за редиректом корня панели');
  assert.match(s, /код ответа, проверенный на сервере/);
  assert.match(s, /ВНИМАНИЕ: ссылка отвечает/);
  assert.match(s, /Версия приложения:/, 'в итоге должен быть номер версии - по нему видно, что git pull сработал');
  const status = read(STATUS);
  assert.match(status, /версия приложения/, 'скрипт статуса тоже показывает версию');
});

test('публикация панелей - по явному флагу, по умолчанию закрыта', () => {
  const s = read(SETUP);
  assert.match(s, /PUBLISH_PANELS="\$\{PUBLISH_PANELS:-keep\}"/, 'по умолчанию - повторять уже настроенное');
  assert.match(s, /ADMIN_PUBLISH_PORT="\$\{ADMIN_PUBLISH_PORT:-8090\}"/);
  assert.match(s, /if \[ "\$PUBLISH_PANELS" = "keep" \]; then[\s\S]{0,260}grep -q "listen \$\{PUBLISH_PANELS_PORT\};"/);
  assert.match(s, /PUBLISH_PANELS_PORT="\$\{PUBLISH_PANELS_PORT:-8080\}"/);
  assert.match(s, /for panel_port in "\$\{PUBLISH_PANELS_PORT\}" "\$\{ADMIN_PUBLISH_PORT\}"; do/);
  assert.match(s, /sys ufw allow "\$\{panel_port\}\/tcp"/);
  assert.match(s, /sys ufw --force delete allow "\$\{panel_port\}\/tcp"/, 'запуск без флага закрывает порт обратно');
  // ufw 0.36.2: "ufw --force allow ..." читается как "default allow" и падает
  // с "Invalid syntax" - с --force можно только enable/reset/delete
  const codeOnly = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/--force (allow|deny|reject)\b/.test(codeOnly), 'ufw не принимает --force у allow/deny/reject');
  assert.ok(!/sys ufw delete (?!allow)/.test(s), 'delete только в форме delete allow');
  assert.match(s, /не прошла команда: \$\*/, 'sys() печатает саму команду, а не "$@"');
  assert.match(s, /listen \[::\]:\$\{panel_port\};/, 'nginx слушает оба порта публикации');
  assert.match(s, /location \^~ \/admin \{ return 404; \}/, 'на порту преподавателя админки быть не должно');
  assert.match(s, /location \^~ \/portal \{ return 404; \}/, 'на порту админки кабинета преподавателя быть не должно');
  assert.match(s, /location = \/ \{ return 302 \/portal\/; \}/, 'корень порта преподавателя ведёт в кабинет');
  assert.match(s, /location = \/ \{ return 302 \/admin\/; \}/, 'корень админского порта ведёт в админку');
  assert.match(s, /proxy_set_header X-Panel \$\{panel_role\};/, 'nginx сообщает приложению, с какой панели запрос');
  assert.match(s, /error_page 404 \/404\.html;/, 'закрытая дверь должна показывать нашу страницу, а не голый nginx');
  assert.match(s, /location = \/404\.html \{ root \$\{APP_DIR\}\/public; internal; \}/);
  assert.equal(s.split('proxy_pass http://127.0.0.1:${STAFF_PORT_ENV};').length - 1, 2, 'публичных блоков на staff-порт ровно два');
  assert.match(s, /printf 'dry-run'; return 0; fi/, 'в dry-run итог не дергает сеть');
  assert.match(s, /2>\/dev\/null \|\| true\)"\n  printf '%s' "\$\{out:-000\}"/, 'отказ curl не должен обрывать итог');
  const readme = read(path.join(ROOT, 'README.md'));
  assert.match(readme, /PUBLISH_PANELS=1/);
  assert.match(readme, /:8090\/admin\//, 'в README должен быть адрес админки');
  assert.match(readme, /PUBLISH_PANELS=0/, 'и способ закрыть панели обратно');
  assert.match(readme, /пароль идёт открытым текстом|пароль в сети читается/, 'о риске должно быть написано рядом');
});

test('DOMAIN из инструкции (заглушка) не попадает в .env', { skip: haveBash ? false : 'bash недоступен на этой платформе' }, (t) => {
  // владелец скопировал строку шаблона буквально: DOMAIN=ваш-домен.ru - и ссылки с QR-кодами
  // указывали в несуществующий домен. Скрипт обязан остановиться до любых изменений.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-domain-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runSetup = (env) => spawnSync('bash', [SETUP], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', ROOT_PREFIX: path.join(tmp, 'r' + Math.random().toString(36).slice(2)), ...env },
  });

  const cyrillic = runSetup({ DOMAIN: 'ваш-домен.ru' });
  assert.equal(cyrillic.status, 1, cyrillic.stdout);
  assert.match(cyrillic.stdout, /так домены не пишутся/);
  assert.match(cyrillic.stdout, /запустите скрипт без DOMAIN/);

  const noDot = runSetup({ DOMAIN: 'localhost' });
  assert.equal(noDot.status, 1, noDot.stdout);
  assert.match(noDot.stdout, /не похоже на домен/);

  const badEmail = runSetup({ DOMAIN: 'feedback.example.ru', ADMIN_EMAIL: 'ваша@почта.ru', DOMAIN_CHECK: 'off' });
  assert.equal(badEmail.status, 1, badEmail.stdout);
  assert.match(badEmail.stdout, /нужен настоящий адрес на латинице/);

  // NXDOMAIN: домен существует только в планах владельца
  const noDns = runSetup({ DOMAIN: 'bogusa-feedback-42.invalid' });
  assert.equal(noDns.status, 1, noDns.stdout);
  assert.match(noDns.stdout, /не находится в DNS/);

  // проверка работает до mkdir и до любых записей: на диске не должно появиться ничего
  assert.deepEqual(fs.readdirSync(tmp), [], 'проверка домена обязана быть до первой записи на диск');
});

test('ошибка внутри скрипта печатается, а не обрывает вывод молча', () => {
  const s = read(SETUP);
  assert.match(s, /set -Eeuo pipefail/, '-E нужен, чтобы trap ERR работал внутри функций');
  assert.match(s, /trap .*ERR$/m, 'без trap установка обрывалась на середине и выглядела как "Готово"');
  assert.match(s, /health="\$\(curl [^)]*\|\| true\)"/, 'отказ curl (connection refused) не должен убивать скрипт');
  assert.match(s, /health="\$\(curl[\s\S]{0,160}\|\| true\)"/);
  assert.match(s, /TESTS_RESULT="\$\(grep[\s\S]{0,160}\|\| true\)"/, 'тот же ловуш pipefail в отчёте по тестам');
  assert.match(s, /if \[ "\$health" = "200" \]; then break; fi/);
  assert.match(s, /ufw status 2>\/dev\/null \| grep -qE "\^\$\{panel_port\}/, 'перед delete проверяем наличие правила');
});

test('первая копия базы делается сразу, а не к 03:00', () => {
  const s = read(SETUP);
  assert.match(s, /APP_DIR="\$APP_DIR" \/usr\/local\/bin\/feedback-backup/);
  assert.match(s, /-f "\$APP_DIR\/data\/feedback\.sqlite"/, 'копию имеет смысл делать только если база уже есть');
  assert.match(s, /first_backup="копий ещё нет"/, 'в итоге должна быть честная строка, если копии нет');
  assert.match(s, /scp root@.*:\/var\/backups\/feedback\/feedback-\*\.sqlite\.gz/);
});

test('смена пароля администратора доступна командой npm', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.equal(pkg.scripts.setadminpass, 'node scripts/set-admin-password.js');
  const script = read(path.join(ROOT, 'scripts', 'set-admin-password.js'));
  assert.match(script, /token_version = token_version \+ 1/, 'старые токены должны перестать работать');
  assert.match(script, /must_change_password = 0/);
  assert.ok(!/readline|prompt\(/.test(script), 'вопросов в скрипте быть не должно');
  const readme = read(path.join(ROOT, 'README.md'));
  assert.match(readme, /npm run setadminpass/);
});

test('DRY_RUN реально готовит .env, unit-файл и конфиг nginx', { skip: haveBash ? false : 'bash недоступен на этой платформе' }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-deploy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const res = spawnSync('bash', [SETUP], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', ROOT_PREFIX: tmp, APP_DIR: ROOT, DOMAIN: 'feedback.example.ru', ADMIN_EMAIL: 'me@example.ru', DOMAIN_CHECK: 'off' },
  });
  assert.equal(res.status, 0, `dry-run упал: ${res.stdout}\n${res.stderr}`);

  const env = read(path.join(tmp, ROOT, '.env'));
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^PUBLIC_BASE_URL=https:\/\/feedback\.example\.ru$/m);
  assert.match(env, /^ALLOWED_HOSTS=feedback\.example\.ru(,[0-9.]+)?$/m, 'домен плюс IP: доступ не теряется, пока DNS распространяется');
  assert.match(env, /^COOKIE_SECURE=true$/m, 'с доменом куки становятся Secure');
  assert.match(env, /^ADMIN_LOGIN=admin$/m);
  assert.doesNotMatch(env, /^ADMIN_PASSWORD=\s*$/m, 'пароль администратора обязан быть задан');
  assert.match(env, /^JWT_SECRET=[A-Za-z0-9_-]{40,}$/m);
  assert.match(env, /^#DEMO_TEACHER_PASSWORD=/m, 'демо-пароль из публичного .env.example должен быть выключен');
  assert.match(env, /^DB_FILE=/m);
  assert.match(env, /^FRAME_ANCESTORS=\*$/m, 'встраивание в LMS - настройка владельца, скрипт её не трогает');

  const unit = read(path.join(tmp, 'etc', 'systemd', 'system', 'feedback.service'));
  assert.ok(!unit.includes('__APP_DIR__'), 'подстановка пути не сработала');
  assert.match(unit, new RegExp(`ExecStart=/usr/bin/env node server/index\\.js`));
  assert.ok(unit.includes(`EnvironmentFile=${ROOT}/.env`.replace(/\\/g, '/')), unit.match(/EnvironmentFile=.*/)[0]);
  assert.ok(unit.includes(`WorkingDirectory=${ROOT}`.replace(/\\/g, '/')));

  const nginx = read(path.join(tmp, 'etc', 'nginx', 'sites-available', 'feedback'));
  assert.match(nginx, /server_name feedback\.example\.ru;/);
  assert.match(nginx, /proxy_pass http:\/\/feedback_student;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);

  assert.match(res.stdout, /Сайт студентов:\s+https:\/\/feedback\.example\.ru\//);

  // повторный запуск ничего не портит: .env и пароль остаются прежними
  const before = env;
  const again = spawnSync('bash', [SETUP], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', ROOT_PREFIX: tmp, APP_DIR: ROOT, DOMAIN: 'feedback.example.ru', DOMAIN_CHECK: 'off' },
  });
  assert.equal(again.status, 0);
  assert.equal(read(path.join(tmp, ROOT, '.env')), before, 'второй запуск перебивает .env');
});
