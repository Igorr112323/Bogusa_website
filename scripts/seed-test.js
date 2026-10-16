'use strict';

/**
 * Тестовый преподаватель с пятью дисциплинами и темами.
 *
 * Запуск:  npm run seed:test
 *   - создаёт пользователя `test` (логин) со сгенерированным паролем
 *     (или фиксированным, если задан TEST_TEACHER_PASSWORD в .env)
 *   - добавляет 5 дисциплин, по 4 темы в каждой (всего 20 тем)
 *   - если такой логин уже есть — добавляет только недостающее
 *   - идемпотентен: повторный запуск не дублирует дисциплины/темы
 *
 * Этот скрипт нужен, чтобы быстро подготовить наполненный кабинет препода
 * для проверки отчётов и выгрузок. Команда `npm test` его не запускает.
 */

const path = require('path');

// Подключаем ядро приложения. config грузится первым — он прочитает .env
// и применит схему БД при первом обращении к модулю db.
const config = require('../server/config');
const { all, get, run, nowIso } = require('../server/db');
const { hashPasswordSync, generatePassword } = require('../server/auth');
const { sanitizeForStorage } = require('../server/sanitize');

const TEACHER_LOGIN = 'test';
const TEACHER_NAME = 'Преподаватель Тестовый';

const DISCIPLINES = [
  {
    title: 'Математический анализ',
    code: 'МА-201',
    topics: [
      'Предел и непрерывность функции',
      'Дифференцирование и производная',
      'Интеграл Римана и его приложения',
      'Числовые и функциональные ряды',
    ],
  },
  {
    title: 'Линейная алгебра',
    code: 'ЛА-202',
    topics: [
      'Матрицы и определители',
      'Системы линейных уравнений',
      'Векторные пространства и базисы',
      'Линейные операторы и собственные значения',
    ],
  },
  {
    title: 'Теория вероятностей',
    code: 'ТВ-203',
    topics: [
      'Случайные события и вероятность',
      'Дискретные и непрерывные случайные величины',
      'Числовые характеристики распределений',
      'Предельные теоремы и закон больших чисел',
    ],
  },
  {
    title: 'Физика',
    code: 'ФИЗ-204',
    topics: [
      'Кинематика материальной точки',
      'Законы Ньютона и силы в природе',
      'Законы сохранения энергии и импульса',
      'Электростатика и постоянный ток',
    ],
  },
  {
    title: 'Английский язык',
    code: 'АНГ-205',
    topics: [
      'Академическое чтение и словарь',
      'Грамматика: времена и модальные глаголы',
      'Письмо: эссе и деловая переписка',
      'Аудирование и устная практика',
    ],
  },
];

function makeDates(start, count) {
  const out = [];
  const base = new Date(start);
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function main() {
  const existing = all('SELECT id, full_name FROM users WHERE login = ?', TEACHER_LOGIN);
  let teacherId;
  let password = null;

  if (existing.length === 0) {
    const fixed = (process.env.TEST_TEACHER_PASSWORD || '').trim();
    password = fixed || generatePassword();
    const now = nowIso();
    run(
      `INSERT INTO users (login, password_hash, full_name, role, is_active, must_change_password, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher', 1, ?, 1, ?, ?)`,
      TEACHER_LOGIN,
      hashPasswordSync(password),
      sanitizeForStorage(TEACHER_NAME),
      fixed ? 0 : 1,
      now,
      now
    );
    const row = all('SELECT id FROM users WHERE login = ?', TEACHER_LOGIN)[0];
    teacherId = row.id;
    console.log(`[seed:test] Создан преподаватель: логин «${TEACHER_LOGIN}»`);
    console.log(`[seed:test] Пароль преподавателя: ${password}`);
  } else {
    teacherId = existing[0].id;
    console.log(`[seed:test] Преподаватель «${TEACHER_LOGIN}» уже существует (id=${teacherId}) — пропускаем.`);
  }

  const today = new Date();
  const dates = makeDates(today, 4);

  let createdDisciplines = 0;
  let createdTopics = 0;

  for (const item of DISCIPLINES) {
    const title = sanitizeForStorage(item.title);
    let discipline = get('SELECT id FROM disciplines WHERE title = ? AND teacher_id = ?', title, teacherId);
    if (!discipline) {
      const now = nowIso();
      run(
        `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        title,
        sanitizeForStorage(item.code),
        teacherId,
        now,
        now
      );
      discipline = get('SELECT id FROM disciplines WHERE title = ? AND teacher_id = ?', title, teacherId);
      createdDisciplines += 1;
    }
    const disciplineId = discipline.id;

    for (const [index, topicTitle] of item.topics.entries()) {
      const stored = sanitizeForStorage(topicTitle);
      const exists = get(
        'SELECT id FROM topics WHERE discipline_id = ? AND title = ?',
        disciplineId,
        stored
      );
      if (exists) continue;
      run(
        `INSERT INTO topics (discipline_id, title, lesson_date, position, is_active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        disciplineId,
        stored,
        dates[index],
        index + 1,
        nowIso()
      );
      createdTopics += 1;
    }
  }

  console.log(`[seed:test] Дисциплин: ${DISCIPLINES.length} (новых: ${createdDisciplines}); тем: ${DISCIPLINES.length * 4} (новых: ${createdTopics}).`);
  console.log('[seed:test] Готово. Вход: http://localhost:3001/login — логин «test», пароль см. выше.');
}

try {
  main();
} catch (err) {
  console.error('[seed:test] Ошибка:', err.message);
  process.exitCode = 1;
}
