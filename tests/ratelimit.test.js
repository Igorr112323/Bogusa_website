'use strict';

/**
 * Проверка ограничений частоты: отдельный процесс и своя БД, лимиты снижены
 * через переменные окружения.
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
process.env.RATE_LIMIT_LOGIN = '3';
process.env.RATE_LIMIT_LOGIN_WINDOW_MIN = '15';
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

test('перебор паролей также ограничен', async () => {
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${staffUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: `wrong-${i}` }),
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429]);
});
