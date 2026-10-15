'use strict';

/**
 * Сохранение анкет студентов.
 *
 * АНОНИМНОСТЬ: функция не принимает и не сохраняет ничего, что могло бы
 * идентифицировать студента. IP-адрес используется только счётчиком rate-limit
 * в памяти и в БД не попадает. В таблице responses нет полей user/student/group.
 */

const { db, run, get, nowIso, today } = require('../db');
const { badRequest, notFound } = require('../errors');
const { getScaleQuestions } = require('../questions');

function disciplineIsAvailable(disciplineId) {
  return get('SELECT * FROM disciplines WHERE id = ? AND is_active = 1', disciplineId);
}

function topicIsAvailable(topicId, disciplineId) {
  return get(
    'SELECT * FROM topics WHERE id = ? AND discipline_id = ? AND is_active = 1',
    topicId,
    disciplineId
  );
}

/**
 * @param {object} params
 * @param {number} params.disciplineId
 * @param {number|null} params.topicId
 * @param {'lesson'|'final'} params.formType
 * @param {Array<{key:string, score:number}>} params.scores
 * @param {Array<{key:string, body:string}>} params.comments — уже очищенные и экранированные
 */
function createResponse({ disciplineId, topicId, formType, scores, comments }) {
  const discipline = disciplineIsAvailable(disciplineId);
  if (!discipline) throw notFound('Дисциплина не найдена или отключена');

  let topic = null;
  if (formType === 'lesson') {
    if (!topicId) throw badRequest('Выберите тему занятия');
    topic = topicIsAvailable(topicId, disciplineId);
    if (!topic) throw notFound('Тема не найдена для выбранной дисциплины');
  } else if (topicId) {
    // для итоговой анкеты тема не нужна
    topicId = null;
  }

  // Проверяем, что набор пунктов соответствует типу анкеты
  const expected = new Set(getScaleQuestions(formType).map((q) => q.key));
  for (const item of scores) {
    if (!expected.has(item.key)) {
      throw badRequest(`Пункт «${item.key}» не относится к этому типу анкеты`);
    }
  }

  const overallAvg =
    scores.length > 0
      ? Math.round((scores.reduce((acc, s) => acc + s.score, 0) / scores.length) * 100) / 100
      : null;

  const now = nowIso();
  const date = today();

  const id = db.transaction(() => {
    const inserted = run(
      `INSERT INTO responses (discipline_id, topic_id, teacher_id, form_type, overall_avg, created_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      disciplineId,
      topicId,
      discipline.teacher_id || null,
      formType,
      overallAvg,
      date,
      now
    );
    const responseId = inserted.lastInsertRowid;

    for (const item of scores) {
      run(
        `INSERT INTO answer_scores (response_id, question_key, score) VALUES (?, ?, ?)`,
        responseId,
        item.key,
        item.score
      );
    }
    for (const item of comments) {
      run(
        `INSERT INTO answer_comments (response_id, question_key, body, created_date)
         VALUES (?, ?, ?, ?)`,
        responseId,
        item.key,
        item.body,
        date
      );
    }
    return responseId;
  });

  return {
    id,
    form_type: formType,
    discipline: { id: discipline.id, title: discipline.title },
    topic: topic ? { id: topic.id, title: topic.title } : null,
    overall_avg: overallAvg,
  };
}

module.exports = { createResponse };
