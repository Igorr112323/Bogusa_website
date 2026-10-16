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
const { sanitizeForStorage } = require('./sanitize');

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

/**
 * Демонстрационная структура: преподаватель, три дисциплины и темы занятий.
 * Нужна, чтобы после первого запуска можно было посмотреть отчёты и выгрузки.
 */
const DEMO_DISCIPLINES = [
  {
    title: 'Информатика',
    code: 'ИНФ-101',
    topics: [
      { title: 'Информация и информационные процессы', lesson_date: '2026-09-05' },
      { title: 'Системы счисления', lesson_date: '2026-09-12' },
      { title: 'Логические основы компьютера', lesson_date: '2026-09-19' },
      { title: 'Электронные таблицы и обработка данных', lesson_date: '2026-09-26' },
    ],
  },
  {
    title: 'Программирование',
    code: 'ПРОГ-102',
    topics: [
      { title: 'Введение. Переменные и типы данных', lesson_date: '2026-09-04' },
      { title: 'Условные операторы и циклы', lesson_date: '2026-09-11' },
      { title: 'Функции и области видимости', lesson_date: '2026-09-18' },
      { title: 'Массивы и строки', lesson_date: '2026-09-25' },
    ],
  },
  {
    title: 'Базы данных',
    code: 'БД-103',
    topics: [
      { title: 'Реляционная модель данных', lesson_date: '2026-09-03' },
      { title: 'Проектирование схемы базы данных', lesson_date: '2026-09-10' },
      { title: 'Запросы на языке SQL', lesson_date: '2026-09-17' },
    ],
  },
];

function seedDemoStructure() {
  const { get, run, nowIso } = getDb();
  const { generatePassword } = require('./auth');

  const result = { teacher: null, disciplines: [], discipline: null, topics: [] };

  let teacher = get("SELECT * FROM users WHERE login = 'ivanova'");
  if (!teacher) {
    // Пароль демо-преподавателя можно зафиксировать через DEMO_TEACHER_PASSWORD
    // (удобно для демонстрации); иначе генерируется случайный и требуется
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

  for (const item of DEMO_DISCIPLINES) {
    const title = sanitizeForStorage(item.title);
    let discipline = get('SELECT * FROM disciplines WHERE title = ?', title);
    if (!discipline) {
      const now = nowIso();
      run(
        `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        title,
        sanitizeForStorage(item.code),
        teacher.id,
        now,
        now
      );
      discipline = get('SELECT * FROM disciplines WHERE title = ?', title);
    }

    const topicIds = [];
    for (const [index, topic] of item.topics.entries()) {
      const stored = sanitizeForStorage(topic.title);
      const exists = get('SELECT id FROM topics WHERE discipline_id = ? AND title = ?', discipline.id, stored);
      if (exists) {
        topicIds.push(exists.id);
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
      topicIds.push(inserted.lastInsertRowid);
    }

    result.disciplines.push({ discipline, topics: topicIds });
  }

  // Совместимость с прежним вариантом: первая дисциплина и её темы.
  result.discipline = result.disciplines[0].discipline;
  result.topics = result.disciplines[0].topics;

  return result;
}

/** Примеры открытых ответов — по ключам вопросов из server/questions.js. */
const DEMO_COMMENTS = {
  l_liked: [
    'Понятные примеры по теме, материал усваивался легко.',
    'Занятие шло динамично, внимание не терялось.',
    'Полезен разбор заданий в конце занятия.',
    'Наглядные схемы и презентация помогли понять тему.',
  ],
  l_improve: [
    'Стоит добавить больше практических заданий.',
    'Теоретическую часть можно сократить.',
    'Не хватало времени на вопросы по теме.',
    'Материалы лучше выкладывать заранее.',
  ],
  f_strengths: [
    'Умение объяснять сложные вещи простым языком.',
    'Подробный разбор ошибок и рекомендации по работам.',
    'Примеры из профессиональной практики на каждой теме.',
    'Внимательное отношение к вопросам студентов.',
  ],
  f_improve: [
    'Распределить задания по семестру равномернее.',
    'Добавить записи лекций в материалы курса.',
    'Больше практических заданий перед экзаменом.',
    'Чаще проводить короткие проверки по пройденным темам.',
  ],
  f_memorable: [
    'Практическое задание по проектированию схемы базы данных.',
    'Дискуссия о применении материала в реальной работе.',
    'Разбор итоговой задачи на последнем занятии.',
    'Пример с обработкой данных из открытого источника.',
  ],
};

const FALLBACK_COMMENTS = [
  'Замечаний нет, всё устроило.',
  'Материал подан понятно, вопросов не осталось.',
];

/** Ключи пунктов берутся из определений анкет — сидер не расходится с формой. */
const { getScaleQuestions, getTextQuestions } = require('./questions');

const SCALE_KEYS = {
  lesson: getScaleQuestions('lesson').map((q) => q.key),
  final: getScaleQuestions('final').map((q) => q.key),
};

const TEXT_KEYS = {
  lesson: getTextQuestions('lesson').map((q) => q.key),
  final: getTextQuestions('final').map((q) => q.key),
};

/**
 * Демонстрационные ответы: заполняют все демо-дисциплины и темы, чтобы отчёты,
 * графики и выгрузка CSV были наполнены сразу после первого запуска.
 *
 * @param {{count?: number}} options общее число анкет
 */
function seedDemoResponses({ count = 48 } = {}) {
  const { db, get, run, all } = getDb();
  const structure = seedDemoStructure();
  const disciplineIds = structure.disciplines.map((d) => d.discipline.id);

  const placeholders = disciplineIds.map(() => '?').join(', ');
  const existing = get(
    `SELECT COUNT(*) AS n FROM responses WHERE discipline_id IN (${placeholders})`,
    ...disciplineIds
  ).n;
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
  const commentFor = (key) => pick(DEMO_COMMENTS[key] || FALLBACK_COMMENTS);

  const created = db.transaction(() => {
    let made = 0;
    for (let i = 0; i < count; i += 1) {
      const entry = structure.disciplines[i % structure.disciplines.length];
      const discipline = entry.discipline;
      const topics = all('SELECT * FROM topics WHERE discipline_id = ?', discipline.id);

      // Каждая четвёртая анкета — итоговая, остальные по конкретным занятиям.
      const isFinal = i % 4 === 3;
      const formType = isFinal ? 'final' : 'lesson';
      const topic = isFinal || topics.length === 0 ? null : topics[i % topics.length];
      const daysAgo = Math.floor(Math.random() * 55) + 1;
      const stamp = isoDaysAgo(daysAgo);

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

      // Открытый ответ примерно в каждой второй анкете
      if (Math.random() < 0.55) {
        const key = pick(TEXT_KEYS[formType]);
        run(
          `INSERT INTO answer_comments (response_id, question_key, body, created_date)
           VALUES (?, ?, ?, ?)`,
          response.lastInsertRowid,
          key,
          sanitizeForStorage(commentFor(key), { maxLength: 2000 }),
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
  const plural = (n, one, few, many) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  };
  const list = structure.disciplines
    .map((d) => `«${d.discipline.title}» — ${d.topics.length} ${plural(d.topics.length, 'тема', 'темы', 'тем')}`)
    .join('; ');
  console.log(`[seed] Дисциплины и темы: ${list}`);
  console.log(`[seed] Демо-преподаватель: ${structure.teacher ? structure.teacher.login : 'ivanova (уже был)'}`);
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
