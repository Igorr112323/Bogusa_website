'use strict';

/** Проверки разграничения доступа: преподаватель — только свои дисциплины и темы. */

const { all, get } = require('../db');
const { forbidden, notFound } = require('../errors');

const isAdmin = (user) => !!user && user.role === 'admin';

function getDiscipline(id) {
  return get(
    `SELECT d.*, u.full_name AS teacher_name
       FROM disciplines d LEFT JOIN users u ON u.id = d.teacher_id
      WHERE d.id = ?`,
    id
  );
}

/** Админ — любую дисциплину, преподаватель — только свою. */
function assertDisciplineAccess(user, disciplineId) {
  const discipline = getDiscipline(disciplineId);
  if (!discipline) throw notFound('Дисциплина не найдена');
  if (isAdmin(user)) return discipline;
  if (!discipline.teacher_id || discipline.teacher_id !== user.id) {
    throw forbidden('Эта дисциплина не закреплена за Вами');
  }
  return discipline;
}

/** Тема: доступ определяется дисциплиной, к которой она относится. */
function assertTopicAccess(user, topicId) {
  const topic = get(
    `SELECT t.*, d.title AS discipline_title, d.teacher_id AS discipline_teacher_id
       FROM topics t JOIN disciplines d ON d.id = t.discipline_id
      WHERE t.id = ?`,
    topicId
  );
  if (!topic) throw notFound('Тема не найдена');
  if (isAdmin(user)) return topic;
  if (!topic.discipline_teacher_id || topic.discipline_teacher_id !== user.id) {
    throw forbidden('Эта тема не относится к Вашим дисциплинам');
  }
  return topic;
}

/** Дисциплины, доступные пользователю (для выпадающих списков в портале). */
function visibleDisciplines(user, { onlyActive = false } = {}) {
  if (isAdmin(user)) {
    return all(
      `SELECT d.*, u.full_name AS teacher_name,
              (SELECT COUNT(*) FROM topics t WHERE t.discipline_id = d.id) AS topics_count
         FROM disciplines d LEFT JOIN users u ON u.id = d.teacher_id
        ${onlyActive ? 'WHERE d.is_active = 1' : ''}
        ORDER BY d.title COLLATE NOCASE ASC`
    );
  }
  return all(
    `SELECT d.*, u.full_name AS teacher_name,
            (SELECT COUNT(*) FROM topics t WHERE t.discipline_id = d.id) AS topics_count
       FROM disciplines d LEFT JOIN users u ON u.id = d.teacher_id
      WHERE d.teacher_id = ? ${onlyActive ? 'AND d.is_active = 1' : ''}
      ORDER BY d.title COLLATE NOCASE ASC`,
    user.id
  );
}

/** Список id дисциплин, доступных пользователю (для быстрых проверок). */
function visibleDisciplineIds(user) {
  if (isAdmin(user)) {
    return all('SELECT id FROM disciplines').map((row) => row.id);
  }
  return all('SELECT id FROM disciplines WHERE teacher_id = ?', user.id).map((row) => row.id);
}

/**
 * Преобразует запрошенный фильтр в допустимый для роли.
 * Преподаватель не может запросить чужие дисциплины/темы — вместо этого 403.
 */
function resolveScope(user, { disciplineId = null, topicId = null } = {}) {
  if (topicId) {
    const topic = assertTopicAccess(user, topicId);
    return { disciplineId: topic.discipline_id, topicId };
  }
  if (disciplineId) {
    assertDisciplineAccess(user, disciplineId);
    return { disciplineId, topicId: null };
  }
  return { disciplineId: null, topicId: null };
}

module.exports = {
  isAdmin,
  getDiscipline,
  assertDisciplineAccess,
  assertTopicAccess,
  visibleDisciplines,
  visibleDisciplineIds,
  resolveScope,
};
