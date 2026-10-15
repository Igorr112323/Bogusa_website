'use strict';

/**
 * Инициализация данных.
 *
 *   node server/seed.js            — создать администратора + демо-структуру (преподаватель, дисциплина, темы)
 *   node server/seed.js --demo     — дополнительно загрузить демонстрационные анонимные ответы
 *   node server/seed.js --force    — предварительно удалить файл БД (полный сброс!)
 *
 * Пароль администратора: берётся из ADMIN_PASSWORD, иначе генерируется и печатается один раз.
 */

const config = require('./config');
const { hashPasswordSync } = require('./passwordHash');

function getDb() {
  // Ленивое подключение: при --force файл БД нужно удалить до открытия соединения.
  return require('./db');
}

function removeDatabaseFiles() {
  const fs = require('fs');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(`${config.DB_FILE}${suffix}`);
    } catch {
      /* файла нет — это нормально */
    }
  }
}

/** Гарантирует наличие активного администратора. Возвращает данные, если аккаунт создан. */
function ensureAdminAccount() {
  const { get, run, nowIso } = getDb();
  const existing = get("SELECT id, login FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return null;

  const { generatePassword } = require('./auth');
  const login = config.ADMIN_LOGIN || 'admin';
  const generated = !config.ADMIN_PASSWORD;
  const password = config.ADMIN_PASSWORD || generatePassword();
  const hash = hashPasswordSync(password);
  const now = nowIso();

  run(
    `INSERT INTO users (login, password_hash, full_name, role, is_active, must_change_password, token_version, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 1, ?, 1, ?, ?)`,
    login,
    hash,
    config.ADMIN_NAME || 'Администратор',
    generated ? 1 : 0,
    now,
    now
  );

  return { created: true, login, password, generated };
}

function seedDemoStructure() {
  const { get, run, nowIso } = getDb();
  const { generatePassword } = require('./auth');
  const { sanitizeForStorage } = require('./sanitize');

  const result = { teacher: null, discipline: null, topics: [] };

  let teacher = get("SELECT * FROM users WHERE login = 'ivanova'");
  if (!teacher) {
    // Пароль демо-преподавателя можно зафиксировать через DEMO_TEACHER_PASSWORD
    // (удобно для демонстрации); иначе генерируется случайный и требуются
    // обязательная смена при первом входе.
    const fixed = (process.env.DEMO_TEACHER_PASSWORD || '').trim();
    const password = fixed || generatePassword();
    run(
      `INSERT INTO users (login, password_hash, full_name, role, is_active, must_change_password, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher', 1, ?, 1, ?, ?)`,
      'ivanova',
      hashPasswordSync(password),
      sanitizeForStorage('Иванова Мария Петровна'),
      fixed ? 0 : 1,
      nowIso(),
      nowIso()
    );
    teacher = get("SELECT * FROM users WHERE login = 'ivanova'");
    result.teacher = { login: 'ivanova', password };
  }

  let discipline = get('SELECT * FROM disciplines WHERE title = ?', sanitizeForStorage('Основы программирования'));
  if (!discipline) {
    const now = nowIso();
    run(
      `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      sanitizeForStorage('Основы программирования'),
      sanitizeForStorage('ПРОГ-101'),
      teacher.id,
      now,
      now
    );
    discipline = get('SELECT * FROM disciplines WHERE title = ?', sanitizeForStorage('Основы программирования'));
  }
  result.discipline = discipline;

  const demoTopics = [
    { title: 'Введение. Переменные и типы данных', lesson_date: '2026-09-05' },
    { title: 'Условные операторы и циклы', lesson_date: '2026-09-12' },
    { title: 'Функции и области видимости', lesson_date: '2026-09-19' },
    { title: 'Массивы и строки', lesson_date: '2026-09-26' },
  ];

  for (const [index, topic] of demoTopics.entries()) {
    const stored = sanitizeForStorage(topic.title);
    const exists = get('SELECT id FROM topics WHERE discipline_id = ? AND title = ?', discipline.id, stored);
    if (exists) {
      result.topics.push(exists.id);
      continue;
    }
    const inserted = run(
      `INSERT INTO topics (discipline_id, title, lesson_date, position, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      discipline.id,
      stored,
      topic.lesson_date,
      index + 1,
      nowIso()
    );
    result.topics.push(inserted.lastInsertRowid);
  }

  return result;
}

const DEMO_COMMENTS = {
  lesson: [
    'Очень помог разбор задачи у доски, стало понятнее.',
    'Хотелось бы больше примеров с реальными проектами.',
    'Темп немного быстрый во второй половине занятия.',
    'Спасибо за доброжелательную атмосферу, вопросы задавать не страшно.',
    'Полезно, что в конце был краткий итог по теме.',
  ],
  final: [
    'Курс дал хорошую базу, пригодилось на другом предмете.',
    'Заданий много в конце семестра, лучше распределить по времени.',
    'Материалы в LMS удобные, но не хватало записей лекций.',
    'Преподаватель всегда подробно отвечал на вопросы.',
    'Хотелось бы больше практических кейсов вместо теории.',
  ],
};

const TEXT_KEYS = {
  lesson: ['l_liked', 'l_improve', 'l_wishes'],
  final: ['f_useful', 'f_difficult', 'f_improve', 'f_wishes'],
};

const SCALE_KEYS = {
  lesson: ['l_goals', 'l_logic', 'l_visual', 'l_atmosphere', 'l_pace', 'l_org'],
  final: [
    'f_theory_practice',
    'f_depth',
    'f_materials',
    'f_workload',
    'f_style',
    'f_fairness',
    'f_feedback',
    'f_overall',
    'f_recommend',
  ],
};

/** Демонстрационные ответы (чтобы портал не был пустым при первом знакомстве). */
function seedDemoResponses({ count = 18 } = {}) {
  const { db, get, run, all, today } = getDb();
  const structure = seedDemoStructure();
  const discipline = get('SELECT * FROM disciplines WHERE id = ?', structure.discipline.id);
  const topics = all('SELECT * FROM topics WHERE discipline_id = ?', discipline.id);

  const existing = get('SELECT COUNT(*) AS n FROM responses WHERE discipline_id = ?', discipline.id).n;
  if (existing > 0) return { created: 0, skipped: existing };

  const randomScore = () => {
    const roll = Math.random();
    if (roll < 0.5) return 5;
    if (roll < 0.85) return 4;
    if (roll < 0.96) return 3;
    return 2;
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const isoDaysAgo = (days) => {
    const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return { date: date.toISOString().slice(0, 10), iso: date.toISOString() };
  };

  const created = db.transaction(() => {
    let made = 0;
    for (let i = 0; i < count; i += 1) {
      const isFinal = i % 3 === 0;
      const formType = isFinal ? 'final' : 'lesson';
      const topic = isFinal ? null : pick(topics);
      const daysAgo = Math.floor(Math.random() * 55) + 1;
      const stamp = isoDaysAgo(daysAgo);
      const { sanitizeForStorage } = require('./sanitize');

      const scores = SCALE_KEYS[formType].map((key) => ({ key, score: randomScore() }));
      const avg = Math.round((scores.reduce((a, s) => a + s.score, 0) / scores.length) * 100) / 100;

      const response = run(
        `INSERT INTO responses (discipline_id, topic_id, teacher_id, form_type, overall_avg, created_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        discipline.id,
        topic ? topic.id : null,
        discipline.teacher_id,
        formType,
        avg,
        stamp.date,
        stamp.iso
      );

      for (const item of scores) {
        run(
          'INSERT INTO answer_scores (response_id, question_key, score) VALUES (?, ?, ?)',
          response.lastInsertRowid,
          item.key,
          item.score
        );
      }

      // В среднем каждое второе сообщение содержит текст
      if (Math.random() < 0.55) {
        const key = pick(TEXT_KEYS[formType]);
        run(
          `INSERT INTO answer_comments (response_id, question_key, body, created_date)
           VALUES (?, ?, ?, ?)`,
          response.lastInsertRowid,
          key,
          sanitizeForStorage(pick(DEMO_COMMENTS[formType]), { maxLength: 2000 }),
          stamp.date
        );
      }
      made += 1;
    }
    return made;
  });

  return { created, skipped: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--force')) {
    removeDatabaseFiles();
    console.log('[seed] Файл БД удалён (--force), создаём заново.');
  }

  getDb(); // применяет схему

  const admin = ensureAdminAccount();
  if (admin) {
    console.log(`[seed] Администратор создан: логин «${admin.login}»`);
    console.log(`[seed] Пароль администратора: ${admin.password}`);
    if (admin.generated) console.log('[seed] Пароль сгенерирован — смените его после первого входа.');
  } else {
    console.log('[seed] Администратор уже существует — пропускаем.');
  }

  const structure = seedDemoStructure();
  console.log(
    `[seed] Демо-структура: преподаватель ${structure.teacher ? structure.teacher.login : 'уже был'}, ` +
      `дисциплина «${structure.discipline.title}», тем: ${structure.topics.length}`
  );
  if (structure.teacher) {
    console.log(`[seed] Пароль демо-преподавателя ivanova: ${structure.teacher.password}`);
  }

  if (args.includes('--demo')) {
    const demo = seedDemoResponses();
    if (demo.created > 0) {
      console.log(`[seed] Добавлено демонстрационных анкет: ${demo.created}`);
    } else {
      console.log(`[seed] Демонстрационные анкеты не добавлялись (уже есть: ${demo.skipped}).`);
    }
  } else {
    console.log('[seed] Подсказка: добавьте --demo, чтобы загрузить примеры анонимных ответов.');
  }

  console.log('[seed] Готово.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed] Ошибка:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { ensureAdminAccount, seedDemoStructure, seedDemoResponses, removeDatabaseFiles };
