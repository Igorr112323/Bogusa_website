'use strict';

/**
 * Агрегация анонимных ответов: средние баллы по пунктам, распределение оценок,
 * текстовые комментарии и динамика по датам.
 *
 * Все выборки — через параметризованные запросы; идентификаторы ответов берутся
 * из уже проверенного фильтра по ролям (преподаватель видит только свои дисциплины).
 */

const config = require('../config');
const { all, get } = require('../db');
const {
  FORMS,
  getScaleQuestions,
  getTextQuestions,
  getLegacyQuestions,
  isFormType,
} = require('../questions');

const MAX_RESPONSES_IN_AGGREGATE = 50000;
const MAX_COMMENTS = 1000;

/** Собирает WHERE по фильтру и список параметров (алиас таблицы responses — r). */
function buildFilter({ teacherId, disciplineId, topicId, formType, from, to } = {}) {
  const cond = [];
  const params = [];
  if (teacherId) {
    cond.push('r.teacher_id = ?');
    params.push(teacherId);
  }
  if (disciplineId) {
    cond.push('r.discipline_id = ?');
    params.push(disciplineId);
  }
  if (topicId) {
    cond.push('r.topic_id = ?');
    params.push(topicId);
  }
  if (formType) {
    cond.push('r.form_type = ?');
    params.push(formType);
  }
  if (from) {
    cond.push('r.created_date >= ?');
    params.push(from);
  }
  if (to) {
    cond.push('r.created_date <= ?');
    params.push(to);
  }
  return { where: cond.length > 0 ? cond.join(' AND ') : '1 = 1', params };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;
const emptyDist = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

function fetchResponses(filter, limit = MAX_RESPONSES_IN_AGGREGATE) {
  return all(
    `SELECT r.id, r.form_type, r.discipline_id, r.topic_id, r.teacher_id, r.overall_avg,
            r.created_date, r.created_at,
            d.title AS discipline_title, t.title AS topic_title, t.lesson_date AS lesson_date
       FROM responses r
       LEFT JOIN disciplines d ON d.id = r.discipline_id
       LEFT JOIN topics t ON t.id = r.topic_id
      WHERE ${filter.where}
      ORDER BY r.id DESC
      LIMIT ?`,
    ...filter.params,
    limit
  );
}

function fetchScores(responseIds) {
  const map = new Map();
  for (const ids of chunk(responseIds, 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = all(
      `SELECT response_id, question_key, score FROM answer_scores WHERE response_id IN (${placeholders})`,
      ...ids
    );
    for (const row of rows) {
      if (!map.has(row.response_id)) map.set(row.response_id, {});
      map.get(row.response_id)[row.question_key] = row.score;
    }
  }
  return map;
}

function fetchComments(responseIds) {
  const out = [];
  for (const ids of chunk(responseIds, 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = all(
      `SELECT c.response_id, c.question_key, c.body, c.created_date, c.id,
              r.form_type, r.created_at, d.title AS discipline_title, t.title AS topic_title,
              t.lesson_date AS lesson_date
         FROM answer_comments c
         JOIN responses r ON r.id = c.response_id
         LEFT JOIN disciplines d ON d.id = r.discipline_id
         LEFT JOIN topics t ON t.id = r.topic_id
        WHERE c.response_id IN (${placeholders})
        ORDER BY c.id DESC
        LIMIT ?`,
      ...ids,
      MAX_COMMENTS
    );
    out.push(...rows);
    if (out.length >= MAX_COMMENTS) break;
  }
  return out;
}

/**
 * Основная агрегация.
 * @param {object} filters teacherId/disciplineId/topicId/formType/from/to
 * @param {object} options { enforceMinimum, includeComments, since } - since включает поле is_new
 */
function aggregate(filters = {}, options = {}) {
  const { enforceMinimum = true, includeComments = true, since = null } = options;
  // since: строка-момент последнего просмотра ('' - просмотр ещё не отмечался)
  const filter = buildFilter(filters);
  const responses = fetchResponses(filter);

  const byForm = { lesson: 0, final: 0 };
  const distribution = emptyDist();
  let overallSum = 0;
  let overallCount = 0;
  // Строки приходят в порядке id, а дата ответа может быть любой (например, у
  // демонстрационных данных), поэтому границы периода считаем перебором.
  let firstResponseAt = null;
  let lastResponseAt = null;

  for (const r of responses) {
    if (typeof r.created_at === 'string') {
      if (firstResponseAt === null || r.created_at < firstResponseAt) firstResponseAt = r.created_at;
      if (lastResponseAt === null || r.created_at > lastResponseAt) lastResponseAt = r.created_at;
    }
    if (byForm[r.form_type] !== undefined) byForm[r.form_type] += 1;
    if (typeof r.overall_avg === 'number' && r.overall_avg > 0) {
      overallSum += r.overall_avg;
      overallCount += 1;
      const bucket = Math.min(5, Math.max(1, Math.round(r.overall_avg)));
      distribution[bucket] += 1;
    }
  }

  const minAnswers = Math.max(1, config.MIN_ANSWERS_TO_SHOW);
  const hidden = enforceMinimum && responses.length > 0 && responses.length < minAnswers;

  const result = {
    total_responses: responses.length,
    by_form: byForm,
    overall_avg: overallCount > 0 ? round2(overallSum / overallCount) : null,
    distribution,
    first_response_at: firstResponseAt,
    last_response_at: lastResponseAt,
    hidden,
    min_answers_required: minAnswers,
    forms: [],
    lessons: [],
    comments_count: 0,
  };

  if (responses.length === 0) return result;

  // Число комментариев считаем всегда — это дешёвый SQL-запрос, а не выгрузка текстов.
  if (!includeComments) {
    const row = get(
      `SELECT COUNT(*) AS n FROM answer_comments c
         JOIN responses r ON r.id = c.response_id
        WHERE ${filter.where}`,
      ...filter.params
    );
    result.comments_count = row ? row.n : 0;
  }

  // Ниже порога анонимности детали не отдаём вообще.
  if (hidden) return result;

  const scoreMap = fetchScores(responses.map((r) => r.id));
  const formTypes = [...new Set(responses.map((r) => r.form_type))].sort();

  for (const formType of formTypes) {
    if (!isFormType(formType)) continue;
    const form = FORMS[formType];
    const formResponses = responses.filter((r) => r.form_type === formType);
    const questions = getScaleQuestions(formType).map((q) => {
      const dist = emptyDist();
      let sum = 0;
      let count = 0;
      for (const r of formResponses) {
        const value = scoreMap.get(r.id)?.[q.key];
        if (typeof value === 'number') {
          dist[value] += 1;
          sum += value;
          count += 1;
        }
      }
      return {
        key: q.key,
        label: q.label,
        hint: q.hint || null,
        form_type: formType,
        count,
        avg: count > 0 ? round2(sum / count) : null,
        distribution: dist,
        positive_ratio: count > 0 ? Math.round(((dist[4] + dist[5]) / count) * 100) : null,
      };
    });

    const textQuestions = getTextQuestions(formType);
    const legacyQuestions = getLegacyQuestions(formType);
    const comments = textQuestions.map((q) => ({ key: q.key, label: q.label, items: [] }));
    // Ответы по пунктам, снятым с анкеты, остаются в базе — показываем их отдельно.
    const archived = legacyQuestions.map((q) => ({
      key: q.key,
      label: q.label,
      items: [],
      legacy: true,
    }));
    const commentsByKey = new Map([...comments, ...archived].map((c) => [c.key, c]));

    if (includeComments) {
      const formIds = new Set(formResponses.map((r) => r.id));
      for (const row of fetchComments(formResponses.map((r) => r.id))) {
        if (!formIds.has(row.response_id)) continue;
        const bucket = commentsByKey.get(row.question_key);
        if (!bucket) continue;
        bucket.items.push({
          id: row.id,
          body: row.body,
          created_date: row.created_date,
          // что пришло после последнего захода преподавателя в отчёт;
          // пустой since - преподаватель ещё не отмечал просмотр, тогда новые все
          is_new: since !== null && typeof row.created_at === 'string' && row.created_at > since,
          discipline_title: row.discipline_title,
          topic_title: row.topic_title,
          lesson_date: row.lesson_date,
        });
      }
      result.comments_count += comments.reduce((acc, c) => acc + c.items.length, 0);
      result.comments_count += archived.reduce((acc, c) => acc + c.items.length, 0);
    }

    const totals = questions.reduce(
      (acc, q) => {
        if (typeof q.avg === 'number') {
          acc.sum += q.avg;
          acc.count += 1;
        }
        return acc;
      },
      { sum: 0, count: 0 }
    );

    result.forms.push({
      form_type: formType,
      title: form.title,
      short_title: form.shortTitle,
      responses: formResponses.length,
      questions,
      comments: comments.filter((c) => c.items.length > 0),
      archived_comments: archived.filter((c) => c.items.length > 0),
      avg_of_items: totals.count > 0 ? round2(totals.sum / totals.count) : null,
    });
  }

  // Разбивка по занятиям (для урока: список тем с числом ответов)
  const lessonMap = new Map();
  for (const r of responses) {
    if (r.form_type !== 'lesson' || !r.topic_id) continue;
    if (!lessonMap.has(r.topic_id)) {
      lessonMap.set(r.topic_id, {
        topic_id: r.topic_id,
        topic_title: r.topic_title,
        discipline_id: r.discipline_id,
        discipline_title: r.discipline_title,
        lesson_date: r.lesson_date,
        responses: 0,
        overall_sum: 0,
        overall_count: 0,
        last_response_at: r.created_at,
      });
    }
    const entry = lessonMap.get(r.topic_id);
    entry.responses += 1;
    if (typeof r.overall_avg === 'number') {
      entry.overall_sum += r.overall_avg;
      entry.overall_count += 1;
    }
  }
  result.lessons = [...lessonMap.values()]
    .map((entry) => ({
      topic_id: entry.topic_id,
      topic_title: entry.topic_title,
      discipline_id: entry.discipline_id,
      discipline_title: entry.discipline_title,
      lesson_date: entry.lesson_date,
      responses: entry.responses,
      avg: entry.overall_count > 0 ? round2(entry.overall_sum / entry.overall_count) : null,
      last_response_at: entry.last_response_at,
    }))
    .sort((a, b) => b.responses - a.responses);

  return result;
}

/** Динамика: средний балл по датам (для графика). */
function timeline(filters = {}, { formType = null } = {}) {
  const filter = buildFilter({ ...filters, formType });
  const rows = all(
    `SELECT r.created_date AS date, COUNT(*) AS responses, AVG(r.overall_avg) AS avg
       FROM responses r
      WHERE ${filter.where} AND r.overall_avg IS NOT NULL
      GROUP BY r.created_date
      ORDER BY r.created_date ASC
      LIMIT 400`,
    ...filter.params
  );
  return rows.map((row) => ({
    date: row.date,
    responses: row.responses,
    avg: round2(row.avg || 0),
  }));
}

/** Плоская выгрузка для CSV (без персональных данных — их просто нет в БД). */
function exportRows(filters = {}) {
  const filter = buildFilter(filters);
  const responses = fetchResponses(filter);
  const scoreMap = fetchScores(responses.map((r) => r.id));
  const commentMap = new Map();
  for (const row of fetchComments(responses.map((r) => r.id))) {
    if (!commentMap.has(row.response_id)) commentMap.set(row.response_id, []);
    commentMap.get(row.response_id).push(row);
  }

  return responses.map((r) => {
    const scores = scoreMap.get(r.id) || {};
    const comments = (commentMap.get(r.id) || []).map((c) => ({
      key: c.question_key,
      body: c.body,
    }));
    return {
      id: r.id,
      form_type: r.form_type,
      discipline: r.discipline_title,
      topic: r.topic_title,
      created_date: r.created_date,
      created_at: r.created_at,
      overall_avg: r.overall_avg,
      scores,
      comments,
    };
  });
}

/** Статистика по дисциплинам: сколько анкет и средний балл по каждой. */
function disciplineStatsMap(filters = {}) {
  const filter = buildFilter(filters);
  const rows = all(
    `SELECT r.discipline_id AS discipline_id,
            COUNT(*) AS responses,
            SUM(CASE WHEN r.form_type = 'lesson' THEN 1 ELSE 0 END) AS lesson_count,
            SUM(CASE WHEN r.form_type = 'final' THEN 1 ELSE 0 END) AS final_count,
            AVG(r.overall_avg) AS avg,
            MAX(r.created_at) AS last_response_at
       FROM responses r
      WHERE ${filter.where} AND r.discipline_id IS NOT NULL
      GROUP BY r.discipline_id`,
    ...filter.params
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.discipline_id, {
      responses: row.responses,
      lesson_count: row.lesson_count,
      final_count: row.final_count,
      avg: row.avg === null ? null : round2(row.avg),
      last_response_at: row.last_response_at,
    });
  }
  return map;
}

/** Статистика по всем преподавателям (для админской таблицы). */
function teacherStatsMap(filters = {}) {
  const filter = buildFilter(filters);
  const rows = all(
    `SELECT r.teacher_id AS teacher_id,
            COUNT(*) AS responses,
            SUM(CASE WHEN r.form_type = 'lesson' THEN 1 ELSE 0 END) AS lesson_count,
            SUM(CASE WHEN r.form_type = 'final' THEN 1 ELSE 0 END) AS final_count,
            AVG(r.overall_avg) AS avg,
            MAX(r.created_at) AS last_response_at
       FROM responses r
      WHERE ${filter.where} AND r.teacher_id IS NOT NULL
      GROUP BY r.teacher_id`,
    ...filter.params
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.teacher_id, {
      responses: row.responses,
      lesson_count: row.lesson_count,
      final_count: row.final_count,
      avg: row.avg === null ? null : round2(row.avg),
      last_response_at: row.last_response_at,
    });
  }
  return map;
}

module.exports = {
  buildFilter,
  aggregate,
  timeline,
  exportRows,
  teacherStatsMap,
  disciplineStatsMap,
  round2,
};
