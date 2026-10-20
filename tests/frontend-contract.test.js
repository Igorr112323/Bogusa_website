'use strict';

/**
 * Проверки «стыка» фронтенда и бэкенда, которые легко сломать при доработках:
 *  1. все файлы, подключаемые из HTML, существуют;
 *  2. во фронтенде нет innerHTML / document.write / eval (защита от XSS);
 *  3. студенческие скрипты не пишут ничего в localStorage/sessionStorage;
 *  4. API отдаёт поля, которые использует интерфейс;
 *  5. CSP-совместимость: в HTML нет inline-скриптов и обработчиков on*;
 *  6. главная студента: плитки-"двери" вместо выпадающих списков, анкета - со
 *     списками дисциплины и темы; без эмодзи, длинных тире и кавычек-"ёлочек";
 *  7. дизайн-токены и решения итераций 4-6 (палитра, радиусы, двери, адаптив);
 *  8. блоки, от которых отказались, не возвращаются на страницы.
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

test('scale_words отдаются API, но интерфейс их не рисует', async () => {
  const res = await call('GET', '/api/forms/lesson');
  assert.equal(res.status, 200);
  assert.ok(res.json.scale_words, 'поле scale_words осталось в ответе API');
  assert.equal(Object.keys(res.json.scale_words).length, 5);
  assert.ok(!read('public/js/form.js').includes('scale-word'), 'подписей под цифрами шкалы в интерфейсе нет');
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

test('главная студента: две плитки-двери на дисциплину, без выпадающих списков', async () => {
  const landing = await call('GET', '/');
  assert.equal(landing.status, 200);
  assert.ok(landing.text.includes('id="disciplines"'), 'на главной есть контейнер списка дисциплин');
  assert.ok(!landing.text.includes('<select'), 'на главной студента нет выпадающих списков');
  assert.ok(!landing.text.includes('type="search"'), 'поиска с ручным вводом на главной нет');
  assert.ok(!landing.text.includes('site-header'), 'на главной студента нет шапки');

  const script = read('public/js/landing.js');
  for (const label of ['Оценить занятие', 'Оценить дисциплину']) {
    assert.ok(script.includes(label), `на плитке должно быть: ${label}`);
  }
  assert.ok(script.includes("'lesson'"), 'плитка занятия ведёт в анкету lesson');
  assert.ok(script.includes("'final'"), 'плитка дисциплины ведёт в анкету final');
  assert.ok(script.includes('door-accent'), 'плитка занятия - янтарная');
  assert.ok(!script.includes('12 пунктов'), 'подсказок про число пунктов на плитках нет');
  assert.ok(!script.includes('discipline-select'), 'селекта на главной нет и в скрипте');
});

test('анкета студента: списки дисциплины и темы по порядку, вид анкеты - кнопками', async () => {
  const form = await call('GET', '/form.html');
  assert.equal(form.status, 200);
  assert.ok(form.text.includes('<select'), 'на странице анкеты есть выпадающие списки');
  assert.ok(form.text.includes('id="discipline-select"'), 'есть список дисциплин');
  assert.ok(form.text.includes('id="topic-select"'), 'есть список тем занятия');
  assert.ok(!/<input(?![^>]*type="hidden")[^>]*type="(text|search)"/i.test(form.text), 'ручного ввода нет');

  // список "Анкета" заменён переключателем из двух кнопок
  assert.ok(!form.text.includes('id="form-select"'), 'выпадающего списка с видами анкет больше нет');
  assert.ok(!form.text.includes('<label class="label" for="form-select">'), 'его подписи тоже нет');
  assert.ok(form.text.includes('id="form-switch"'), 'есть контейнер переключателя');
  assert.ok(
    form.text.indexOf('id="discipline-select"') < form.text.indexOf('id="topic-field"'),
    'сначала дисциплина'
  );
  assert.ok(
    form.text.indexOf('id="topic-field"') < form.text.indexOf('id="form-switch"'),
    'затем тема занятия, и только потом кнопки вида анкеты'
  );

  const script = read('public/js/form.js');
  assert.ok(script.includes('btn-switch'), 'кнопки рисуются form.js');
  assert.ok(!script.includes('topicField.hidden'), 'поле темы занятия не скрывается при переключении анкеты');
  assert.ok(script.includes('aria-pressed'), 'выбор кнопки обозначен через aria-pressed');
  assert.ok(!script.includes('fillFormSelect'), 'старый список анкеты удалён вместе с кодом');

  const styles = read('public/css/styles.css');
  assert.match(styles, /\.btn-switch \{\n  min-height: 60px;/, 'кнопки крупные, не менее 60px');
  assert.match(styles, /\.btn-switch\[aria-pressed='true'\] \{\n  --btn-bg: var\(--brand-700\);/, 'активная кнопка индиго');
  assert.match(styles, /\.form-switch \{[\s\S]*?grid-template-columns: 1fr;/, 'на мобильном кнопки столбиком');
  assert.match(
    styles,
    /#survey form > \.btn \{\n  display: flex;\n  width: auto;\n  min-width: 240px;\n  margin: var\(--space-5\) auto 0;/,
    'кнопка «Отправить» центрирована в форме',
  );
});

/* ------------------------- дизайн-система и отказ от блоков ------------------------- */

const FRONTEND_FILES = [
  ...[
    'public/index.html',
    'public/form.html',
    'public/login.html',
    'public/portal/index.html',
    'public/admin/index.html',
    'public/404.html',
    'public/css/styles.css',
    'public/css/dashboard.css',
  ],
  ...fs.readdirSync(path.join(PUBLIC_DIR, 'js')).map((f) => `public/js/${f}`),
];

test('во фронтенде нет em-dash, en-dash и кавычек-ёлочек', () => {
  for (const file of FRONTEND_FILES) {
    const source = read(file);
    assert.ok(!/[\u2014\u2013]/.test(source), `${file}: вместо — и – используйте дефис -`);
    assert.ok(!/[\u00ab\u00bb]/.test(source), `${file}: вместо кавычек-ёлочек используйте " "`);
  }
});

test('дизайн-токены: тёплый индиго, янтарь, бежевые поверхности, радиусы 8/12/18', () => {
  const tokens = read('public/css/styles.css');
  for (const [name, value] of [
    ['--brand-700', '#4550a8'],
    ['--accent-500', '#d97706'],
    ['--bg', '#f7f6f3'],
    ['--surface-2', '#f1efe9'],
    ['--border', '#e6e3da'],
    ['--text', '#1a1a23'],
    ['--radius-sm', '8px'],
    ['--radius', '12px'],
    ['--radius-lg', '18px'],
  ]) {
    assert.ok(tokens.includes(`${name}: ${value};`), `${name} должен быть ${value}`);
  }
  assert.ok(!/linear-gradient\(1[34][05]deg/.test(tokens), 'градиентных шапок и карточек нет');
  assert.ok(/'Inter'/.test(tokens), 'в шрифтовом стеке есть Inter');
});

test('адаптив mobile-first: 1 колонка, 2 от 560px, 4 от 720px, таблицы со скроллом', () => {
  const styles = read('public/css/styles.css');
  const dash = read('public/css/dashboard.css');
  assert.match(styles, /@media \(min-width: 560px\)/);
  assert.match(styles, /@media \(min-width: 720px\)/);
  assert.match(styles, /\.doors \{[\s\S]*?grid-template-columns: 1fr;/);
  assert.match(dash, /@media \(max-width: 520px\)/, 'компактная шапка кабинетов на мобильном');
  assert.match(dash, /\.table-wrap \{\n  overflow-x: auto;/, 'таблицы скроллятся по горизонтали');
  assert.match(styles, /\.btn \{[\s\S]*?min-height: 44px;/, 'тач-таргет кнопок не меньше 44px');
  assert.match(styles, /\.door \{[\s\S]*?min-height: 76px;/, 'двери крупные, по всей ширине');
});

test('кабинет: три раздела в меню, на узком экране полоса сверху; в админке остаются двери', () => {
  for (const file of ['public/portal/index.html', 'public/admin/index.html', 'public/css/dashboard.css']) {
    assert.ok(!read(file).includes('top-tabs'), `${file}: вкладок-полосы внизу шапки больше нет`);
  }

  const portal = read('public/js/portal.js');
  for (const label of ['Отчёт', 'Мои темы', 'Пароль']) {
    assert.ok(portal.includes(`label: '${label}'`), `в меню кабинета нет раздела ${label}`);
  }
  assert.ok(!portal.includes("'Обзор'"), 'Обзор убран: сразу после входа открывается отчёт');
  assert.ok(!portal.includes('Отзывы студентов'), 'отдельного раздела отзывов нет: комментарии в отчёте');
  assert.ok(!portal.includes('doorsSection'), 'в кабинете три раздела, двери не нужны');
  assert.ok(portal.includes('nav-count'), 'на разделе Отчёт виден счётчик новых анкет');

  const portalHtml = read('public/portal/index.html');
  assert.ok(portalHtml.includes('id="side-nav-top"'), 'на узком экране меню дублируется полосой над содержимым');
  assert.ok(!read('public/admin/index.html').includes('side-nav-top'), 'в админ-панели полоса не нужна: там двери');

  const dash = read('public/css/dashboard.css');
  assert.match(dash, /\.side-nav-top \{\n  flex-direction: row;/);
  assert.match(dash, /\.nav-count \{/, 'счётчик новых ответов описан в CSS');
  assert.match(dash, /\.app-shell \.site-header \{\n  background: var\(--brand-700\);/);
  assert.match(dash, /\.doors-dashboard \.door \{\n  min-height: 92px;/, 'двери админ-панели остаются крупными');
  assert.ok(read('public/js/admin.js').includes('doorsSection'), 'в админ-панели разделы - двери');
});

test('отчёт преподавателя: дисциплина, две крупные кнопки, тема, период, оценки и лента комментариев', () => {
  const portal = read('public/js/portal.js');
  // порядок блоков проверяем внутри function pickerCard: там разметка блока выбора
  const from = portal.indexOf('function pickerCard');
  const to = portal.indexOf('async function renderReport');
  const picker = portal.slice(from, to);
  assert.ok(from > 0 && to > from, 'блок выбора фильтров описан в pickerCard');
  // порядок именно в разметке: смотрим на children, которые возвращает pickerCard
  const markup = picker.slice(picker.indexOf("return el('div', { class: 'card card-tight report-picker' }"));
  assert.ok(markup.length > 100, 'блок фильтров собирается в return функции pickerCard');
  const order = ["text: 'Дисциплина'", 'formSwitch(', "text: 'Тема занятия'", "dateField('С даты'"].map((needle) => {
    const at = markup.indexOf(needle);
    assert.ok(at >= 0, `в блоке фильтров нет ${needle}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'порядок: дисциплина, кнопки вида анкеты, тема, период');
  assert.ok(/function formSwitch[\s\S]*?class: 'form-switch'[\s\S]*?btn-switch/.test(portal), 'вид анкеты - кнопки в группе form-switch, а не select');
  assert.ok(portal.includes("'aria-pressed'") && portal.includes('btn-switch'), 'активная кнопка помечена aria-pressed');
  assert.ok(/type: 'date'/.test(portal), 'период задаётся двумя датами');
  for (const gone of ['quick-dates', 'Сбросить фильтры', 'По занятиям', 'lessonsSection', "text: 'Ссылка для студентов'"]) {
    assert.ok(!portal.includes(gone), `в отчёте больше нет блока ${gone}`);
  }
  assert.ok(portal.includes("'Всего анкет'") && portal.includes("'Средний балл'"), 'статистика считается по выбранному периоду');
  assert.ok(!portal.includes('timelineChart') && !portal.includes('Динамика'), 'графика динамики из кабинета убран');
  assert.ok(portal.includes('Комментарии студентов') && portal.includes("class: 'comment-row'"), 'комментарии - строками, а не сплошным списком');
  assert.ok(portal.includes('comment-tags') && portal.includes('tag-new'), 'у отзыва метки: дата, тема, флаг новое');
  assert.ok(portal.includes('markSeen') && portal.includes('/api/teacher/seen'), 'просмотр раздела отмечается');

  const dash = read('public/css/dashboard.css');
  assert.match(dash, /\.comment-text \{\n  font-size: 1rem;/, 'текст отзыва крупнее меток');
  assert.match(dash, /\.stats-2 \{\n    grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'две карточки статистики на всю ширину');
  assert.match(read('public/css/styles.css'), /\.btn-switch \{\n  min-height: 60px;/, 'кнопки вида анкеты крупные');
});

test('мои темы: преподаватель ведёт дисциплины и занятия, но не удаляет', () => {
  const portal = read('public/js/portal.js');
  for (const route of ['/api/teacher/disciplines', '/api/teacher/topics', '/api/teacher/seen']) {
    assert.ok(portal.includes(route), `в кабинете нет обращения к ${route}`);
  }
  assert.ok(portal.includes("'Создать дисциплину'") || portal.includes("'Создать дисциплину',"), 'есть форма создания дисциплины');
  assert.ok(portal.includes('Добавить занятие'), 'темы добавляются по одной');
  assert.ok(!portal.includes('api.del('), 'из кабинета ничего не удаляется - это право администратора');
  assert.ok(!portal.includes('/api/admin'), 'кабинет преподавателя не пользуется админским API');
});

test('мои темы: массовое добавление, код дисциплины и пояснительные тексты убраны', () => {
  const portal = read('public/js/portal.js');
  assert.ok(!portal.includes('/topics/bulk'), 'преподаватель не добавляет темы списком');
  assert.ok(!portal.includes('topic-bulk') && !portal.includes('textarea'), 'в кабинете преподавателя нет поля для списка тем');
  assert.ok(!portal.includes('Добавить несколько сразу'), 'второй способ добавления убран');
  assert.ok(!portal.includes('new-discipline-code') && !portal.includes("fieldRow('Код'"), 'код дисциплины в кабинете не вводится');
  assert.ok(!portal.includes('код: '), 'код дисциплины не показывается в шапке карточки');
  for (const removed of ['Дисциплина сразу закрепляется за вами', 'У дисциплины ниже', 'catalog-note']) {
    assert.ok(!portal.includes(removed), `подсказка убрана: ${removed}`);
  }
});

test('админ-панель: без журнала, вкладки QR, графиков и пояснительных алертов', () => {
  const admin = read('public/js/admin.js');
  const html = read('public/admin/index.html');
  const dash = read('public/css/dashboard.css');
  assert.ok(!admin.includes("label: 'Журнал действий'") && !admin.includes("label: 'QR и ссылки'"), 'вкладок журнала и QR в меню нет');
  assert.ok(!admin.includes('renderQr') && !admin.includes('renderAudit'), 'функции этих разделов удалены');
  assert.ok(!admin.includes('timelineChart'), 'графиков динамики в админ-панели нет');
  assert.ok(!admin.includes('Динамика'), 'раздел графика убран вместе с подписью');
  assert.ok(!html.includes('bcrypt') && !html.includes('card-tight'), 'пояснение про пароли убрано из сайдбара');
  assert.ok(!admin.includes('Как выдать доступ') && !admin.includes("text: 'Важно: '"), 'пояснительные алерты убраны из вкладок');
  assert.ok(!admin.includes('codeInput') && !admin.includes('Код дисциплины'), 'код дисциплины в админке не вводится');
  assert.ok(admin.includes("text: 'Создать дисциплину и темы'"), 'кнопка в шапке создаёт дисциплину');
  assert.ok(admin.includes('topicsModal({ discipline: created'), 'сразу после дисциплины открывается окно тем');
  assert.ok(!admin.includes('Ко всем разделам'), 'прежняя кнопка перехода к списку разделов убрана');
  assert.ok(admin.includes('qrModal'), 'ссылка и QR для группы остались в разделе дисциплин');
  assert.match(dash, /\.filter-bar \.field\.date-pair \{/, 'поля дат в отчётах стоят в одну строку');
  assert.ok(!admin.includes('Добавить несколько тем сразу') && !admin.includes("el('details'"), 'массовая загрузка списка тем из окна тем убрана');
  assert.ok(!admin.includes('/topics/bulk'), 'админка не дерёт bulk-маршрут тем');
  for (const gone of ['Скачать CSV', 'text: \'Печать\'', 'window.print', 'min_answers_label']) {
    assert.ok(!admin.includes(gone), `из админки убрано: ${gone}`);
  }
  assert.ok(!html.includes('Портал преподавателя'), 'ссылка на портал преподавателя из шапки админки убрана');
  assert.ok(html.includes('logout-button'), 'кнопка выхода в шапке осталась');
});

test('нет цикла редиректов между /admin/ и /login для преподавателя', () => {
  const login = read('public/js/login.js');
  const admin = read('public/js/admin.js');
  assert.ok(login.includes("target.startsWith('/admin')") && login.includes("user.role !== 'admin'"), 'вход игнорирует next=/admin/ для не-администратора');
  assert.ok(login.includes("user.role === 'admin' ? '/admin/' : '/portal/'"), 'после входа адрес зависит от роли');
  assert.ok(admin.includes("me.role !== 'admin'"), 'панель администратора проверяет роль');
  assert.ok(admin.includes('Недостаточно прав') && admin.includes("href: '/portal/'"), 'преподаватель видит сообщение и ссылку на кабинет, а не вечный редирект');
  assert.ok(admin.includes("window.location.replace('/login?next=/admin/')"), 'без сессии вход по-прежнему предлагается');
});

test('мои темы: карточки свёрнуты по умолчанию, свежая дисциплина вверху, подсказки убраны', () => {
  const portal = read('public/js/portal.js');
  assert.ok(portal.includes('const expandedCards = new Set()'), 'помнятся только раскрытые карточки, то есть по умолчанию всё свёрнуто');
  assert.ok(!portal.includes('collapsedCards'), 'обратного состояния (по умолчанию раскрыто) больше нет');
  assert.match(portal, /\[\.\.\.state\.disciplines\]\.sort\(\(a, b\) => b\.id - a\.id\)/, 'новая дисциплина появляется вверху списка');
  assert.ok(portal.includes('expandedCards.add(createdId)'), 'созданная дисциплина сразу раскрыта');
  assert.ok(!portal.includes('localStorage') && !portal.includes('sessionStorage'), 'состояние списка нигде не сохраняется');

  const table = portal.slice(portal.indexOf('function topicsTable'), portal.indexOf('function disciplineCard'));
  assert.ok(!table.includes("'Ссылка'"), 'кнопка Ссылка из строк таблицы занятий убрана');
  assert.ok(!table.includes('modalLink'), 'ссылку даёт только карточка дисциплины');
  assert.ok(!table.includes('Занятий пока нет'), 'подсказка про пустой список занятий убрана');
  assert.ok(table.includes('return null'), 'без занятий таблица не рисуется');
  assert.ok(portal.includes("text: 'Ссылка'"), 'ссылка на анкету осталась в шапке дисциплины');

  const form = portal.slice(portal.indexOf('function topicAddForm'), portal.indexOf('function topicsTable'));
  assert.ok(!form.includes('Enter тоже добавляет'), 'подсказка про Enter убрана');
  assert.ok(!form.includes('Дату можно не ставить'), 'подсказка про дату убрана');
  assert.ok(form.includes("el('h3', { text: 'Добавить занятие' })"), 'в блоке добавления остался только заголовок');

  const create = portal.slice(portal.indexOf('function createDisciplineCard'), portal.indexOf('async function afterCatalogChange'));
  assert.ok(!create.includes('название от 2 символов'), 'пояснение про длину названия убрано');
  assert.ok(!create.includes('hint'), 'в карточке создания дисциплины нет пояснительных абзацев');
});

test('мои темы: в таблице занятий нет колонки Анкет, дата по центру', () => {
  const portal = read('public/js/portal.js');
  const dash = read('public/css/dashboard.css');
  const table = portal.slice(portal.indexOf('function topicsTable'), portal.indexOf('function disciplineCard'));
  assert.ok(!table.includes("'Анкет'"), 'колонка с числом анкет убрана из таблицы занятий');
  assert.ok(!table.includes('topic.responses'), 'число анкет по занятию в таблице не показывается');
  assert.ok(table.includes("class: 'col-center', text: 'Дата'"), 'заголовок колонки даты по центру');
  assert.equal((table.match(/col-center/g) || []).length, 2, 'по центру и заголовок, и значения даты');
  assert.ok(table.includes("el('th', { class: 'num', text: '' })"), 'колонка кнопок осталась справа');
  assert.match(dash, /\.table th\.col-center \{\n  text-align: center;/, 'колонка даты выровнена по центру');
});

test('мои темы: карточка дисциплины сворачивается по клику на названии', () => {
  const portal = read('public/js/portal.js');
  const dash = read('public/css/dashboard.css');
  for (const needle of ['catalog-toggle', 'expandedCards', 'toggleExpanded', 'is-collapsed', 'aria-expanded', 'aria-controls']) {
    assert.ok(portal.includes(needle), `в карточке дисциплины нет ${needle}`);
  }
  assert.ok(!portal.includes('localStorage') && !portal.includes('sessionStorage'), 'состояние сворачивания нигде не сохраняется');
  assert.ok(!portal.includes('<h2'), 'название карточки - не заголовок внутри кнопки');
  assert.match(dash, /\.discipline-card\.is-collapsed \.catalog-body \{\n  display: none;/, 'содержимое свёрнутой карточки скрыто');
  assert.match(dash, /\.discipline-card:not\(\.is-collapsed\) \.caret \{\n  transform: rotate\(90deg\);/, 'стрелка поворачивается');
  assert.ok(!dash.includes('.catalog-form-col') && !dash.includes('.catalog-bulk-row'), 'стили двухколоночного блока добавления убраны');
});

test('в отчёте кабинета нет печати и выгрузки CSV', () => {
  const portal = read('public/js/portal.js');
  for (const gone of ['Печать / PDF', 'Скачать CSV', 'window.print', 'export.csv']) {
    assert.ok(!portal.includes(gone), `из шапки отчёта убрано: ${gone}`);
  }
  assert.ok(!portal.includes('exportUrl'), 'ссылка на выгрузку больше не строится');
});

test('убранные блоки не возвращаются', () => {
  const login = read('public/login.html');
  assert.ok(!login.includes('site-header'), 'на странице входа нет шапки');
  assert.ok(!/bcrypt/i.test(login), 'на входе нет подсказки про bcrypt');
  assert.ok(!login.includes('Логин и пароль выдаёт администратор'), 'пояснение про администратора убрано');
  assert.ok(!login.includes('Студентам'), 'карточка для студентов на входе убрана');

  assert.ok(login.includes('id="login-submit"'), 'кнопка входа на месте');
  assert.ok(!login.includes('btn-block'), 'кнопка входа не тянется на всю ширину блока');
  assert.match(
    read('public/css/styles.css'),
    /\.card-auth form > \.btn \{\n  display: flex;\n  width: auto;\n  min-width: 220px;\n  margin: var\(--space-1\) auto 0;/,
    'кнопка входа центрирована в карточке',
  );

  assert.ok(!read('public/form.html').includes('form-subtitle'), 'подзаголовка анкеты нет');

  for (const file of ['public/portal/index.html', 'public/admin/index.html']) {
    assert.ok(!read(file).includes('анонимная обратная связь студентов'), `${file}: подзаголовка в шапке нет`);
  }

  const portalHtml = read('public/portal/index.html');
  assert.ok(!portalHtml.includes('site-footer'), 'в кабинете нет футера с текстом про обезличивание');
  assert.ok(!portalHtml.includes('students-link'), 'ссылки «Страница студентов» в шапке кабинета нет');
  assert.ok(!portalHtml.includes('sidebar-note'), 'заметки под меню кабинета нет');
  assert.ok(!read('public/js/portal.js').includes('Как читать отчёт'), 'блока «Как читать отчёт» в обзоре нет');

  const landingHtml = read('public/index.html');
  assert.ok(!landingHtml.includes('page-intro'), 'вводного абзаца на главной нет');
  assert.ok(!landingHtml.includes('Выберите дисциплину и анкету'), 'подсказки на главной нет');
  assert.ok(!read('public/js/landing.js').includes('Анкетирование пока не открыто'),
    'при пустой базе главная остаётся пустой, служебных надписей нет');

  const { FORMS } = require('../server/questions');
  for (const form of Object.values(FORMS)) {
    for (const section of form.sections) {
      assert.ok(!/необязательно, но желательно/.test(section.title), `${form.key}: хвост в заголовке блока`);
    }
  }
});

test('о нужности сидинга судят по содержимому базы, а не по наличию файла', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bogusa-needs-seed-'));
  const dbFile = path.join(dir, 'fresh.sqlite');
  try {
    const out = execFileSync(
      process.execPath,
      ['--no-warnings', path.join(ROOT, 'scripts/needs-seed.js')],
      { env: { ...process.env, DATA_DIR: dir, DB_FILE: dbFile }, encoding: 'utf8' }
    );
    assert.equal(out.trim().split('\n').pop(), 'empty', 'пустая база должна быть распознана');
    assert.ok(!fs.existsSync(dbFile), 'проверка не имеет права создавать файл базы');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const file of ['start.ps1', 'start.sh']) {
    assert.ok(read(file).includes('needs-seed'), `${file}: решение о сидинге берётся из needs-seed.js`);
  }
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
  assert.ok(csp.includes("style-src 'self'"), 'стили только свои: инлайн-стили задаются через DOM, не разметкой');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  // Панели встраивать нельзя: иначе чужая кнопка поверх формы входа.
  const staffRes = await fetch(`${staffUrl}/login`);
  const staffCsp = staffRes.headers.get('content-security-policy');
  assert.ok(staffCsp.includes("frame-ancestors 'none'"), `панели не должны встраиваться в кадр: ${staffCsp}`);
  assert.equal(staffRes.headers.get('x-frame-options'), 'DENY', 'страховка для старых браузеров');
  for (const url of ['/portal/', '/admin/']) {
    const r = await fetch(staffUrl + url);
    assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"), `${url}: политика кадра`);
  }
});

test('во фронтенде нет описания устройства сервера и механизма защиты от ботов', () => {
  const files = fs
    .readdirSync(path.join(PUBLIC_DIR, 'js'))
    .map((f) => `public/js/${f}`)
    .concat(['public/index.html', 'public/form.html', 'public/login.html', 'public/404.html', 'public/css/styles.css']);
  for (const file of files) {
    const text = read(file);
    for (const secret of ['honeypot', 'Honeypot', 'анти-бот', 'httpOnly', 'STAFF_PORT', 'MIN_ANSWERS', 'JWT_SECRET', 'bcrypt', 'SQLITE', 'better-sqlite3']) {
      assert.ok(!text.includes(secret), `${file}: не должен упоминать ${secret}`);
    }
  }
});

test('удаление преподавателя в админке убирает всё его содержимое', () => {
  const admin = read('public/js/admin.js');
  const route = read('server/routes/admin.js');
  assert.ok(!admin.includes('reassign_to'), 'в окне удаления преподавателя нет выбора, кому передать дисциплины');
  assert.ok(!admin.includes('оставить дисциплины без преподавателя'), 'отвязывать дисциплины больше не предлагается');
  assert.ok(admin.includes('темы занятий и все анкеты студентов'), 'окно предупреждает, что удаляется всё');
  assert.ok(admin.includes('result.removed'), 'админ видит, сколько объектов удалено');
  assert.ok(route.includes('const removed = tx('), 'удаление выполняется одной транзакцией');
  for (const sql of ['DELETE FROM responses', 'DELETE FROM topics', 'DELETE FROM disciplines']) {
    assert.ok(route.includes(sql), `каскад должен удалять: ${sql}`);
  }
});
