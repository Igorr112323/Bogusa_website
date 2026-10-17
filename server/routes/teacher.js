'use strict';

/**
 * Маршруты преподавателя. Любой запрос проходит проверку «моя ли это дисциплина».
 * Администратору доступны те же маршруты (он видит всё) — через ?teacher_id=.
 */

const express = require('express');

const { ApiError } = require('../errors');
const { parseId, parseDate, parseFormType, parseBool } = require('../validate');
const { sanitizeText } = require('../sanitize');
const {
  visibleDisciplines,
  resolveScope,
  isAdmin,
  getDiscipline,
  assertDisciplineAccess,
  assertTopicAccess,
} = require('../services/access');
const {
  aggregate,
  timeline,
  exportRows,
  disciplineStatsMap,
  buildFilter,
} = require('../services/analytics');
const { all, get, run, nowIso } = require('../db');
const { toCsv } = require('../csv');
const { questionLabels } = require('../questions');
const { MIN_ANSWERS_LABEL } = require('../constants');
const { parseDisciplinePayload, parseTopicPayload } = require('../validator');
const { logAudit } = require('../audit');

const router = express.Router();

/** Общие параметры фильтра из query. */
function parseFilters(req, base = {}) {
  const formType = req.query.form_type ? parseFormType(req.query.form_type) : null;
  const from = parseDate(req.query.from, { fieldName: 'Дата «с»' });
  const to = parseDate(req.query.to, { fieldName: 'Дата «по»' });
  return { ...base, formType, from, to };
}

/* ------------------------------------------------------------------ */
/* Новые ответы с прошлого просмотра раздела «Отчёт»                   */
/* ------------------------------------------------------------------ */

/** Момент последнего захода в отчёт. Пустая строка = преподаватель ещё не заходил. */
function seenThreshold(userId) {
  const row = get('SELECT seen_at FROM teacher_views WHERE user_id = ?', userId);
  return row ? row.seen_at : '';
}

/** Условия видимости: преподаватель - только свои дисциплины, админ - все. */
function ownerClause(user, params) {
  if (isAdmin(user)) return null;
  params.push(user.id);
  return 'r.teacher_id = ?';
}

/** Сколько анкет и комментариев пришло после seenThreshold. */
function newSince(user, { disciplineId = null, topicId = null, since = undefined } = {}) {
  const threshold = since === undefined ? seenThreshold(user.id) : since;
  const clauses = ['r.created_at > ?'];
  const params = [threshold];
  const owner = ownerClause(user, params);
  if (owner) clauses.push(owner);
  if (disciplineId) {
    clauses.push('r.discipline_id = ?');
    params.push(disciplineId);
  }
  if (topicId) {
    clauses.push('r.topic_id = ?');
    params.push(topicId);
  }
  const where = clauses.join(' AND ');
  const responses = get(`SELECT COUNT(*) AS n FROM responses r WHERE ${where}`, ...params).n;
  const comments = get(
    `SELECT COUNT(*) AS n
       FROM answer_comments c JOIN responses r ON r.id = c.response_id
      WHERE ${where}`,
    ...params
  ).n;
  return { responses, comments, seen_at: threshold || null };
}

/** Те же счётчики, но сгруппированные по дисциплинам - для меню и списка тем. */
function newByDiscipline(user, { since = undefined } = {}) {
  const threshold = since === undefined ? seenThreshold(user.id) : since;
  const build = (from) => {
    const params = [threshold];
    const owner = ownerClause(user, params);
    return all(
      `SELECT r.discipline_id AS id, COUNT(*) AS n
         FROM ${from}
        WHERE r.created_at > ?${owner ? ` AND ${owner}` : ''}
        GROUP BY r.discipline_id`,
      ...params
    );
  };
  const map = new Map();
  const slot = (id) => {
    if (!map.has(id)) map.set(id, { new_responses: 0, new_comments: 0 });
    return map.get(id);
  };
  for (const row of build('responses r')) slot(row.id).new_responses = row.n;
  for (const row of build('answer_comments c JOIN responses r ON r.id = c.response_id')) {
    slot(row.id).new_comments = row.n;
  }
  return map;
}

/** Дисциплина, закреплённая за преподавателем: чужие не создаём и не правим. */
function assertUserIsTeacher(userId) {
  const user = get('SELECT id, role FROM users WHERE id = ?', userId);
  if (!user || user.role !== 'teacher') throw new ApiError(400, 'Преподаватель не найден');
  return user;
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
    const disciplines = visibleDisciplines(user);

    // Статистика именно по дисциплине: у одного преподавателя их может быть несколько.
    const stats = disciplineStatsMap(parseFilters(req, scope));

    const enriched = disciplines.map((d) => {
      const row = stats.get(d.id) || null;
      return {
        id: d.id,
        title: d.title,
        code: d.code,
        is_active: !!d.is_active,
        teacher_id: d.teacher_id,
        teacher_name: d.teacher_name || null,
        topics_count: d.topics_count,
        responses: row ? row.responses : 0,
        lesson: row ? row.lesson_count : 0,
        final: row ? row.final_count : 0,
        avg: row ? row.avg : null,
        last_response_at: row ? row.last_response_at : null,
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
      `SELECT t.id, t.title, t.lesson_date, t.is_active,
              (SELECT COUNT(*) FROM responses r WHERE r.topic_id = t.id) AS responses
         FROM topics t
        WHERE t.discipline_id = ?
        ORDER BY (t.lesson_date IS NULL) ASC, t.lesson_date DESC, t.position ASC, t.id ASC`,
      d.id
    ).map((t) => ({ ...t, is_active: !!t.is_active })),
  }));

  const fresh = newByDiscipline(req.user);
  const withNew = disciplines.map((d) => ({
    ...d,
    new_responses: fresh.get(d.id)?.new_responses ?? 0,
    new_comments: fresh.get(d.id)?.new_comments ?? 0,
  }));

  res.json({
    disciplines: withNew,
    new_responses_total: withNew.reduce((acc, d) => acc + d.new_responses, 0),
    new_comments_total: withNew.reduce((acc, d) => acc + d.new_comments, 0),
    seen_at: seenThreshold(req.user.id) || null,
  });
});

/** Отчёт по дисциплине: средние по пунктам + комментарии. */
router.get('/disciplines/:id/report', (req, res, next) => {
  try {
    const disciplineId = parseId(req.params.id, 'идентификатор дисциплины');
    resolveScope(req.user, { disciplineId });
    const filters = parseFilters(req, { disciplineId });
    const report = aggregate(filters, {
      enforceMinimum: !isAdmin(req.user),
      since: seenThreshold(req.user.id),
    });
    report.timeline = timeline(filters, { formType: filters.formType });
    report.discipline = getDiscipline(disciplineId);
    if (!report.discipline) throw new ApiError(404, 'Дисциплина не найдена');
    const fresh = newSince(req.user, { disciplineId });
    report.new_responses = fresh.responses;
    report.new_comments = fresh.comments;
    report.seen_at = fresh.seen_at;
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
    const report = aggregate(filters, {
      enforceMinimum: !isAdmin(req.user),
      since: seenThreshold(req.user.id),
    });
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
    const fresh = newSince(req.user, { disciplineId: topic?.discipline_id ?? null, topicId });
    report.new_responses = fresh.responses;
    report.new_comments = fresh.comments;
    report.seen_at = fresh.seen_at;
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
    const onlyNew = parseBool(req.query.only_new, false);
    const threshold = seenThreshold(req.user.id);

    const filters = { ...scope, formType, from, to };
    if (!isAdmin(req.user)) filters.teacherId = req.user.id;

    const filter = buildFilter(filters);
    const params = [...filter.params];
    let extra = '';
    if (onlyNew) {
      extra += ' AND r.created_at > ?';
      params.push(threshold);
    }
    if (search) {
      extra += " AND c.body LIKE ? ESCAPE '\\'";
      params.push(`%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }

    const rows = all(
      `SELECT c.id, c.question_key, c.body, c.created_date, r.form_type, r.created_at,
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

    const labels = questionLabels(undefined, { includeLegacy: true });
    res.json({
      comments: rows.map((row) => ({
        ...row,
        question_label: labels[row.question_key]?.label || row.question_key,
        is_new: row.created_at > threshold,
      })),
      count: rows.length,
      seen_at: threshold || null,
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

/* ------------------------------------------------------------------ */
/* Дисциплины и темы: преподаватель ведёт их сам                        */
/* ------------------------------------------------------------------ */

/** Новая дисциплина всегда закрепляется за её создателем (админ может указать другого). */
router.post('/disciplines', (req, res, next) => {
  try {
    const payload = parseDisciplinePayload(req.body || {});
    let teacherId = req.user.id;
    if (isAdmin(req.user)) {
      if (payload.teacher_id && payload.teacher_id !== req.user.id) {
        assertUserIsTeacher(payload.teacher_id);
        teacherId = payload.teacher_id;
      }
    }

    const now = nowIso();
    const inserted = run(
      `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      payload.title,
      payload.code,
      teacherId,
      payload.is_active === undefined ? 1 : payload.is_active,
      now,
      now
    );

    logAudit(req, 'discipline.created', {
      entity: 'discipline',
      entityId: inserted.lastInsertRowid,
      details: { title: payload.title, teacher_id: teacherId },
    });

    res.status(201).json({ ok: true, discipline: getDiscipline(inserted.lastInsertRowid) });
  } catch (err) {
    next(err);
  }
});

/** Правит только название, код и флаг активности: преподавателя назначает админ. */
router.patch('/disciplines/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор дисциплины');
    assertDisciplineAccess(req.user, id);

    const payload = parseDisciplinePayload(req.body || {}, { partial: true });
    const fields = [];
    const params = [];
    for (const key of ['title', 'code', 'is_active']) {
      if (payload[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(payload[key]);
      }
    }
    if (fields.length === 0) throw new ApiError(400, 'Нет данных для обновления');
    fields.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);

    run(`UPDATE disciplines SET ${fields.join(', ')} WHERE id = ?`, ...params);
    logAudit(req, 'discipline.updated', { entity: 'discipline', entityId: id, details: Object.keys(payload) });
    res.json({ ok: true, discipline: getDiscipline(id) });
  } catch (err) {
    next(err);
  }
});

/** Тема занятия в своей дисциплине. */
router.post('/topics', (req, res, next) => {
  try {
    const disciplineId = parseId(req.body?.discipline_id, 'идентификатор дисциплины');
    assertDisciplineAccess(req.user, disciplineId);
    const payload = parseTopicPayload(req.body || {});

    const inserted = run(
      `INSERT INTO topics (discipline_id, title, lesson_date, position, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      disciplineId,
      payload.title,
      payload.lesson_date,
      payload.position || 0,
      payload.is_active === undefined ? 1 : payload.is_active,
      nowIso()
    );

    logAudit(req, 'topic.created', { entity: 'topic', entityId: inserted.lastInsertRowid, details: { disciplineId } });
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

/** Список занятий семестра сразу: одна тема в строке, дата необязательна. */
router.post('/disciplines/:id/topics/bulk', (req, res, next) => {
  try {
    const disciplineId = parseId(req.params.id, 'идентификатор дисциплины');
    assertDisciplineAccess(req.user, disciplineId);

    const items = req.body?.topics;
    if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'Передайте массив тем');
    if (items.length > 100) throw new ApiError(400, 'За один раз можно добавить не более 100 тем');

    const now = nowIso();
    const created = [];
    const { tx } = require('../db');
    tx(() => {
      let position = get('SELECT IFNULL(MAX(position), 0) AS p FROM topics WHERE discipline_id = ?', disciplineId).p;
      for (const item of items) {
        const payload = parseTopicPayload(item || {});
        position += 1;
        const inserted = run(
          `INSERT INTO topics (discipline_id, title, lesson_date, position, is_active, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
          disciplineId,
          payload.title,
          payload.lesson_date,
          payload.position || position,
          now
        );
        created.push(inserted.lastInsertRowid);
      }
    });

    logAudit(req, 'topic.bulk_created', { entity: 'discipline', entityId: disciplineId, details: { count: created.length } });
    res.status(201).json({ ok: true, created: created.length, ids: created });
  } catch (err) {
    next(err);
  }
});

router.patch('/topics/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор темы');
    assertTopicAccess(req.user, id);
    const payload = parseTopicPayload(req.body || {}, { partial: true });

    const fields = [];
    const params = [];
    for (const key of ['title', 'lesson_date', 'position', 'is_active']) {
      if (payload[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(payload[key]);
      }
    }
    if (fields.length === 0) throw new ApiError(400, 'Нет данных для обновления');
    params.push(id);

    run(`UPDATE topics SET ${fields.join(', ')} WHERE id = ?`, ...params);
    logAudit(req, 'topic.updated', { entity: 'topic', entityId: id, details: Object.keys(payload) });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Раздел просмотрен: счётчик новых анкет и комментариев обнуляется. */
router.post('/seen', (req, res, next) => {
  try {
    const seenAt = nowIso();
    run(
      `INSERT INTO teacher_views (user_id, seen_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at`,
      req.user.id,
      seenAt
    );
    res.json({ ok: true, seen_at: seenAt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
