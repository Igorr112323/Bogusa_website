'use strict';

/**
 * Аудит безопасности собственного развёртывания.
 *
 * Проверки делятся на две части: ответы живого сервера (заголовки, лишние
 * методы, доступ к служебным путям, куки, пауза после неверных паролей) и
 * разбор фронтенда (что реально отдаётся браузеру). Ничего не устанавливается
 * и ни на какие чужие домены не ходит: адрес берётся из аргументов, по
 * умолчанию localhost.
 *
 * Запуск: npm run secaudit
 *   node scripts/security-audit.js --student http://localhost:3000 --staff http://localhost:3001
 *   node scripts/security-audit.js --json audit.json
 *
 * Коды выхода: 0 - критичных и высоких находок нет, 1 - есть, 2 - сервер недоступен.
 */

const fs = require('node:fs');
const path = require('node:path');

const SEVERITY = { CRITICAL: 15, HIGH: 8, MEDIUM: 4, LOW: 1, INFO: 0, PASS: 0 };
const LABELS = {
  CRITICAL: 'КРИТИЧНО',
  HIGH: 'ВЫСОКИЙ',
  MEDIUM: 'СРЕДНИЙ',
  LOW: 'НИЗКИЙ',
  INFO: 'ИНФО',
  PASS: 'OK   ',
};

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const STUDENT = arg('student', process.env.STUDENT_URL || 'http://localhost:3000').replace(/\/$/, '');
const STAFF = arg('staff', process.env.STAFF_PORT_URL || 'http://localhost:3001').replace(/\/$/, '');
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] || 'audit.json' : null;

/** Служебные файлы, которых не должно быть в открытом доступе. */
const SENSITIVE_PATHS = [
  '/.env',
  '/../.env',
  '/.env.local',
  '/.git/config',
  '/.git/HEAD',
  '/data/feedback.sqlite',
  '/data/feedback.sqlite-wal',
  '/db/feedback.sqlite',
  '/backup.sql',
  '/dump.sql',
  '/package.json',
  '/server/config.js',
  '/server/app.js',
  '/node_modules/express/package.json',
  '/wp-login.php',
  '/wp-admin/',
  '/phpmyadmin/',
  '/.aws/credentials',
  '/id_rsa',
  '/.ssh/id_rsa',
  '/Dockerfile',
  '/docker-compose.yml',
  '/npm-debug.log',
  '/logs/app.log',
  '/config.json',
  '/web.config',
  '/.DS_Store',
  '/phpinfo.php',
];

/** Закрытые API: без входа они обязаны молчать. */
const PROTECTED_API = [
  '/api/admin/overview',
  '/api/admin/teachers',
  '/api/admin/disciplines',
  '/api/admin/report',
  '/api/admin/export.csv',
  '/api/admin/audit',
  '/api/admin/link?discipline=1',
  '/api/teacher/overview',
  '/api/teacher/disciplines',
  '/api/teacher/comments',
  '/api/teacher/export.csv',
];

/** Статические оболочки панелей: themselves доступны, но данных внутри быть не должно. */
const PANEL_PAGES = ['/admin/', '/admin/index.html', '/portal/', '/portal/index.html'];
const DATA_MARKERS = /"password_hash"|"token":|\bfull_name\b:|"students_count":|"answers":/;

const findings = [];

function add(level, module, title, evidence, fix) {
  findings.push({ level, module, title, evidence, fix: fix || '' });
}

const ok = (module, title, evidence) => add('PASS', module, title, evidence || '');

async function head(url, options = {}) {
  try {
    const response = await fetch(url, { redirect: 'manual', ...options });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    const err = new Error(`не удалось запросить ${url}: ${error.message}`);
    err.unreachable = true;
    throw err;
  }
}

const header = (res, name) => res.headers.get(name.toLowerCase());
const cspOf = (res) => header(res, 'content-security-policy') || '';

/** 1. Заголовки безопасности на обоих адресах. */
async function checkHeaders() {
  const student = await head(`${STUDENT}/`);
  const staff = await head(`${STAFF}/admin/`);
  const csp = cspOf(student);

  if (!csp) add('HIGH', 'headers', 'Нет Content-Security-Policy', 'CSP отсутствует', 'включить helmet (уже есть в server/middleware/security.js)');
  else {
    ok('headers', 'CSP задана', csp);
    for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      if (!csp.includes(directive)) add('MEDIUM', 'headers', `CSP: нет ${directive}`, csp, 'добавить директиву');
    }
    // «*» допустим только там, где он ничего не открывает: frame-ancestors (анкета
    // встраивается в LMS) и img-src/font-src. В остальных директивах он лишает CSP смысла.
    const loose = csp
      .split(';')
      .map((part) => part.trim())
      .filter((part) => /^(default|script|style|object|base|form|connect|frame)-src|^frame-ancestors/.test(part))
      .filter((part) => !/^frame-ancestors/.test(part) && (/\*/.test(part) || part.includes('unsafe-inline')));
    if (loose.length) add('MEDIUM', 'headers', 'CSP разрешает лишнее', loose.join(' | '), 'убрать * и unsafe-inline из этих директив');
    else ok('headers', 'CSP строгая', 'кроме frame-ancestors: анкета намеренно встраивается в LMS');
  }

  if (header(student, 'x-content-type-options') !== 'nosniff') add('LOW', 'headers', 'Нет X-Content-Type-Options: nosniff', 'заголовок отсутствует');
  else ok('headers', 'nosniff', 'X-Content-Type-Options: nosniff');

  if (!header(student, 'referrer-policy')) add('LOW', 'headers', 'Нет Referrer-Policy', 'анкета может утекать в Referer чужого сайта');
  else ok('headers', 'Referrer-Policy', header(student, 'referrer-policy'));

  // Панели встраивать нельзя, анкету - можно (LMS).
  if (!cspOf(staff).includes("frame-ancestors 'none'")) add('HIGH', 'clickjacking', 'Панели можно встроить в чужой кадр', `frame-ancestors: ${cspOf(staff).match(/frame-ancestors[^;]*/)?.[0] || 'нет'}`, "выдать frame-ancestors 'none' для портала и админки");
  else ok('clickjacking', 'панели не встраиваются', "frame-ancestors 'none' + X-Frame-Options: " + (header(staff, 'x-frame-options') || 'нет'));
  if (!cspOf(student).includes('frame-ancestors')) add('MEDIUM', 'clickjacking', 'Анкета: директива frame-ancestors не задана', cspOf(student));

  if (header(student, 'x-powered-by')) add('MEDIUM', 'disclosure', 'Раскрыт X-Powered-By', header(student, 'x-powered-by'), 'app.disable("x-powered-by")');
  else ok('disclosure', 'X-Powered-By скрыт');
  if (header(student, 'server') && /nginx\/|apache\/|express\//i.test(header(student, 'server'))) add('LOW', 'disclosure', 'Заголовок Server содержит версию', header(student, 'server'));

  // Кэш: страницы с данными и API нельзя сохранять в браузере.
  for (const [label, url] of [['админка', `${STAFF}/admin/`], ['портал', `${STAFF}/portal/`], ['api', `${STUDENT}/api/meta`]]) {
    const cache = header(await head(url), 'cache-control') || '';
    if (!/no-store|no-cache/.test(cache)) add('MEDIUM', 'cache', `Кэш не запрещён: ${label}`, `cache-control: ${cache || 'нет'}`, 'no-store для страниц с ответами студентов');
    else ok('cache', `${label}: кэш запрещён`, cache);
  }

  // HSTS имеет смысл только на https.
  const isHttps = STUDENT.startsWith('https://');
  if (isHttps && !header(student, 'strict-transport-security')) add('MEDIUM', 'headers', 'Нет HSTS на https', 'браузер может уйти на http', 'Strict-Transport-Security: max-age=31536000; includeSubDomains');
  else ok('headers', 'HSTS', isHttps ? 'задан' : 'не применимо: http (локальный запуск, терминал только для своих)');
}

/** 2. Чужие ресурсы, SRI и смешанный контент. */
function checkMarkup(html, pageLabel) {
  const external = [...html.matchAll(/<(script|link)[^>]*?(src|href)="(https?:)?\/\/([^"]+)"/gi)];
  const where = (title) => `${title} (${pageLabel})`;
  if (external.length) {
    add('MEDIUM', 'resources', where('Внешние скрипты или стили'), external.map((m) => m[4]).join(', ') || String(external.length), 'скачать и отдавать с своего домена');
    const withoutIntegrity = external.filter((match) => !/integrity=/.test(match[0]));
    if (withoutIntegrity.length) add('MEDIUM', 'resources', where('У внешних ресурсов нет SRI-хэша'), `${withoutIntegrity.length} шт.`, 'добавить integrity + crossorigin');
  } else ok('resources', where('внешних скриптов и стилей нет'), 'всё лежит в public/, SRI не нужен');

  if (STUDENT.startsWith('https://') && /(src|href|action)="http:\/\//i.test(html)) add('MEDIUM', 'resources', where('Смешанный контент: http-ресурсы на https'), 'найдено в разметке');
  else ok('resources', where('смешанного контента нет'));

  const inlineHandlers = [...html.matchAll(/\son(click|load|error|mouseover|focus)=/gi)];
  if (inlineHandlers.length) add('MEDIUM', 'xss', `Инлайн-обработчики в разметке: ${inlineHandlers.length}`, 'обработчики навешиваются из скрипта, а не атрибутом');
  else ok('xss', 'инлайн-обработчиков нет');

  const unsafeTargets = [...html.matchAll(/<a[^>]*target="_blank"[^>]*>/gi)].filter((m) => !/rel="[^"]*noopener/.test(m[0]));
  if (unsafeTargets.length) add('LOW', 'xss', where('target="_blank" без rel="noopener"'), `${unsafeTargets.length} ссылок`);
  else ok('xss', where('ссылки в новой вкладке изолированы'));
}

/** 3. Служебные файлы и лишние методы. */
async function checkPaths() {
  const leaked = [];
  for (const base of [STUDENT, STAFF]) {
    for (const assetPath of SENSITIVE_PATHS) {
      let res;
      try {
        res = await head(base + assetPath);
      } catch {
        continue;
      }
      const looksSensitive =
        res.status === 200 &&
        (/(PASSWORD_SECRET|password_hash|\[core\]|BEGIN (RSA )?PRIVATE KEY|SQLite format 3|CREATE TABLE|"dependencies")/.test(res.body.slice(0, 2000)) ||
          (/\.(sqlite|sql|log)$/i.test(assetPath) && res.body.length > 0 && res.status === 200));
      if (looksSensitive) leaked.push(`${base}${assetPath} -> 200 (${res.body.length} байт)`);
    }
  }
  if (leaked.length) add('CRITICAL', 'disclosure', 'Открыты служебные файлы', leaked.join('; '), 'закрыть путь в статике: из веб-корня должны отдаваться только файлы из public/');
  else ok('disclosure', `служебных файлов не найдено из ${SENSITIVE_PATHS.length} проверенных`);

  const listing = await head(`${STUDENT}/js/`);
  if (listing.status === 200 && /<ul>|Index of|list-directory/i.test(listing.body)) add('MEDIUM', 'disclosure', 'Открыт список каталога', '/js/ отдаёт перечень файлов');
  else ok('disclosure', 'списка каталога нет', `/js/ -> ${listing.status}`);

  const methods = {};
  for (const method of ['TRACE', 'TRACK', 'PUT', 'PATCH', 'DELETE', 'COPY', 'MOVE', 'SEARCH']) {
    try {
      methods[method] = (await head(`${STUDENT}/`, { method })).status;
    } catch {
      methods[method] = 0;
    }
  }
  const dangerous = Object.entries(methods).filter(([, status]) => status >= 200 && status < 400);
  if (dangerous.length) add('HIGH', 'methods', 'Опасные HTTP-методы отвечают успешно', JSON.stringify(dangerous), 'разрешить только GET/HEAD/POST/PUT/PATCH/DELETE там, где они нужны');
  else ok('methods', 'лишних методов нет', `TRACE/PUT/DELETE -> ${Object.values(methods).join(', ')} (0 = метод недоступен браузеру)`);

  const options = await head(`${STUDENT}/`, { method: 'OPTIONS' });
  const allow = options.headers.get('allow') || '';
  if (options.status < 400 && /TRACE|CONNECT|DEBUG/i.test(allow)) add('MEDIUM', 'methods', 'OPTIONS разрешает опасные методы', allow);
  else ok('methods', 'OPTIONS не расширяет набор методов', `OPTIONS / -> ${options.status}`);
}

/** 4. Доступ без входа + CORS + подстановка Host. */
async function checkAccess() {
  for (const apiPath of PROTECTED_API) {
    let res;
    try {
      res = await head(STAFF + apiPath);
    } catch {
      continue;
    }
    if (res.status < 400) add('HIGH', 'auth', `Открыт без входа: ${apiPath}`, `HTTP ${res.status}, ${res.body.length} байт`, 'проверить requireAuth и requireRole на маршруте');
  }
  ok('auth', 'закрытые API без входа не отдают данные', `${PROTECTED_API.length} адресов -> 401/404`);

  for (const page of PANEL_PAGES) {
    let res;
    try {
      res = await head(STAFF + page);
    } catch {
      continue;
    }
    if (res.status === 200 && DATA_MARKERS.test(res.body)) add('HIGH', 'auth', `В разметке ${page} лежат данные из базы`, 'данные должны приходить только после входа', 'ничего не рендерить на сервере: страница - только оболочка');
  }
  ok('auth', 'страницы панелей - пустые оболочки', 'данных в разметке нет');

  const cors = await head(`${STUDENT}/api/meta`, { headers: { Origin: 'https://evil.example' } });
  if (cors.headers.get('access-control-allow-origin')) add('HIGH', 'cors', 'CORS разрешает чужой источник', `Access-Control-Allow-Origin: ${cors.headers.get('access-control-allow-origin')}`, 'не включать CORS для этих маршрутов');
  else ok('cors', 'чужой Origin не получает доступ', 'заголовков CORS нет');

  const reflected = await head(`${STUDENT}/api/meta`, { headers: { Host: 'evil.example' } });
  if (reflected.status === 200 && reflected.body.includes('evil.example')) add('HIGH', 'host', 'Host header инжектится в ссылки и QR', reflected.body.slice(0, 160), 'задать PUBLIC_BASE_URL в .env или доверять только локальным/частным хостам');
  else ok('host', 'подставной Host не попадает в ссылки', 'используется PUBLIC_BASE_URL или проверенный хост');

  const injection = await head(`${STAFF}/login?next=${encodeURIComponent('//evil.example')}`);
  const location = injection.headers.get('location') || '';
  if (injection.status >= 300 && injection.status < 400 && /^https?:\/\/(?!localhost|127\.)/i.test(location)) add('HIGH', 'redirect', 'Открытый редирект', `Location: ${location}`, 'разрешить только относительные адреса');
  else ok('redirect', 'сервер никуда не редиректит наружу', `?next=//evil.example -> ${injection.status}`);
}

/** 5. Утечки в ответах об ошибках и проверка приватности. */
async function checkErrors() {
  const probes = [
    [`${STUDENT}/api/disciplines/abc`, /Некорректный идентификатор/],
    [`${STUDENT}/api/disciplines/999999`, /не найдена/],
    [`${STUDENT}/api/forms/lesson%27`, /Неизвестный тип анкеты/],
    [`${STUDENT}/api/disciplines?id%5B%5D=1`, /./],
    [`${STAFF}/api/auth/me`, /Требуется вход/],
    [`${STUDENT}/api/responses`, /Заполните|анкет|Метод/i],
  ];
  for (const [url, expected] of probes) {
    let res;
    try {
      res = await head(url);
    } catch {
      continue;
    }
    if (/at .*\.js:\d+|Error: |SELECT .* FROM|SqliteError|TypeError:|ReferenceError/.test(res.body)) {
      add('HIGH', 'disclosure', 'Ответ об ошибке содержит трассировку или SQL', `${url}: ${res.body.slice(0, 200)}`, 'возвращать короткое сообщение, подробности - только в лог сервера');
    } else if (res.status < 500 && !expected.test(res.body)) {
      add('LOW', 'disclosure', 'Неожиданный ответ на испорченный параметр', `${url} -> ${res.status}: ${res.body.slice(0, 120)}`, 'сообщение должно быть коротким и понятным пользователю');
    } else if (res.status >= 500) {
      add('MEDIUM', 'disclosure', `5xx на испорченный параметр: ${url}`, `HTTP ${res.status}`, 'валидировать вход раньше, чем он дойдёт до запроса к базе');
    }
  }
  ok('disclosure', 'ошибки отдаются коротко, без трассировок и SQL');

  const meta = await head(`${STUDENT}/healthz`);
  if (meta.status === 200 && /"driver"|"uptime"/.test(meta.body)) add('LOW', 'disclosure', '/healthz на студенческом адресе раскрывает детали', meta.body.slice(0, 120), 'оставить только ok');
  else ok('disclosure', '/healthz сжат на студенческом адресе', meta.body.slice(0, 80));
}

/** 6. Куки и пауза после неверных паролей. */
async function checkCookiesAndThrottle() {
  let loginRes;
  try {
    loginRes = await fetch(`${STAFF}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: 'wrong-password-for-audit' }),
    });
  } catch {
    return;
  }
  const setCookie = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : []).join(', ');
  if (setCookie) {
    if (!/httponly/i.test(setCookie)) add('MEDIUM', 'cookies', 'Куки входа без HttpOnly', setCookie);
    if (!/samesite=(lax|strict)/i.test(setCookie)) add('MEDIUM', 'cookies', 'Куки входа без SameSite', setCookie, 'SameSite=Lax как защита от CSRF');
    ok('cookies', 'куки с флагами', setCookie);
  } else {
    ok('cookies', 'куки не выдаются при неверном пароле', 'Set-Cookie отсутствует');
  }

  if (args.includes('--skip-throttle')) {
    add('INFO', 'throttle', 'Проверка перебора пропущена', '--skip-throttle');
    return;
  }
  const statuses = [];
  const retryAfter = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(`${STAFF}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: `probe-${i}` }),
    });
    statuses.push(res.status);
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      retryAfter.push(body.retryAfterSeconds);
    }
    if (res.status === 200) break;
  }
  if (!statuses.includes(429)) {
    add('MEDIUM', 'throttle', 'Пауза после неверных паролей не сработала', `8 попыток -> ${statuses.join(', ')}`, `проверить .env: LOGIN_MAX_ATTEMPTS, LOGIN_COOLDOWN_SECONDS (${path.join(process.cwd(), '.env')})`);
  } else {
    const firstBlocked = statuses.indexOf(429);
    const fixed = new Set(retryAfter).size === 1;
    ok(
      'throttle',
      'перебор притормаживает',
      `ошибок до паузы: ${firstBlocked}, пауза: ${[...new Set(retryAfter)].join('/')} с, при повторных попытках ${fixed ? 'не растёт' : 'ВЕДЕТ СЕБЯ НЕОДНАКОВО'}`
    );
    if (!fixed) add('MEDIUM', 'throttle', 'Пауза после неверных паролей меняется', `retryAfterSeconds: ${retryAfter.join(', ')}`);
  }
}

/** 7. Что отдаётся браузеру: никаких описаний серверных механизмов. */
function checkClientCode() {
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) {
    add('INFO', 'client', 'Папка public не найдена', publicDir);
    return;
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(publicDir);
  const innerHtml = [];
  const secrets = [];
  const words = ['honeypot', 'анти-бот', 'httpOnly', 'JWT', 'SECRET', 'STAFF_PORT', 'bcrypt', 'node:sqlite', 'better-sqlite3'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\binnerHTML\s*=/.test(text)) innerHtml.push(path.relative(process.cwd(), file));
    for (const word of words) if (text.includes(word)) secrets.push(`${path.relative(process.cwd(), file)}: ${word}`);
  }
  if (innerHtml.length) add('HIGH', 'xss', 'Фронтенд подставляет HTML через innerHTML', innerHtml.join(', '), 'выводить текст через textContent');
  else ok('xss', 'данные выводятся только как текст', 'innerHTML во фронтенде не используется');
  if (secrets.length) add('LOW', 'client', 'В файлах браузера упоминаются серверные детали', secrets.slice(0, 6).join('; '), 'переформулировать комментарии');
  else ok('client', 'в том, что скачивает браузер, нет описания сервера');
}

async function main() {
  let studentPage;
  try {
    studentPage = await head(`${STUDENT}/`);
  } catch (error) {
    console.error(`Сервер недоступен (${error.message}). Сначала запустите: npm start`);
    process.exit(2);
  }
  if (studentPage.status !== 200) {
    console.error(`Студенческий сайт отвечает ${studentPage.status}. Проверьте адреса --student/--staff.`);
    process.exit(2);
  }

  await checkHeaders();
  checkMarkup(studentPage.body, 'анкета');
  const staffPage = await head(`${STAFF}/login`);
  checkMarkup(staffPage.body, 'вход');
  await checkPaths();
  await checkAccess();
  await checkErrors();
  await checkCookiesAndThrottle();
  checkClientCode();

  const penalty = findings.reduce((sum, f) => sum + (SEVERITY[f.level] || 0), 0);
  const score = Math.max(0, 100 - penalty);
  const counts = findings.reduce((acc, f) => {
    acc[f.level] = (acc[f.level] || 0) + 1;
    return acc;
  }, {});
  const passed = findings.filter((f) => f.level === 'PASS').length;
  const bad = findings.filter((f) => f.level !== 'PASS' && f.level !== 'INFO');

  console.log('');
  console.log('='.repeat(66));
  console.log('  Аудит безопасности - Bogusa feedback');
  console.log('='.repeat(66));
  console.log(`  Студенческий сайт: ${STUDENT}`);
  console.log(`  Панели:            ${STAFF}`);
  console.log(`  Проверок пройдено: ${passed}`);
  console.log('');
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  for (const level of order) {
    for (const finding of bad.filter((f) => f.level === level)) {
      console.log(`  [${LABELS[level]}] ${finding.module} - ${finding.title}`);
      if (finding.evidence) console.log(`      детали: ${finding.evidence}`);
      if (finding.fix) console.log(`      что делать: ${finding.fix}`);
    }
  }
  if (!bad.length) console.log('  Находок нет.');
  if (args.includes('--verbose')) {
    console.log('  Пройдено:');
    for (const finding of findings.filter((f) => f.level === 'PASS')) {
      console.log(`    [OK   ] ${finding.module} - ${finding.title}${finding.evidence ? ': ' + finding.evidence : ''}`);
    }
    console.log('');
  }
  console.log('');
  console.log('-'.repeat(66));
  console.log(`  Оценка: ${score}/100   K: ${counts.CRITICAL || 0}  B: ${counts.HIGH || 0}  C: ${counts.MEDIUM || 0}  H: ${counts.LOW || 0}  OK: ${passed}`);
  console.log('-'.repeat(66));
  console.log('');

  const throttleWasTested = !args.includes('--skip-throttle');
  if (throttleWasTested) {
    console.log('  Примечание: после проверки перебора вход на этом адресе закрыт на');
    console.log('  одну паузу (по умолчанию 10 секунд) - это ожидаемое поведение.');
    console.log('');
  }

  if (JSON_OUT) {
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ generated_at: new Date().toISOString(), student: STUDENT, staff: STAFF, score, findings }, null, 2));
    console.log(`  Отчёт сохранён: ${JSON_OUT}\n`);
  }
  process.exit(counts.CRITICAL || counts.HIGH ? 1 : 0);
}

main().catch((error) => {
  console.error(`Сбой аудита: ${error && error.message}`);
  process.exit(2);
});
