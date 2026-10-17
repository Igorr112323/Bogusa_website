'use strict';

/** Публичный каталог: что видят студенты без авторизации. */

const config = require('../config');
const { all, get } = require('../db');
const { sanitizeText } = require('../sanitize');

function teacherNameFor(teacherId) {
  if (!config.SHOW_TEACHER_NAME || !teacherId) return null;
  const teacher = get('SELECT full_name FROM users WHERE id = ?', teacherId);
  return teacher ? teacher.full_name : null;
}

/** Дисциплины с активными темами. Никаких оценок и отзывов здесь нет. */
function listPublicDisciplines({ search = '' } = {}) {
  const term = sanitizeText(search, { maxLength: 80, keepNewlines: false });
  const params = [];
  let sql = `SELECT d.id, d.title, d.code, d.teacher_id,
                    (SELECT COUNT(*) FROM topics t WHERE t.discipline_id = d.id AND t.is_active = 1) AS topics_count
               FROM disciplines d
              WHERE d.is_active = 1 AND EXISTS (
                    SELECT 1 FROM topics t WHERE t.discipline_id = d.id AND t.is_active = 1)`;
  if (term) {
    sql += ` AND (d.title LIKE ? ESCAPE '\\' OR IFNULL(d.code, '') LIKE ? ESCAPE '\\')`;
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }
  sql += ' ORDER BY d.title COLLATE NOCASE ASC';

  return all(sql, ...params).map((row) => ({
    id: row.id,
    title: row.title,
    code: row.code,
    topics_count: row.topics_count,
    teacher_name: teacherNameFor(row.teacher_id),
  }));
}

/** Дисциплина + её активные темы (для шага выбора темы). */
function getPublicDiscipline(disciplineId) {
  const discipline = get(
    'SELECT id, title, code, teacher_id FROM disciplines WHERE id = ? AND is_active = 1',
    disciplineId
  );
  if (!discipline) return null;

  const topics = all(
    `SELECT id, title, lesson_date FROM topics
      WHERE discipline_id = ? AND is_active = 1
      ORDER BY (lesson_date IS NULL) ASC, lesson_date DESC, position ASC, id ASC`,
    disciplineId
  );

  return {
    id: discipline.id,
    title: discipline.title,
    code: discipline.code,
    teacher_name: teacherNameFor(discipline.teacher_id),
    topics: topics.map((t) => ({ id: t.id, title: t.title, lesson_date: t.lesson_date })),
  };
}

module.exports = { listPublicDisciplines, getPublicDiscipline, teacherNameFor };
