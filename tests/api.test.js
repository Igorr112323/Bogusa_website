'use strict';

/**
 * Интеграционные тесты API: анонимная отправка, вход, разграничение доступа,
 * защита от XSS, выгрузка CSV, разделение студенческого и служебного портов.
 *
 * Тест поднимает два приложения на случайных портах (как в боевом запуске:
 * студенты на PORT, преподаватель и администратор на STAFF_PORT) и использует
 * отдельную временную БД.
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
process.env.PORT = '39000';
process.env.STAFF_PORT = '39001';

const createApp = require('../server/app');
const { ensureAdminAccount } = require('../server/seed');
const { db, run, all } = require('../server/db');

let studentServer;
let staffServer;
let studentUrl;
let staffUrl;

/** Разделы, которые существуют только на служебном порту. */
const STAFF_PREFIXES = ['/api/auth', '/api/teacher', '/api/admin', '/login', '/portal', '/admin'];

function baseFor(url) {
  const clean = url.split('?')[0].replace(/\/+$/, '') || '/';
  const isStaff = STAFF_PREFIXES.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
  return isStaff ? staffUrl : studentUrl;
}

/** Мини-клиент с хранением cookie. По умолчанию сам выбирает порт по адресу. */
function makeClient(pinnedBase = null) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(method, url, body, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${pinnedBase || baseFor(url)}${url}`, {
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

/** Клиент, который всегда обращается к студенческому порту. */
const studentClient = () => makeClient(studentUrl);
/** Клиент, который всегда обращается к порту преподавателя и администратора. */
const staffClient = () => makeClient(staffUrl);

/* Все пункты анкет — состав берётся из определений, чтобы тест не «отставал». */
const { getScaleQuestions } = require('../server/questions');

function allScores(formType) {
  const scores = {};
  getScaleQuestions(formType).forEach((q, index) => {
    scores[q.key] = (index % 5) + 1;
  });
  return scores;
}

const lessonScores = allScores('lesson');
const finalScores = allScores('final');

test.before(async () => {
  const admin = ensureAdminAccount();
  assert.ok(admin, 'администратор создан');

  studentServer = createApp('student').listen(0, '127.0.0.1');
  await new Promise((resolve) => studentServer.once('listening', resolve));
  studentUrl = `http://127.0.0.1:${studentServer.address().port}`;

  staffServer = createApp('staff').listen(0, '127.0.0.1');
  await new Promise((resolve) => staffServer.once('listening', resolve));
  staffUrl = `http://127.0.0.1:${staffServer.address().port}`;

  assert.notEqual(studentUrl, staffUrl, 'студенты и панели работают на разных портах');
});

test.after(() => {
  studentServer.close();
  staffServer.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/* ----------------------------- публичные -------------------------------- */

test('health и метаданные доступны без авторизации', async () => {
  const client = studentClient();
  const health = await client.get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.scope, 'student');

  const meta = await client.get('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.forms.length, 2);
  assert.ok(meta.json.forms.some((f) => f.key === 'lesson'));
  assert.ok(meta.json.forms.some((f) => f.key === 'final'));
  assert.equal(
    new URL(meta.json.student_base_url).port,
    process.env.PORT,
    'ссылки для студентов всегда ведут на студенческий порт'
  );
});

test('описание анкеты содержит все пункты и подписи шкалы', async () => {
  const client = studentClient();

  const final = await client.get('/api/forms/final');
  assert.equal(final.status, 200);
  assert.equal(final.json.title, 'Итоговая анкета оценки дисциплины и работы ведущего преподавателя');
  assert.equal(final.json.scale_count, 15);
  assert.equal(final.json.text_count, 3);
  assert.equal(final.json.sections.length, 5);
  const finalQuestions = final.json.sections.flatMap((s) => s.questions);
  assert.ok(finalQuestions.every((q) => q.label.length > 0));
  assert.ok(finalQuestions.every((q) => !q.hint), 'пояснений под вопросами нет');
  assert.ok(finalQuestions.every((q) => !q.placeholder), 'подсказок-примеров нет');
  assert.equal(final.json.scale_labels['1'], '1 — совершенно не согласен');
  assert.equal(final.json.scale_labels['5'], '5 — полностью согласен');

  const lesson = await client.get('/api/forms/lesson');
  assert.equal(lesson.json.title, 'Анкета оценки качества проведенного занятия');
  assert.match(lesson.json.subtitle, /^Пожалуйста, оцените проведенное занятие\./);
  assert.equal(lesson.json.scale_count, 12);
  assert.equal(lesson.json.text_count, 2);
  assert.equal(lesson.json.sections.length, 4);
  assert.equal(lesson.json.scale_words['1'], 'Не согласен');
  assert.equal(lesson.json.scale_words['5'], 'Полностью');
});

test('неизвестный тип анкеты отклоняется', async () => {
  const client = studentClient();
  const res = await client.get('/api/forms/whatever');
  assert.equal(res.status, 400);
});

test('студент видит только активные дисциплины с темами', async () => {
  const client = studentClient();
  const empty = await client.get('/api/disciplines');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.disciplines, []);
});

/* ------------------------- разделение портов ---------------------------- */

test('на студенческом порту разделы преподавателя и администратора не существуют', async () => {
  const student = studentClient();
  for (const url of [
    '/login',
    '/login.html',
    '/portal/',
    '/admin/',
    '/js/login.js',
    '/js/portal.js',
    '/js/admin.js',
    '/css/dashboard.css',
  ]) {
    const res = await student.get(url);
    assert.equal(res.status, 404, `${url} не должен отдаваться на студенческом порту`);
  }

  for (const url of ['/api/auth/login', '/api/auth/me', '/api/teacher/overview', '/api/admin/overview']) {
    const res = await student.get(url);
    assert.equal(res.status, 404, `${url} не должен отвечать на студенческом порту`);
  }

  const login = await student.post('/api/auth/login', { login: 'admin', password: 'Admin#2026pass' });
  assert.equal(login.status, 404, 'войти через студенческий порт нельзя');
});

test('в студенческих страницах нет упоминаний входа, портала и админ-панели', async () => {
  const student = studentClient();
  for (const url of ['/', '/form.html']) {
    const res = await student.get(url);
    assert.equal(res.status, 200);
    const html = res.text.toLowerCase();
    for (const forbidden of ['/login', '/portal', '/admin', 'вход для преподавателя', 'админ-панель']) {
      assert.ok(!html.includes(forbidden), `на странице ${url} не должно быть «${forbidden}»`);
    }
  }
});

test('на служебном порту доступны вход, портал и админ-панель', async () => {
  const staff = staffClient();
  for (const url of ['/login', '/portal/', '/admin/']) {
    const res = await staff.get(url);
    assert.equal(res.status, 200, `${url} должен отдаваться на порту панелей`);
  }
  const health = await staff.get('/healthz');
  assert.equal(health.json.scope, 'staff');
});

/* ----------------------------- админ-цепочка ---------------------------- */

let adminClient;
let disciplineId;
let topicId;
let teacherId;
let teacherPassword;

test('администратор входит, создаёт преподавателя и дисциплину', async () => {
  adminClient = staffClient();
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

test('публичный каталог отдаёт дисциплину с темами и преподавателем', async () => {
  const client = studentClient();
  const list = await client.get('/api/disciplines');
  assert.equal(list.json.disciplines.length, 1);
  assert.equal(list.json.disciplines[0].title, 'Дискретная математика');
  assert.equal(list.json.disciplines[0].topics_count, 3);
  assert.equal(list.json.disciplines[0].teacher_name, 'Петров Пётр Петрович');

  const detail = await client.get(`/api/disciplines/${disciplineId}`);
  assert.equal(detail.json.discipline.topics.length, 3);
});

test('студент отправляет анкету по занятию анонимно', async () => {
  const student = studentClient();
  const res = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_liked: 'Понятные примеры', l_improve: 'Больше практики' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);

  // Сервер не должен возвращать ничего, что связывает ответ со студентом
  const keys = Object.keys(res.json).sort();
  assert.deepEqual(keys, ['id', 'message', 'ok']);
});

test('анкета с пропущенными пунктами или чужим типом отклоняется', async () => {
  const student = studentClient();
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

test('ответ по вопросу, которого больше нет в анкете, не принимается', async () => {
  const student = studentClient();
  const res = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_wishes: 'Пожелание преподавателю' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Неизвестный открытый вопрос/);
});

test('итоговая анкета сохраняется без темы', async () => {
  const student = studentClient();
  const res = await student.post('/api/responses', {
    discipline_id: disciplineId,
    form_type: 'final',
    scores: finalScores,
    comments: { f_strengths: 'Спасибо за курс' },
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
  const bot = studentClient();
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
  const anon = staffClient();
  const res = await anon.get('/api/teacher/overview');
  assert.equal(res.status, 401);
});

test('преподаватель меняет временный пароль и видит свои дисциплины', async () => {
  const teacher = staffClient();
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
  assert.equal(overview.json.disciplines[0].responses, 2, 'в сводке — ответы именно этой дисциплины');
  assert.ok(overview.json.totals.overall_avg > 1, 'средний балл рассчитан');
});

test('преподаватель видит агрегацию и комментарии по своей дисциплине', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const report = await teacher.get(`/api/teacher/disciplines/${disciplineId}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.json.total_responses, 2);

  const lessonForm = report.json.forms.find((f) => f.form_type === 'lesson');
  assert.equal(lessonForm.questions.length, 12, 'все пункты анкеты по занятию попадают в отчёт');
  const goals = lessonForm.questions.find((q) => q.key === 'l_goals');
  assert.equal(goals.avg, lessonScores.l_goals);
  assert.equal(goals.count, 1);
  assert.equal(goals.hint, null, 'пояснений к пунктам больше нет');
  assert.match(goals.label, /^Понятность целей:/);

  const comments = lessonForm.comments.flatMap((c) => c.items).map((i) => i.body);
  assert.ok(comments.includes('Понятные примеры'));
  assert.ok(comments.includes('Больше практики'));
  assert.ok(!comments.includes(''), 'пустые комментарии не сохраняются');
});

test('ответы по снятым с анкеты вопросам остаются видимыми в отчёте и выгрузке', async () => {
  const { run, get } = require('../server/db');
  // Старый ответ, собранный до версии 1.0.3: ключ l_wishes из формы убран.
  const responseId = get(
    "SELECT id FROM responses WHERE discipline_id = ? AND form_type = 'lesson' LIMIT 1",
    disciplineId
  ).id;
  run(
    `INSERT INTO answer_comments (response_id, question_key, body, created_date)
     VALUES (?, ?, ?, ?)`,
    responseId,
    'l_wishes',
    'СТАРЫЙ_ОТВЕТ_ПОЖЕЛАНИЕ',
    '2026-09-30'
  );

  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const report = await teacher.get(`/api/teacher/disciplines/${disciplineId}/report`);
  const lessonForm = report.json.forms.find((f) => f.form_type === 'lesson');
  const archived = (lessonForm.archived_comments || []).flatMap((c) => c.items).map((i) => i.body);
  assert.ok(archived.includes('СТАРЫЙ_ОТВЕТ_ПОЖЕЛАНИЕ'), 'старые ответы не теряются');

  const comments = await teacher.get(`/api/teacher/comments?discipline_id=${disciplineId}`);
  const legacy = comments.json.comments.find((c) => c.question_key === 'l_wishes');
  assert.ok(legacy, 'старый ответ виден в списке отзывов');
  assert.equal(legacy.question_label, 'Пожелания преподавателю');

  const csv = await teacher.get(`/api/teacher/export.csv?discipline_id=${disciplineId}`);
  assert.ok(csv.text.includes('СТАРЫЙ_ОТВЕТ_ПОЖЕЛАНИЕ'), 'старый ответ попадает в CSV');
  assert.ok(csv.text.includes('[комментарий, снят с анкеты]'), 'в CSV для него отдельная колонка');
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

  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const foreign = await teacher.get(`/api/teacher/disciplines/${otherDiscipline.json.discipline.id}/report`);
  assert.equal(foreign.status, 403);

  const foreignComments = await teacher.get(
    `/api/teacher/comments?discipline_id=${otherDiscipline.json.discipline.id}`
  );
  assert.equal(foreignComments.status, 403);
});

test('преподаватель не имеет доступа к админским методам', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const res = await teacher.get('/api/admin/teachers');
  assert.equal(res.status, 403);
});

test('удаление преподавателя убирает его дисциплины, темы и все ответы', async () => {
  const created = await adminClient.post('/api/admin/teachers', {
    login: 'orlova',
    full_name: 'Орлова Пелагея',
    password: 'Orlova#2026pass',
  });
  assert.equal(created.status, 201);
  const teacherId = created.json.teacher.id;

  const discipline = await adminClient.post('/api/admin/disciplines', {
    title: 'Дискретная математика на удаление',
    teacher_id: teacherId,
  });
  assert.equal(discipline.status, 201);
  const ownDisciplineId = discipline.json.discipline.id;

  const topicIds = [];
  for (const title of ['Множества', 'Графы']) {
    const res = await adminClient.post('/api/admin/topics', {
      discipline_id: ownDisciplineId,
      title,
      lesson_date: '2026-09-05',
    });
    assert.equal(res.status, 201);
    topicIds.push(res.json.id);
  }

  const student = studentClient();
  const sent = await student.post('/api/responses', {
    discipline_id: ownDisciplineId,
    topic_id: topicIds[0],
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_improve: 'Больше задач на графы' },
  });
  assert.equal(sent.status, 201);

  const removed = await adminClient.del(`/api/admin/teachers/${teacherId}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.removed, { disciplines: 1, topics: 2, responses: 1 });

  const adminList = await adminClient.get('/api/admin/disciplines');
  assert.ok(!adminList.json.disciplines.some((d) => d.id === ownDisciplineId), 'дисциплина удалена вместе с владельцем');
  const catalog = await studentClient().get('/api/disciplines');
  assert.ok(!catalog.json.disciplines.some((d) => d.id === ownDisciplineId), 'в списке для студентов её больше нет');

  assert.equal(all('SELECT * FROM topics WHERE discipline_id = ?', ownDisciplineId).length, 0, 'тем не осталось');
  assert.equal(all('SELECT * FROM responses WHERE discipline_id = ?', ownDisciplineId).length, 0, 'анкет не осталось');
  assert.equal(all("SELECT * FROM answer_scores WHERE response_id = ?", sent.json.id).length, 0, 'оценок не осталось');
  assert.equal(all("SELECT * FROM answer_comments WHERE response_id = ?", sent.json.id).length, 0, 'отзывов не осталось');
  assert.equal(all('SELECT * FROM teacher_views WHERE user_id = ?', teacherId).length, 0, 'отметок о просмотре не осталось');
  assert.equal(all('SELECT * FROM users WHERE id = ?', teacherId).length, 0, 'аккаунт удалён');

  const relogin = await staffClient().post('/api/auth/login', { login: 'orlova', password: 'Orlova#2026pass' });
  assert.equal(relogin.status, 401, 'вход удалённого преподавателя невозможен');
});

test('удалить себя и последнего администратора нельзя', async () => {
  const me = await adminClient.get('/api/auth/me');
  const self = await adminClient.del(`/api/admin/teachers/${me.json.user.id}`);
  assert.equal(self.status, 400);
  assert.match(self.json.error, /собственну/);
});

test('на студенческом порту healthz не рассказывает про сервер', async () => {
  const res = await studentClient().get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(!('driver' in res.json) && !('uptime' in res.json), 'студентам не нужны сведения об устройстве сервера');
  const staff = await staffClient().get('/healthz');
  assert.ok('driver' in staff.json, 'на служебном порту сведения о драйвере остаются');
});

/* ------------------------------ XSS и выгрузка -------------------------- */

test('скрипт в открытом ответе сохраняется в безопасном виде', async () => {
  const student = studentClient();
  await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_improve: '<script>alert("xss")</script> и ещё пожелание' },
  });

  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const comments = await teacher.get(`/api/teacher/comments?discipline_id=${disciplineId}&q=пожелание`);
  assert.equal(comments.status, 200);
  const body = comments.json.comments[0].body;
  assert.ok(!body.includes('<script>'), 'в API не должно быть «живого» тега script');
  assert.ok(body.includes('&lt;script&gt;'));
});

test('выгрузка CSV отдаётся файлом с корректной кодировкой', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });
  const res = await teacher.get(`/api/teacher/export.csv?discipline_id=${disciplineId}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.ok(res.text.startsWith('ID анкеты;'), 'первая строка — заголовки колонок');
  assert.ok(res.text.includes('Дискретная математика'));
  assert.ok(res.text.includes('Понятность целей'), 'в заголовках — формулировки из анкеты');

  // Проверяем «сырые» байты: файл должен начинаться с BOM, иначе Excel ломает кириллицу.
  const raw = Buffer.from(
    await (
      await fetch(`${staffUrl}/api/teacher/export.csv?discipline_id=${disciplineId}`, {
        headers: { Cookie: teacher.cookie },
      })
    ).arrayBuffer()
  );
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ожидается UTF-8 BOM');
});

/* ------------------------------ админ-отчёты ---------------------------- */

test('администратор видит сквозной отчёт по всем дисциплинам', async () => {
  const report = await adminClient.get('/api/admin/report');
  assert.equal(report.status, 200);
  assert.equal(report.json.total_responses, 3);
  assert.deepEqual(report.json.by_form, { lesson: 2, final: 1 });
});

test('ссылка для студентов и QR-код ведут на студенческий порт', async () => {
  const link = await adminClient.get(
    `/api/admin/link?discipline_id=${disciplineId}&topic_id=${topicId}&form_type=lesson`
  );
  assert.equal(link.status, 200);
  assert.match(link.json.url, /\/form\.html\?/);
  assert.match(link.json.url, new RegExp(`discipline=${disciplineId}`));
  assert.ok(
    link.json.url.includes(`:${process.env.PORT}/`),
    `ссылка для студентов должна вести на порт ${process.env.PORT}, получено: ${link.json.url}`
  );
  assert.ok(!link.json.url.includes(`:${process.env.STAFF_PORT}/`), 'адрес панели студентам не отдаётся');

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
  const raw = await fetch(`${staffUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'petrov', password: 'Noviy#Parol2026' }),
  });
  const { token } = await raw.json();
  assert.ok(token, 'токен возвращается в ответе на вход');

  // Браузер заблокировал cookie — работаем только по заголовку Authorization
  const withoutCookie = await fetch(`${staffUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(withoutCookie.status, 200);

  const overview = await fetch(`${staffUrl}/api/teacher/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(overview.status, 200);

  // Битая cookie не должна ломать валидный токен
  const staleCookie = await fetch(`${staffUrl}/api/auth/me`, {
    headers: { Cookie: 'bf_token=broken.token.value', Authorization: `Bearer ${token}` },
  });
  assert.equal(staleCookie.status, 200);

  // Валидная cookie имеет приоритет, даже если рядом мусорный Bearer
  const mixed = await fetch(`${staffUrl}/api/auth/me`, {
    headers: { Cookie: `bf_token=${token}`, Authorization: 'Bearer broken.token.value' },
  });
  assert.equal(mixed.status, 200);

  // Полностью неверные данные — доступа нет
  const denied = await fetch(`${staffUrl}/api/teacher/overview`, {
    headers: { Authorization: 'Bearer broken.token.value' },
  });
  assert.equal(denied.status, 401);
});

test('выход из системы очищает cookie', async () => {
  const client = staffClient();
  await client.post('/api/auth/login', { login: 'admin', password: 'Admin#2026pass' });
  assert.equal((await client.get('/api/auth/me')).status, 200);
  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).status, 401);
});


test('границы периода в сводке не зависят от порядка записей в базе', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  // Ответы хранятся в порядке id, а их даты могут идти вразнобой (демонстрационные
  // данные, восстановление из резервной копии). Границы должны считаться по датам.
  const ids = all('SELECT id FROM responses ORDER BY id DESC').map((row) => row.id);
  assert.ok(ids.length >= 2, 'для проверки нужно хотя бы два ответа');
  run(`UPDATE responses SET created_at = '2026-05-01T09:00:00.000Z'`);
  // Самый новый по id ответ делаем самым ранним, а самый старый по id — самым поздним.
  run(`UPDATE responses SET created_at = '2026-01-05T08:00:00.000Z' WHERE id = ?`, ids[0]);
  run(`UPDATE responses SET created_at = '2026-09-18T12:30:00.000Z' WHERE id = ?`, ids[ids.length - 1]);

  const overview = await teacher.get('/api/teacher/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.totals.first_response_at, '2026-01-05T08:00:00.000Z');
  assert.equal(overview.json.totals.last_response_at, '2026-09-18T12:30:00.000Z');
});

/* --------------- Ведение дисциплин и тем самим преподавателем --------------- */

test('преподаватель создаёт дисциплину и темы, правит их, но не удаляет', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const created = await teacher.post('/api/teacher/disciplines', { title: 'Веб-технологии', code: 'WT-101' });
  assert.equal(created.status, 201);
  const myDiscipline = created.json.discipline;
  assert.equal(myDiscipline.teacher_id, teacherId, 'дисциплина сразу закреплена за создателем');
  assert.equal(myDiscipline.is_active, 1);

  const tooShort = await teacher.post('/api/teacher/disciplines', { title: 'А' });
  assert.equal(tooShort.status, 400, 'название короче двух символов не принимается');

  const topic = await teacher.post('/api/teacher/topics', {
    discipline_id: myDiscipline.id,
    title: 'Введение и настройка окружения',
    lesson_date: '2026-09-01',
  });
  assert.equal(topic.status, 201);

  const bulk = await teacher.post(`/api/teacher/disciplines/${myDiscipline.id}/topics/bulk`, {
    topics: [{ title: 'Семантическая вёрстка' }, { title: 'Формы и валидация', lesson_date: '2026-09-08' }],
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.json.created, 2);

  const list = await teacher.get('/api/teacher/disciplines');
  const mine = list.json.disciplines.find((d) => d.id === myDiscipline.id);
  assert.equal(mine.topics.length, 3, 'темы видны в списке дисциплин');
  assert.ok(mine.topics.every((t) => 'responses' in t), 'у каждой темы видно число анкет');

  const renamed = await teacher.patch(`/api/teacher/disciplines/${myDiscipline.id}`, {
    title: 'Веб-технологии, модуль 2',
    teacher_id: 1,
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.discipline.title, 'Веб-технологии, модуль 2');
  assert.equal(renamed.json.discipline.teacher_id, teacherId, 'перевесить дисциплину на другого может только администратор');

  const topicEdit = await teacher.patch(`/api/teacher/topics/${topic.json.id}`, { title: 'Введение', is_active: false });
  assert.equal(topicEdit.status, 200);

  const off = await teacher.patch(`/api/teacher/disciplines/${myDiscipline.id}`, { is_active: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.discipline.is_active, 0, 'дисциплина выключена');

  assert.equal((await teacher.del(`/api/teacher/disciplines/${myDiscipline.id}`)).status, 404, 'удалять дисциплины - право администратора');
  assert.equal((await teacher.del(`/api/teacher/topics/${topic.json.id}`)).status, 404, 'темы тоже не удаляются из кабинета');

  const other = await adminClient.post('/api/admin/teachers', {
    login: 'foreign',
    full_name: 'Чужой Преподаватель',
    password: 'Foreign#2026pass',
  });
  const foreignDiscipline = await adminClient.post('/api/admin/disciplines', {
    title: 'Иностранный язык в профессиональной сфере',
    teacher_id: other.json.teacher.id,
  });
  const foreignId = foreignDiscipline.json.discipline.id;

  assert.equal((await teacher.patch(`/api/teacher/disciplines/${foreignId}`, { title: 'Взлом' })).status, 403);
  assert.equal((await teacher.post('/api/teacher/topics', { discipline_id: foreignId, title: 'Чужая тема' })).status, 403);
  assert.equal(
    (await teacher.post(`/api/teacher/disciplines/${foreignId}/topics/bulk`, { topics: [{ title: 'Чужая тема 2' }] })).status,
    403
  );
  const foreignTopic = await adminClient.post('/api/admin/topics', {
    discipline_id: foreignId,
    title: 'Чужое занятие',
    lesson_date: '2026-09-01',
  });
  assert.equal(foreignTopic.status, 201);
  assert.equal((await teacher.patch(`/api/teacher/topics/${foreignTopic.json.id}`, { title: 'Переименовано чужим' })).status, 403);

  // выключенная дисциплина исчезает из студенческого каталога
  const catalog = await studentClient().get('/api/disciplines');
  assert.ok(!catalog.json.disciplines.some((d) => d.id === myDiscipline.id), 'выключенную дисциплину студенты не видят');
});

test('счётчик новых ответов: отметка просмотра раздела сбрасывает его', async () => {
  const teacher = staffClient();
  await teacher.post('/api/auth/login', { login: 'petrov', password: 'Noviy#Parol2026' });

  const before = await teacher.get('/api/teacher/disciplines');
  assert.equal(before.status, 200);
  assert.equal(before.json.seen_at, null, 'отметки о просмотре ещё нет');
  const target = before.json.disciplines.find((d) => d.id === disciplineId);
  assert.ok(target.new_responses >= 2, 'пока преподаватель не заходил, все ответы новые');
  assert.ok(target.new_comments >= 1);
  assert.ok(before.json.new_responses_total >= 2);

  const seen = await teacher.post('/api/teacher/seen', {});
  assert.equal(seen.status, 200);
  assert.ok(seen.json.seen_at);

  const after = await teacher.get('/api/teacher/disciplines');
  assert.equal(after.json.new_responses_total, 0, 'раздел просмотрен: новых нет');
  assert.equal(after.json.new_comments_total, 0);
  const cleanReport = await teacher.get(`/api/teacher/disciplines/${disciplineId}/report?form_type=lesson`);
  assert.equal(cleanReport.json.new_responses, 0);

  const student = studentClient();
  const submit = await student.post('/api/responses', {
    discipline_id: disciplineId,
    topic_id: topicId,
    form_type: 'lesson',
    scores: lessonScores,
    comments: { l_liked: 'Отзыв после просмотра раздела' },
  });
  assert.equal(submit.status, 201);

  const onceMore = await teacher.get('/api/teacher/disciplines');
  assert.equal(onceMore.json.new_responses_total, 1);

  const freshReport = await teacher.get(`/api/teacher/disciplines/${disciplineId}/report?form_type=lesson`);
  assert.equal(freshReport.json.new_responses, 1);
  assert.equal(freshReport.json.new_comments, 1);
  const items = freshReport.json.forms[0].comments.flatMap((group) => group.items);
  assert.ok(items.some((item) => item.is_new && item.body.includes('Отзыв после просмотра')), 'свежий отзыв помечен как новый');
  assert.ok(items.some((item) => item.is_new === false), 'старые отзывы не помечаются');

  const onlyNew = await teacher.get('/api/teacher/comments?only_new=1');
  assert.equal(onlyNew.status, 200);
  assert.ok(onlyNew.json.comments.length >= 1);
  assert.ok(onlyNew.json.comments.every((c) => c.is_new), 'фильтр только новые отдаёт исключительно новые');
});
