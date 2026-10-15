'use strict';

/**
 * Интеграционные тесты API: анонимная отправка, вход, разграничение доступа,
 * защита от XSS, выгрузка CSV.
 *
 * Тест поднимает приложение на случайном порту и использует отдельную временную БД.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- окружение теста (должно быть задано до require('../server/...')) ---
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bogusa-test-'));
process.env.DATA_DIR = tempDir;
process.env.DB_FILE = path.join(tempDir, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.ADMIN_LOGIN = 'admin';
process.env.ADMIN_PASSWORD = 'Admin#2026pass';
process.env.ANTI_BOT_MIN_FILL_MS = '0';
process.env.RATE_LIMIT_API = '100000';
process.env.RATE_LIMIT_LOGIN = '100000';
process.env.RATE_LIMIT_SUBMIT = '100000';
process.env.MIN_ANSWERS_TO_SHOW = '1';
process.env.NODE_ENV = 'test';

const app = require('../server/app');
const { ensureAdminAccount } = require('../server/seed');
const { db } = require('../server/db');

let server;
let baseUrl;

/** Мини-клиент с хранением cookie. */
function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(method, url, body, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookie.length > 0) {
        cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text, headers: res.headers };
    },
    post(url, body, headers) {
      return this.request('POST', url, body, headers);
    },
    patch(url, body, headers) {
      return this.request('PATCH', url, body, headers);
    },
    get(url, headers) {
      return this.request('GET', url, undefined, headers);
    },
    del(url, headers) {
      return this.request('DELETE', url, undefined, headers);
    },
  };
}

const lessonScores = {
  l_goals: 5,
  l_logic: 4,
  l_visual: 3,
  l_atmosphere: 5,
  l_pace: 4,
  l_org: 5,
};

const finalScores = {
  f_theory_practice: 5,
  f_depth: 4,
  f_materials: 4,
  f_workload: 3,
  f_style: 5,
  f_fairness: 4,
  f_feedback: 4,
  f_overall: 5,
  f_recommend: 5,
};

test.before(async () => {
  const admin = ensureAdminAccount();
  assert.ok(admin, 'администратор создан');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/* ----------------------------- публичные -------------------------------- */

test('health и метаданные доступны без авторизации', async () => {
  const client = makeClient();
  const health = await client.get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const meta = await client.get('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.forms.length, 2);
  assert.ok(meta.json.forms.some((f) => f.key === 'lesson'));
  assert.ok(meta.json.forms.some((f) => f.key === 'final'));
});

test('описание анкеты содержит все пункты и подписи шкалы', async () => {
  const client = makeClient();
  const res = await client.get('/api/forms/final');
  assert.equal(res.status, 200);
  const questions = res.json.sections.flatMap((s) => s.questions);
  assert.equal(res.json.scale_count, 9);
  assert.ok(questions.every((q) => q.label.length > 0));
  assert.equal(res.json.scale_labels['5'], '5 — полностью да');
});

test('неизвестный тип анкеты отклоняется', async () => {
  const client = makeClient();
  const res = await client.get('/api/forms/whatever');
  assert.equal(res.status, 400);
});

test('студент видит только активные дисциплины с темами', async () => {
  const client = makeClient();
  const empty = await client.get('/api/disciplines');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.disciplines, []);
});

/* ----------------------------- админ-цепочка ---------------------------- */

let adminClient;
let disciplineId;
let topicId;
let teacherId;
let teacherPassword;

test('администратор входит, создаёт преподавателя и дисциплину', async () => {
  adminClient = makeClient();
  const login = await adminClient.post('/api/auth/login', {
    login: 'admin',
    password: 'Admin#2026pass',
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'admin');

  const teacher = await adminClient.post('/api/admin/teachers', {
    login: 'petrov',
    full_name: 'Петров Пётр Петрович',
  });
  assert.equal(teacher.status, 201);
  assert.ok(teacher.json.password, 'пароль возвращается один раз');
  teacherId = teacher.json.teacher.id;
  teacherPassword = teacher.json.password;

  const discipline = await adminClient.post('/api/admin/disciplines', {
    title: 'Дискретная математика',
    code: 'DM-201',
    teacher_id: teacherId,
  });
  assert.equal(discipline.status, 201);
  disciplineId = discipline.json.discipline.id;

  const topic = await adminClient.post('/api/admin/topics', {
    discipline_id: disciplineId,
    title: 'Графы и деревья',
    lesson_date: '2026-10-01',
  });
  assert.equal(topic.status, 201);
  topicId = topic.json.id;

  const bulk = await adminClient.post(`/api/admin/disciplines/${disciplineId}/topics/bulk`, {
    topics: [{ title: 'Множества и отношения' }, { title: 'Комбинаторика', lesson_date: '2026-10-08' }],
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.json.created, 2);
});

test('слабые пароли и повтор логина отклоняются', async () => {
  const weak = await adminClient.post('/api/admin/teachers', {
    login: 'newteacher',
    full_name: 'Новый Преподаватель',
    password: '123456',
  });
  assert.equal(weak.status, 400);

  const duplicate = await adminClient.post('/api/admin/teachers', {
    login: 'petrov',
    full_name: 'Дубль Дубль',
  });
  assert.equal(duplicate.status, 409);
});

/* --------------------------- публичное заполнение ---------------------- */

let responseId1;

test('публичный каталог отдаёт дисциплину с темами и преподавателем', async () => {
  const client = makeClient();
  const list = await client.get('/api/disciplines');
  assert.equal(list.json.disciplines.length, 1);
  assert.equal(list.json.disciplines[0].title, 'Дискретная математика');
  assert.equal(list.json.disciplines[0].topics_count, 3);
  assert.equal(list.json.disciplines[0].teacher_name, 'Петров Пётр Петрович');

  const detail = await client.get(`/api/disciplines/${disciplineId}`);
  assert.equal(detail.json.discipline.topics.length, 3);
});

test('студент отправляет анкету по занятию анонимно', async () => {
  const student = makeClient();
  const res = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_liked: 'Понятные примеры', l_improve: 'Больше практики', l_wishes: '' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  responseId1 = res.json.id;

  // Сервер не должен возвращать ничего, что связывает ответ со студентом
  const keys = Object.keys(res.json).sort();
  assert.deepEqual(keys, ['id', 'message', 'ok']);
});

test('анкета с пропущенными пунктами или чужим типом отклоняется', async () => {
  const student = makeClient();
  const incomplete = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: { l_goals: 5 },
  });
  assert.equal(incomplete.status, 400);

  const mixed = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: { ...lessonScores, f_depth: 5 },
  });
  assert.equal(mixed.status, 400);
});

test('итоговая анкета сохраняется без темы', async () => {
  const student = makeClient();
  const res = await student.post('/api/responses', {
    discipline_id: disciplineId,
    form_type: 'final',
    scores: finalScores,
    comments: { f_wishes: 'Спасибо за курс' },
  });
  assert.equal(res.status, 201);
});

test('оценки и открытые ответы нельзя связать со студентом в БД', async () => {
  const { all } = require('../server/db');
  const columns = all("PRAGMA table_info('responses')").map((c) => c.name);
  for (const forbidden of ['student', 'user_id', 'ip', 'email', 'full_name', 'group_name', 'student_name']) {
    assert.ok(!columns.includes(forbidden), `в таблице responses не должно быть колонки ${forbidden}`);
  }
  const commentColumns = all("PRAGMA table_info('answer_comments')").map((c) => c.name);
  assert.deepEqual(commentColumns.sort(), ['body', 'created_date', 'id', 'question_key', 'response_id']);
});

test('«ловушка» для ботов молча не сохраняет ответ', async () => {
  const bot = makeClient();
  const res = await bot.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    contact_email: 'bot@example.com',
  });
  assert.equal(res.status, 202);

  const { get } = require('../server/db');
  const count = get("SELECT COUNT(*) AS n FROM responses WHERE form_type = 'lesson'").n;
  assert.equal(count, 1, 'в БД должна остаться только анкета реального студента');
});

/* --------------------------- портал преподавателя ----------------------- */

test('преподаватель без входа не получает доступ к отчётам', async () => {
  const anon = makeClient();
  const res = await anon.get('/api/teacher/overview');
  assert.equal(res.status, 401);
});

test('преподаватель меняет временный пароль и видит свои дисциплины', async () => {
  const teacher = makeClient();
  const login = await teacher.post('/api/auth/login', { login: 'petrov', password: teacherPassword });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.must_change_password, true);

  // до смены пароля отчёты недоступны
  const blocked = await teacher.get('/api/teacher/overview');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');

  const changed = await teacher.post('/api/auth/password', {
    current_password: teacherPassword,
    new_password: 'Noviy#Parol2026',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.must_change_password, false);

  const overview = await teacher.get('/api/teacher/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.totals.responses, 2);
  assert.equal(overview.json.totals.lesson, 1);
  assert.equal(overview.json.totals.final, 1);
  assert.equal(overview.json.disciplines.length, 1);
  assert.ok(overview.json.totals.overall_avg > 3, 'средний балл рассчитан');
});

test('преподаватель видит агрегацию и комментарии по своей дисциплине', async () => {
  const teacher = makeClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const report = await teacher.get(`/api/teacher/disciplines/${disciplineId}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.json.total_responses, 2);

  const lessonForm = report.json.forms.find((f) => f.form_type === 'lesson');
  assert.equal(lessonForm.questions.length, 6);
  const goals = lessonForm.questions.find((q) => q.key === 'l_goals');
  assert.equal(goals.avg, 5);
  assert.equal(goals.count, 1);

  const comments = lessonForm.comments.flatMap((c) => c.items).map((i) => i.body);
  assert.ok(comments.includes('Понятные примеры'));
  assert.ok(!comments.includes(''), 'пустые комментарии не сохраняются');
});

test('чужая дисциплина и чужие темы недоступны преподавателю', async () => {
  // создаём вторую дисциплину у другого преподавателя
  const other = await adminClient.post('/api/admin/teachers', {
    login: 'sidorova',
    full_name: 'Сидорова Анна',
    password: 'Sidorova#2026',
  });
  const otherDiscipline = await adminClient.post('/api/admin/disciplines', {
    title: 'Математический анализ',
    teacher_id: other.json.teacher.id,
  });

  const teacher = makeClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const foreign = await teacher.get(`/api/teacher/disciplines/${otherDiscipline.json.discipline.id}/report`);
  assert.equal(foreign.status, 403);

  const foreignComments = await teacher.get(
    `/api/teacher/comments?discipline_id=${otherDiscipline.json.discipline.id}`
  );
  assert.equal(foreignComments.status, 403);
});

test('преподаватель не имеет доступа к админским методам', async () => {
  const teacher = makeClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const res = await teacher.get('/api/admin/teachers');
  assert.equal(res.status, 403);
});

/* ------------------------------ XSS и выгрузка -------------------------- */

test('скрипт в открытом ответе сохраняется в безопасном виде', async () => {
  const student = makeClient();
  await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_wishes: '<script>alert("xss")</script> и ещё пожелание' },
  });

  const teacher = makeClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const comments = await teacher.get(`/api/teacher/comments?discipline_id=${disciplineId}&q=пожелание`);
  assert.equal(comments.status, 200);
  const body = comments.json.comments[0].body;
  assert.ok(!body.includes('<script>'), 'в API не должно быть «живого» тега script');
  assert.ok(body.includes('&lt;script&gt;'));
});

test('выгрузка CSV отдаётся файлом с корректной кодировкой', async () => {
  const teacher = makeClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const res = await teacher.get(`/api/teacher/export.csv?discipline_id=${disciplineId}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.ok(res.text.startsWith('ID анкеты;'), 'первая строка — заголовки колонок');
  assert.ok(res.text.includes('Дискретная математика'));

  // Проверяем «сырые» байты: файл должен начинаться с BOM, иначе Excel ломает кириллицу.
  const raw = Buffer.from(await (await fetch(`${baseUrl}/api/teacher/export.csv?discipline_id=${disciplineId}`, {
    headers: { Cookie: teacher.cookie },
  })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ожидается UTF-8 BOM');
});

/* ------------------------------ админ-отчёты ---------------------------- */

test('администратор видит сквозной отчёт по всем дисциплинам', async () => {
  const report = await adminClient.get('/api/admin/report');
  assert.equal(report.status, 200);
  assert.equal(report.json.total_responses, 3);
  assert.deepEqual(report.json.by_form, { lesson: 2, final: 1 });
});

test('ссылка для студентов и QR-код формируются', async () => {
  const link = await adminClient.get(`/api/admin/link?discipline_id=${disciplineId}&topic_id=${topicId}&form_type=lesson`);
  assert.equal(link.status, 200);
  assert.match(link.json.url, /\/form\.html\?/);
  assert.match(link.json.url, new RegExp(`discipline=${disciplineId}`));

  const qr = await adminClient.get(`/api/admin/qr.png?discipline_id=${disciplineId}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/png/);
});

test('журнал аудита содержит действия администратора', async () => {
  const audit = await adminClient.get('/api/admin/audit?limit=50');
  assert.equal(audit.status, 200);
  const actions = audit.json.events.map((e) => e.action);
  assert.ok(actions.includes('teacher.created'));
  assert.ok(actions.includes('discipline.created'));
  assert.ok(!JSON.stringify(audit.json).includes('Admin#2026pass'), 'пароли не попадают в журнал');
});

test('сессия работает по Bearer-токену, если cookie недоступна (iframe, блокировка 3rd-party cookie)', async () => {
  const raw = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'petrov', password: 'Noviy#Parol2026' }),
  });
  const { token } = await raw.json();
  assert.ok(token, 'токен возвращается в ответе на вход');

  // Браузер заблокировал cookie — работаем только по заголовку Authorization
  const withoutCookie = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(withoutCookie.status, 200);

  const overview = await fetch(`${baseUrl}/api/teacher/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(overview.status, 200);

  // Битая cookie не должна ломать валидный токен
  const staleCookie = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: 'bf_token=broken.token.value', Authorization: `Bearer ${token}` },
  });
  assert.equal(staleCookie.status, 200);

  // Валидная cookie имеет приоритет, даже если рядом мусорный Bearer
  const mixed = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `bf_token=${token}`, Authorization: 'Bearer broken.token.value' },
  });
  assert.equal(mixed.status, 200);

  // Полностью неверные данные — доступа нет
  const denied = await fetch(`${baseUrl}/api/teacher/overview`, {
    headers: { Authorization: 'Bearer broken.token.value' },
  });
  assert.equal(denied.status, 401);
});

test('выход из системы очищает cookie', async () => {
  const client = makeClient();
  await client.post('/api/auth/login', { login: 'admin', password: 'Admin#2026pass' });
  assert.equal((await client.get('/api/auth/me')).status, 200);
  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).status, 401);
});
