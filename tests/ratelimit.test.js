'use strict';

/**
 * Проверка ограничений: отдельный процесс и своя БД, значения снижены через
 * переменные окружения. Здесь же - пауза после неверных паролей.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bogusa-rl-'));
process.env.DATA_DIR = tempDir;
process.env.DB_FILE = path.join(tempDir, 'rl.sqlite');
process.env.JWT_SECRET = 'ratelimit-secret-ratelimit-secret-1234';
process.env.ADMIN_PASSWORD = 'Admin#2026pass';
process.env.ANTI_BOT_MIN_FILL_MS = '0';
process.env.RATE_LIMIT_SUBMIT = '3';
process.env.RATE_LIMIT_SUBMIT_WINDOW_MIN = '60';
process.env.LOGIN_MAX_ATTEMPTS = '2';
process.env.LOGIN_COOLDOWN_SECONDS = '2';
process.env.RATE_LIMIT_API = '100000';
process.env.NODE_ENV = 'test';

const createApp = require('../server/app');
const { db, run, nowIso } = require('../server/db');
const { getScaleQuestions } = require('../server/questions');

let studentServer;
let staffServer;
let studentUrl;
let staffUrl;

// Оценки по всем пунктам анкеты — состав берётся из определений вопросов.
const scores = {};
for (const q of getScaleQuestions('lesson')) scores[q.key] = 5;

test.before(async () => {
  const now = nowIso();
  // в тестовой базе ещё нет ни одного аккаунта - заводим администратора
  const { hashPassword } = require('../server/auth');
  run(
    `INSERT INTO users (login, password_hash, full_name, role, is_active, must_change_password, token_version, created_at, updated_at)
     VALUES ('admin', ?, 'Администратор', 'admin', 1, 0, 1, ?, ?)`,
    await hashPassword('Admin#2026pass'),
    now,
    now
  );
  run(
    `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
     VALUES ('Тестовая дисциплина', 'T-1', NULL, 1, ?, ?)`,
    now,
    now
  );
  run(
    `INSERT INTO topics (discipline_id, title, lesson_date, position, is_active, created_at)
     VALUES (1, 'Тема', '2026-10-01', 1, 1, ?)`,
    now
  );

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

const payload = () => ({
  discipline_id: 1,
  topic_id: 1,
  form_type: 'lesson',
  scores,
  comments: {},
});

test('после лимита отправок сервер отвечает 429', async () => {
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${studentUrl}/api/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    statuses.push(res.status);
    if (res.status === 429) {
      const body = await res.json();
      assert.ok(body.retryAfterSeconds > 0, 'клиенту сообщается время повтора');
    }
  }
  assert.deepEqual(statuses.slice(0, 3), [201, 201, 201]);
  assert.deepEqual(statuses.slice(3), [429, 429]);
});

/** Неверный пароль: фиксированная пауза, которая не растёт. */
const attempt = async (password) => {
  const res = await fetch(`${staffUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password }),
  });
  // счётчик ошибок сервер обновляет, когда ответ отправлен: даём этому мгновение
  await new Promise((resolve) => setTimeout(resolve, 60));
  return res;
};

test('после двух неверных паролей вход приостанавливается', async () => {
  assert.equal((await attempt('wrong-1')).status, 401);

  // Успешный вход обнуляет счётчик: накопленные ошибки не должны «переноситься».
  const good = await attempt('Admin#2026pass');
  assert.equal(good.status, 200);
  assert.ok(good.headers.getSetCookie().length > 0, 'кука сессии выдана');

  assert.equal((await attempt('wrong-2')).status, 401);
  assert.equal((await attempt('wrong-3')).status, 401, 'счётчик дошёл до лимита');

  const blocked = await attempt('Admin#2026pass');
  assert.equal(blocked.status, 429, 'на время паузы вход закрыт даже с верным паролем');
  const body = await blocked.json();
  assert.equal(body.code, 'LOGIN_COOLDOWN');
  assert.equal(body.retryAfterSeconds, 2, 'сервер называет длительность паузы');
  assert.match(body.error, /через 2 секунд/);
});

test('пауза не увеличивается при повторных попытках и сама заканчивается', async () => {
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await attempt('Admin#2026pass');
    assert.equal(res.status, 429);
    waits.push((await res.json()).retryAfterSeconds);
    assert.equal(res.headers.get('retry-after'), '2', 'заголовок Retry-After совпадает с телом');
  }
  assert.deepEqual(waits, [2, 2, 2, 2], 'длительность всегда одна и та же');

  await new Promise((resolve) => setTimeout(resolve, 2300));
  const after = await attempt('Admin#2026pass');
  assert.equal(after.status, 200, 'пауза закончилась - вход снова работает');
});
