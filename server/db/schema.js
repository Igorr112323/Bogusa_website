'use strict';

/**
 * Схема БД.
 *
 * ВАЖНО ПРО АНОНИМНОСТЬ: ни в одной таблице нет и не должно быть персональных
 * данных студентов (ФИО, группа, e-mail, IP, cookie-идентификатор). Таблица
 * responses хранит только дисциплину/тему/тип анкеты и время отправки,
 * а ответы — отдельными стобцами-оценками и текстами.
 */

module.exports = `
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  login                TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  full_name            TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher', 'admin')),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  token_version        INTEGER NOT NULL DEFAULT 1,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS disciplines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  code       TEXT,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  lesson_date   TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);

-- Одна отправленная анкета. Никаких идентификаторов студента.
CREATE TABLE IF NOT EXISTS responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
  topic_id      INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  teacher_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  form_type     TEXT    NOT NULL CHECK (form_type IN ('lesson', 'final')),
  overall_avg   REAL,
  created_date  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

-- Оценки по пунктам шкалы (1..5). Первичный ключ исключает дубли пункта в одной анкете.
CREATE TABLE IF NOT EXISTS answer_scores (
  response_id  INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_key TEXT    NOT NULL,
  score        INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
  PRIMARY KEY (response_id, question_key)
);

-- Открытые ответы (замечания, пожелания).
CREATE TABLE IF NOT EXISTS answer_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id  INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_key TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  created_date TEXT    NOT NULL
);

-- Журнал действий администратора и преподавателей (для аудита безопасности).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_login TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   INTEGER,
  details     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_responses_teacher    ON responses (teacher_id, form_type);
CREATE INDEX IF NOT EXISTS idx_responses_discipline ON responses (discipline_id, form_type);
CREATE INDEX IF NOT EXISTS idx_responses_topic      ON responses (topic_id);
CREATE INDEX IF NOT EXISTS idx_responses_date       ON responses (created_date);
CREATE INDEX IF NOT EXISTS idx_scores_response      ON answer_scores (response_id);
CREATE INDEX IF NOT EXISTS idx_comments_response    ON answer_comments (response_id);
CREATE INDEX IF NOT EXISTS idx_topics_discipline    ON topics (discipline_id);
CREATE INDEX IF NOT EXISTS idx_disciplines_teacher  ON disciplines (teacher_id);
CREATE INDEX IF NOT EXISTS idx_audit_created        ON audit_log (created_at);
`;
