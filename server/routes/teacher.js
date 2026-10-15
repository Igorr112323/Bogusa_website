'use strict';

/**
 * Маршруты преподавателя. Любой запрос проходит проверку «моя ли это дисциплина».
 * Администратору доступны те же маршруты (он видит всё) — через ?teacher_id=.
 */

const express = require('express');

const { ApiError } = require('../errors');
const { parseId, parseDate, parseFormType, parseBool } = require('../validate');
const { sanitizeText } = require('../sanitize');
const { visibleDisciplines, resolveScope, isAdmin, getDiscipline } = require('../services/access');
const {
  aggregate,
  timeline,
  exportRows,
  teacherStatsMap,
  buildFilter,
} = require('../services/analytics');
const { all, get } = require('../db');
const { toCsv } = require('../csv');
const { questionLabels } = require('../questions');
const { MIN_ANSWERS_LABEL } = require('../constants');

const router = express.Router();

/** Общие параметры фильтра из query. */
function parseFilters(req, base = {}) {
  const formType = req.query.form_type ? parseFormType(req.query.form_type) : null;
  const from = parseDate(req.query.from, { fieldName: 'Дата «с»' });
  const to = parseDate(req.query.to, { fieldName: 'Дата «по»' });
  return { ...base, formType, from, to };
}

/** Сводка для портала: сколько ответов, средние баллы, последние активности. */
router.get('/overview', (req, res, next) => {
  try {
    const user = req.user;
    let teacherId = user.id;

    if (isAdmin(user) && req.query.teacher_id) {
      teacherId = parseId(req.query.teacher_id, 'идентификатор преподавателя');
    }

    const scope = isAdmin(user) && !req.query.teacher_id ? {} : { teacherId };

    const totals = aggregate(parseFilters(req, scope), { includeComments: false });
    const disciplines = isAdmin(user) && !req.query.teacher_id
      ? visibleDisciplines(user)
      : visibleDisciplines(user);

    const stats = teacherStatsMap();

    const enriched = disciplines.map((d) => {
      const row = stats.get(d.teacher_id) || null;
      return {
        id: d.id,
        title: d.title,
        code: d.code,
        is_active: !!d.is_active,
        teacher_id: d.teacher_id,
        teacher_name: d.teacher_name || null,
        topics_count: d.topics_count,
        responses: row ? row.responses : 0,
        avg: row ? row.avg : null,
      };
    });

    const available = isAdmin(user) ? [] : all(
      `SELECT t.id, t.title, t.lesson_date, t.discipline_id, d.title AS discipline_title
         FROM topics t JOIN disciplines d ON d.id = t.discipline_id
        WHERE d.teacher_id = ?
        ORDER BY (t.lesson_date IS NULL) ASC, t.lesson_date DESC, t.id DESC
        LIMIT 200`,
      user.id
    );

    res.json({
      scope: isAdmin(user) && !req.query.teacher_id ? 'all' : 'teacher',
      totals: {
        responses: totals.total_responses,
        lesson: totals.by_form.lesson,
        final: totals.by_form.final,
        overall_avg: totals.overall_avg,
        comments: totals.comments_count,
        first_response_at: totals.first_response_at,
        last_response_at: totals.last_response_at,
      },
      distribution: totals.distribution,
      hidden: totals.hidden,
      min_answers_required: totals.min_answers_required,
      min_answers_label: MIN_ANSWERS_LABEL,
      disciplines: enriched,
      topics: available,
      timeline: timeline(parseFilters(req, scope), { formType: null }),
    });
  } catch (err) {
    next(err);
  }
});

/** Список доступных дисциплин с темами (для выпадающих списков в портале). */
router.get('/disciplines', (req, res) => {
  const disciplines = visibleDisciplines(req.user).map((d) => ({
    id: d.id,
    title: d.title,
    code: d.code,
    is_active: !!d.is_active,
    teacher_id: d.teacher_id,
    teacher_name: d.teacher_name || null,
    topics_count: d.topics_count,
    topics: all(
      `SELECT id, title, lesson_date, is_active FROM topics
        WHERE discipline_id = ?
        ORDER BY (lesson_date IS NULL) ASC, lesson_date DESC, position ASC, id ASC`,
      d.id
    ),
  }));
  res.json({ disciplines });
});

/** Отчёт по дисциплине: средние по пунктам + комментарии. */
router.get('/disciplines/:id/report', (req, res, next) => {
  try {
    const disciplineId = parseId(req.params.id, 'идентификатор дисциплины');
    resolveScope(req.user, { disciplineId });
    const filters = parseFilters(req, { disciplineId });
    const report = aggregate(filters, { enforceMinimum: !isAdmin(req.user) });
    report.timeline = timeline(filters, { formType: filters.formType });
    report.discipline = getDiscipline(disciplineId);
    if (!report.discipline) throw new ApiError(404, 'Дисциплина не найдена');
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/** Отчёт по конкретному занятию (теме). */
router.get('/topics/:id/report', (req, res, next) => {
  try {
    const topicId = parseId(req.params.id, 'идентификатор темы');
    resolveScope(req.user, { topicId });
    const filters = parseFilters(req, { topicId, formType: 'lesson' });
    const report = aggregate(filters, { enforceMinimum: !isAdmin(req.user) });
    const topic = get(
      `SELECT t.id, t.title, t.lesson_date, d.id AS discipline_id, d.title AS discipline_title,
              u.full_name AS teacher_name
         FROM topics t
         JOIN disciplines d ON d.id = t.discipline_id
         LEFT JOIN users u ON u.id = d.teacher_id
        WHERE t.id = ?`,
      topicId
    );
    report.topic = topic || null;
    report.timeline = timeline(filters, { formType: 'lesson' });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/** Комментарии отдельным запросом (с поиском по тексту). */
router.get('/comments', (req, res, next) => {
  try {
    const disciplineId = req.query.discipline_id
      ? parseId(req.query.discipline_id, 'идентификатор дисциплины')
      : null;
    const topicId = req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null;
    const scope = resolveScope(req.user, { disciplineId, topicId });
    const formType = req.query.form_type ? parseFormType(req.query.form_type) : null;
    const from = parseDate(req.query.from, { fieldName: 'Дата «с»' });
    const to = parseDate(req.query.to, { fieldName: 'Дата «по»' });
    const search = sanitizeText(req.query.q || '', { maxLength: 80, keepNewlines: false });

    const filters = { ...scope, formType, from, to };
    if (!isAdmin(req.user)) filters.teacherId = req.user.id;

    const filter = buildFilter(filters);
    const params = [...filter.params];
    let extra = '';
    if (search) {
      extra = " AND c.body LIKE ? ESCAPE '\\'";
      params.push(`%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }

    const rows = all(
      `SELECT c.id, c.question_key, c.body, c.created_date, r.form_type,
              d.title AS discipline_title, t.title AS topic_title, t.lesson_date
         FROM answer_comments c
         JOIN responses r ON r.id = c.response_id
         LEFT JOIN disciplines d ON d.id = r.discipline_id
         LEFT JOIN topics t ON t.id = r.topic_id
        WHERE ${filter.where}${extra}
        ORDER BY c.id DESC
        LIMIT 300`,
      ...params
    );

    const total = aggregate(filters, { includeComments: false });
    if (!isAdmin(req.user) && total.total_responses > 0 && total.hidden) {
      throw new ApiError(403, MIN_ANSWERS_LABEL);
    }

    const labels = questionLabels();
    res.json({
      comments: rows.map((row) => ({
        ...row,
        question_label: labels[row.question_key]?.label || row.question_key,
      })),
      count: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

/** Экспорт в CSV (Excel): открывается двойным щелчком, кодировка UTF-8 с BOM. */
router.get('/export.csv', (req, res, next) => {
  try {
    const disciplineId = req.query.discipline_id
      ? parseId(req.query.discipline_id, 'идентификатор дисциплины')
      : null;
    const topicId = req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null;
    const scope = resolveScope(req.user, { disciplineId, topicId });
    const filters = parseFilters(req, scope);
    if (!isAdmin(req.user)) filters.teacherId = req.user.id;

    const stats = aggregate(filters, { includeComments: false });
    if (!isAdmin(req.user) && stats.total_responses > 0 && stats.hidden) {
      throw new ApiError(403, MIN_ANSWERS_LABEL);
    }

    const rows = exportRows(filters);
    const csv = toCsv(rows);
    const filename = `otchety-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
