'use strict';

/**
 * Проверки «стыка» фронтенда и бэкенда, которые легко сломать при доработках:
 *  1. все файлы, подключаемые из HTML, существуют;
 *  2. во фронтенде нет innerHTML / document.write / eval (защита от XSS);
 *  3. студенческие скрипты не пишут ничего в localStorage/sessionStorage;
 *  4. API отдаёт поля, которые использует интерфейс;
 *  5. CSP-совместимость: в HTML нет inline-скриптов и обработчиков on*;
 *  6. студенческие страницы: только выпадающие списки, без эмодзи и без
 *     упоминаний входа, портала и админ-панели.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const HTML_FILES = [
  'public/index.html',
  'public/form.html',
  'public/login.html',
  'public/portal/index.html',
  'public/admin/index.html',
  'public/404.html',
];

test('все ресурсы, подключаемые из HTML, существуют на диске', () => {
  const missing = [];
  for (const file of HTML_FILES) {
    const html = read(file);
    const matches = html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g);
    for (const [, url] of matches) {
      if (url.startsWith('/api/')) continue;
      // /login, /portal/ — маршруты сервера, а не файлы
      if (!path.extname(url)) continue;
      const target = path.join(PUBLIC_DIR, url.replace(/^\//, ''));
      if (!fs.existsSync(target)) missing.push(`${file} → ${url}`);
    }
  }
  assert.deepEqual(missing, [], `отсутствующие файлы: ${missing.join(', ')}`);
});

test('в HTML нет inline-скриптов, style-атрибутов и обработчиков on*', () => {
  const problems = [];
  for (const file of HTML_FILES) {
    const html = read(file);
    // Ищем <script> без src и любые on-атрибуты; они несовместимы со строгой CSP.
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html);
    const onAttribute = /\son[a-z]+\s*=\s*["']/i.test(html);
    const styleAttribute = /\sstyle\s*=\s*["']/i.test(html);
    if (inlineScript) problems.push(`${file}: inline <script>`);
    if (onAttribute) problems.push(`${file}: атрибут on*`);
    if (styleAttribute) problems.push(`${file}: атрибут style=`);
  }
  assert.deepEqual(problems, []);
});

/** Убираем комментарии, чтобы не ловить упоминания в пояснениях. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('фронтенд не использует innerHTML, document.write и eval', () => {
  const files = fs.readdirSync(path.join(PUBLIC_DIR, 'js')).map((f) => `public/js/${f}`);
  const problems = [];
  for (const file of files) {
    const source = stripComments(read(file));
    for (const pattern of ['innerHTML', 'outerHTML', 'document.write', 'eval(', 'new Function(']) {
      if (source.includes(pattern)) problems.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(problems, [], 'весь вывод должен идти через textContent');
});

test('студенческие страницы ничего не сохраняют на устройстве', () => {
  for (const file of ['public/js/form.js', 'public/js/landing.js']) {
    const source = stripComments(read(file));
    assert.ok(!source.includes('localStorage'), `${file} не должен использовать localStorage`);
    assert.ok(!source.includes('sessionStorage'), `${file} не должен использовать sessionStorage`);
    assert.ok(!source.includes('document.cookie'), `${file} не должен работать с cookies`);
  }
});

test('в проекте нет localStorage, а sessionStorage — только для токена панелей', () => {
  const files = fs.readdirSync(path.join(PUBLIC_DIR, 'js')).map((f) => `public/js/${f}`);
  for (const file of files) {
    const source = stripComments(read(file));
    assert.ok(!source.includes('localStorage'), `${file}: localStorage не используется вообще`);
    assert.ok(!source.includes('document.cookie'), `${file}: cookies ставит только сервер (httpOnly)`);
  }

  const apiSource = stripComments(read('public/js/api.js'));
  const storageKeys = [...apiSource.matchAll(/sessionStorage\.setItem\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(storageKeys, ['TOKEN_KEY'], 'в sessionStorage допускается только токен сессии панели');
});

test('нигде в проекте нет прямых обращений к локальному хосту из браузерного кода', () => {
  const files = fs.readdirSync(path.join(PUBLIC_DIR, 'js')).map((f) => `public/js/${f}`);
  for (const file of files) {
    const source = read(file);
    assert.ok(!source.includes('http://localhost'), `${file}: браузерный код должен использовать относительные URL`);
    assert.ok(!source.includes('127.0.0.1'), `${file}: браузерный код должен использовать относительные URL`);
  }
});

/* ------------------------- контракт API и фронтенда ------------------------- */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bogusa-contract-'));
process.env.DATA_DIR = tempDir;
process.env.DB_FILE = path.join(tempDir, 'contract.sqlite');
process.env.JWT_SECRET = 'contract-secret-contract-secret-1234';
process.env.ADMIN_PASSWORD = 'Admin#2026pass';
process.env.ANTI_BOT_MIN_FILL_MS = '0';

const createApp = require('../server/app');
const { ensureAdminAccount, seedDemoStructure, seedDemoResponses } = require('../server/seed');
const { db } = require('../server/db');

let studentServer;
let staffServer;
let studentUrl;
let staffUrl;
let cookie = '';

/** Разделы, которые живут только на порту преподавателя и администратора. */
const STAFF_PREFIXES = ['/api/auth', '/api/teacher', '/api/admin', '/login', '/portal', '/admin'];

function baseFor(url) {
  const clean = url.split('?')[0].replace(/\/+$/, '') || '/';
  return STAFF_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`)) ? staffUrl : studentUrl;
}

async function call(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseFor(url)}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length > 0) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

test.before(async () => {
  ensureAdminAccount();
  const structure = seedDemoStructure();
  seedDemoResponses({ count: 12 });
  assert.ok(structure.discipline, 'демо-дисциплина создана');
  assert.ok(structure.disciplines.length >= 3, 'для проверки отчётов нужно несколько дисциплин');

  studentServer = createApp('student').listen(0, '127.0.0.1');
  await new Promise((resolve) => studentServer.once('listening', resolve));
  studentUrl = `http://127.0.0.1:${studentServer.address().port}`;

  staffServer = createApp('staff').listen(0, '127.0.0.1');
  await new Promise((resolve) => staffServer.once('listening', resolve));
  staffUrl = `http://127.0.0.1:${staffServer.address().port}`;
});

test.after(() => {
  studentServer.close();
  staffServer.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('GET /api/meta отдаёт формы с полями, которые использует интерфейс', async () => {
  const res = await call('GET', '/api/meta');
  assert.equal(res.status, 200);
  assert.equal(res.json.show_teacher_name, true);
  for (const form of res.json.forms) {
    for (const field of ['key', 'title', 'shortTitle', 'cardTitle', 'description', 'questionCount', 'scaleCount']) {
      assert.ok(form[field] !== undefined, `в форме ${form.key} нет поля ${field}`);
    }
  }
});

test('структура анкеты содержит scale_words — их рисует form.js', async () => {
  const res = await call('GET', '/api/forms/lesson');
  assert.equal(res.status, 200);
  assert.ok(res.json.scale_words, 'нужны короткие подписи шкалы');
  assert.equal(Object.keys(res.json.scale_words).length, 5);
  for (const section of res.json.sections) {
    assert.ok(section.title);
    for (const question of section.questions) {
      assert.ok(['scale', 'text'].includes(question.kind));
      assert.ok(question.label);
      if (question.kind === 'text') assert.ok(question.max_length > 0, 'нужен лимит длины для textarea');
    }
  }
});

test('каталог дисциплин: поля topics_count и teacher_name', async () => {
  const res = await call('GET', '/api/disciplines');
  assert.equal(res.status, 200);
  const discipline = res.json.disciplines[0];
  assert.ok(Number.isInteger(discipline.topics_count));
  assert.ok(typeof discipline.teacher_name === 'string' && discipline.teacher_name.length > 0);
});

test('вход администратора и /api/auth/me возвращают роль и ФИО', async () => {
  const login = await call('POST', '/api/auth/login', { login: 'admin', password: 'Admin#2026pass' });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'admin');
  assert.ok(login.json.user.full_name);

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'admin');
});

test('портал преподавателя получает все нужные поля (overview, report, timeline)', async () => {
  const overview = await call('GET', '/api/teacher/overview');
  assert.equal(overview.status, 200);
  for (const field of ['responses', 'lesson', 'final', 'overall_avg', 'comments', 'last_response_at']) {
    assert.ok(field in overview.json.totals, `в totals нет ${field}`);
  }
  assert.ok(Array.isArray(overview.json.timeline));
  assert.ok(Array.isArray(overview.json.disciplines));
  assert.ok(overview.json.disciplines.every((d) => 'responses' in d && 'avg' in d && 'topics_count' in d));
  assert.ok(typeof overview.json.min_answers_label === 'string');
  const { first_response_at: firstAt, last_response_at: lastAt } = overview.json.totals;
  assert.ok(
    !firstAt || !lastAt || firstAt <= lastAt,
    'первый ответ не может быть позже последнего'
  );

  const disciplineId = overview.json.disciplines[0].id;
  const report = await call('GET', `/api/teacher/disciplines/${disciplineId}/report`);
  assert.equal(report.status, 200);
  assert.equal(typeof report.json.total_responses, 'number');
  assert.ok(report.json.by_form.lesson !== undefined);
  assert.ok(Array.isArray(report.json.forms));
  assert.ok(Array.isArray(report.json.timeline));
  assert.ok(Array.isArray(report.json.lessons));

  const form = report.json.forms[0];
  assert.ok(form.title && Array.isArray(form.questions) && Array.isArray(form.comments));
  for (const field of ['key', 'label', 'hint', 'count', 'avg', 'distribution', 'positive_ratio']) {
    assert.ok(field in form.questions[0], `в пункте отчёта нет поля ${field}`);
  }
  assert.ok('avg_of_items' in form);
  assert.ok(report.json.lessons.every((l) => 'topic_id' in l && 'responses' in l && 'discipline_id' in l));
});

test('отзывы студентов: поле question_label для группировки в интерфейсе', async () => {
  const res = await call('GET', '/api/teacher/comments');
  assert.equal(res.status, 200);
  if (res.json.comments.length > 0) {
    const comment = res.json.comments[0];
    for (const field of ['id', 'question_key', 'question_label', 'body', 'created_date', 'form_type']) {
      assert.ok(field in comment, `в комментарии нет поля ${field}`);
    }
  }
});

test('админские эндпоинты отдают поля, которые использует админ-панель', async () => {
  const adminOverview = await call('GET', '/api/admin/overview');
  assert.equal(adminOverview.status, 200);
  for (const field of ['teachers', 'disciplines', 'topics', 'responses', 'comments', 'lesson', 'final']) {
    assert.ok(field in adminOverview.json.counts, `в counts нет ${field}`);
  }
  assert.ok(Array.isArray(adminOverview.json.top_disciplines));
  assert.ok(adminOverview.json.top_disciplines.every((d) => 'responses' in d && 'avg' in d));
  assert.ok(adminOverview.json.teachers.every((t) => 'disciplines' in t));

  const teachers = await call('GET', '/api/admin/teachers');
  assert.ok(teachers.json.teachers.every((t) => 'disciplines_count' in t && 'must_change_password' in t));

  const disciplines = await call('GET', '/api/admin/disciplines');
  assert.ok(disciplines.json.disciplines.every((d) => 'topics_count' in d && 'responses' in d && 'avg' in d));

  const disciplineId = disciplines.json.disciplines[0].id;
  const topics = await call('GET', `/api/admin/disciplines/${disciplineId}/topics`);
  assert.ok(Array.isArray(topics.json.topics));
  assert.ok(topics.json.topics.every((t) => 'lessondate' in t || 'lesson_date' in t));

  const audit = await call('GET', '/api/admin/audit?limit=5');
  assert.ok(Array.isArray(audit.json.events));

  const report = await call('GET', '/api/admin/report');
  assert.ok(Array.isArray(report.json.forms));
  assert.ok(Array.isArray(report.json.timeline));

  const link = await call('GET', '/api/admin/link?discipline_id=1');
  assert.ok(link.json.url.includes('/form.html?discipline=1'));
});

test('страницы отдаются сервером и содержат подключение к своим скриптам', async () => {
  const pages = [
    ['/', '/js/landing.js'],
    ['/form.html', '/js/form.js'],
    ['/login', '/js/login.js'],
    ['/portal/', '/js/portal.js'],
    ['/admin/', '/js/admin.js'],
  ];
  for (const [url, script] of pages) {
    const res = await call('GET', url);
    assert.equal(res.status, 200, `страница ${url} должна отдаваться`);
    assert.ok(res.text.includes(script), `страница ${url} должна подключать ${script}`);
  }
});

test('в студенческих страницах нет эмодзи, пояснений и служебных блоков', async () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2726}]/u;
  const files = ['public/index.html', 'public/form.html', 'public/404.html', 'public/js/landing.js', 'public/js/form.js'];
  for (const file of files) {
    const source = read(file);
    assert.ok(!emoji.test(source), `в ${file} не должно быть эмодзи и декоративных символов`);
    assert.ok(!/Например:/i.test(source), `в ${file} не должно быть подсказок-примеров`);
    assert.ok(!source.includes('badge'), `в ${file} не должно быть бейджей`);
  }
});

test('студент выбирает дисциплину и тему только из выпадающих списков', async () => {
  const form = await call('GET', '/form.html');
  assert.equal(form.status, 200);
  assert.ok(form.text.includes('<select'), 'на странице анкеты есть выпадающие списки');
  assert.ok(form.text.includes('id="discipline-select"'), 'есть список дисциплин');
  assert.ok(form.text.includes('id="topic-select"'), 'есть список тем занятия');
  assert.ok(!/<input(?![^>]*type="hidden")[^>]*type="(text|search)"/i.test(form.text), 'ручного ввода нет');

  const landing = await call('GET', '/');
  assert.ok(landing.text.includes('id="discipline-select"'), 'на главной также только список дисциплин');
  assert.ok(!landing.text.includes('type="search"'), 'поиска с ручным вводом на главной нет');
});

test('неизвестный адрес API отвечает JSON-ошибкой, а не HTML', async () => {
  const res = await call('GET', '/api/unknown-endpoint');
  assert.equal(res.status, 404);
  assert.ok(res.json && res.json.error);
});

test('заголовки безопасности выставлены, iframe разрешён политикой CSP', async () => {
  const res = await fetch(`${studentUrl}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), null, 'X-Frame-Options не должен ломать встраивание');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("frame-ancestors *"), `CSP должна разрешать встраивание: ${csp}`);
  assert.ok(csp.includes("script-src 'self'"), 'скрипты только со своего домена');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
