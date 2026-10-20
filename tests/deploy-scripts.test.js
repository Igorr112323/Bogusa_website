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
  assert.match(s, /set -euo pipefail/);
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
  assert.equal(s.split(staffProxy).length - 1, 1, 'прокси на staff-порт пишется ровно один раз');
  assert.ok(s.indexOf('if [ -n "$STAFF_DOMAIN" ]') < s.indexOf(staffProxy), 'staff-блок nginx только при заданном STAFF_DOMAIN');
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
  assert.match(s, /Версия приложения:/, 'в итоге должен быть номер версии - по нему видно, что git pull сработал');
  const status = read(STATUS);
  assert.match(status, /версия приложения/, 'скрипт статуса тоже показывает версию');
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
    env: { ...process.env, DRY_RUN: '1', ROOT_PREFIX: tmp, APP_DIR: ROOT, DOMAIN: 'feedback.example.ru', ADMIN_EMAIL: 'me@example.ru' },
  });
  assert.equal(res.status, 0, `dry-run упал: ${res.stdout}\n${res.stderr}`);

  const env = read(path.join(tmp, ROOT, '.env'));
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^PUBLIC_BASE_URL=https:\/\/feedback\.example\.ru$/m);
  assert.match(env, /^ALLOWED_HOSTS=feedback\.example\.ru$/m);
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
    env: { ...process.env, DRY_RUN: '1', ROOT_PREFIX: tmp, APP_DIR: ROOT, DOMAIN: 'feedback.example.ru' },
  });
  assert.equal(again.status, 0);
  assert.equal(read(path.join(tmp, ROOT, '.env')), before, 'второй запуск перебивает .env');
});
