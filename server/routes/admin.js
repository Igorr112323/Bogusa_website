'use strict';

/**
 * Маршруты администратора: преподаватели, дисциплины, темы, сквозные отчёты,
 * выгрузка CSV, QR-коды и журнал аудита.
 */

const express = require('express');
const QRCode = require('qrcode');

const config = require('../config');
const { all, get, run, nowIso } = require('../db');
const { ApiError } = require('../errors');
const { parseId, parseBool, parseDate, parseFormType } = require('../validate');
const { sanitizeText } = require('../sanitize');
const {
  parseDisciplinePayload,
  parseTopicPayload,
  parseTeacherPayload,
} = require('../validator');
const { hashPassword, generatePassword } = require('../auth');
const { aggregate, timeline, exportRows, teacherStatsMap } = require('../services/analytics');
const { getDiscipline } = require('../services/access');
const { logAudit, listAudit } = require('../audit');
const { toCsv } = require('../csv');
const { MIN_ANSWERS_LABEL } = require('../constants');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Сводка                                                              */
/* ------------------------------------------------------------------ */

router.get('/overview', (req, res, next) => {
  try {
    const counts = {
      teachers: get("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'").n,
      admins: get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n,
      disciplines: get('SELECT COUNT(*) AS n FROM disciplines').n,
      active_disciplines: get('SELECT COUNT(*) AS n FROM disciplines WHERE is_active = 1').n,
      topics: get('SELECT COUNT(*) AS n FROM topics').n,
      responses: get('SELECT COUNT(*) AS n FROM responses').n,
      comments: get('SELECT COUNT(*) AS n FROM answer_comments').n,
    };

    const byForm = {
      lesson: get("SELECT COUNT(*) AS n FROM responses WHERE form_type = 'lesson'").n,
      final: get("SELECT COUNT(*) AS n FROM responses WHERE form_type = 'final'").n,
    };

    const avg = get('SELECT AVG(overall_avg) AS a FROM responses');
    const today = new Date();
    const daysAgo = (days) => {
      const d = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    };

    const recent = {
      day: get('SELECT COUNT(*) AS n FROM responses WHERE created_date = ?', daysAgo(0)).n,
      week: get('SELECT COUNT(*) AS n FROM responses WHERE created_date >= ?', daysAgo(7)).n,
      month: get('SELECT COUNT(*) AS n FROM responses WHERE created_date >= ?', daysAgo(30)).n,
    };

    const topDisciplines = all(
      `SELECT d.id, d.title, d.is_active, u.full_name AS teacher_name,
              COUNT(r.id) AS responses, AVG(r.overall_avg) AS avg
         FROM disciplines d
         LEFT JOIN users u ON u.id = d.teacher_id
         LEFT JOIN responses r ON r.discipline_id = d.id
        GROUP BY d.id
        ORDER BY responses DESC, d.title COLLATE NOCASE ASC
        LIMIT 10`
    ).map((row) => ({ ...row, avg: row.avg === null ? null : Math.round(row.avg * 100) / 100 }));

    const teacherStats = teacherStatsMap();

    const teachers = all(
      `SELECT id, login, full_name, role, is_active, last_login_at FROM users
        WHERE role = 'teacher' ORDER BY full_name COLLATE NOCASE ASC`
    ).map((t) => {
      const stats = teacherStats.get(t.id) || { responses: 0, avg: null, lesson_count: 0, final_count: 0, last_response_at: null };
      return {
        ...t,
        is_active: !!t.is_active,
        disciplines: get('SELECT COUNT(*) AS n FROM disciplines WHERE teacher_id = ?', t.id).n,
        responses: stats.responses,
        avg: stats.avg,
        last_response_at: stats.last_response_at,
      };
    });

    const result = {
      counts: { ...counts, ...byForm },
      avg_overall: avg && avg.a !== null ? Math.round(avg.a * 100) / 100 : null,
      recent,
      top_disciplines: topDisciplines,
      teachers,
      timeline: timeline({}, {}),
      min_answers_required: config.MIN_ANSWERS_TO_SHOW,
      min_answers_label: MIN_ANSWERS_LABEL,
    };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Преподаватели                                                       */
/* ------------------------------------------------------------------ */

router.get('/teachers', (req, res, next) => {
  try {
    const stats = teacherStatsMap();
    const teachers = all(
      `SELECT id, login, full_name, role, is_active, must_change_password, last_login_at, created_at
         FROM users ORDER BY role DESC, full_name COLLATE NOCASE ASC`
    ).map((t) => {
      const s = stats.get(t.id) || { responses: 0, avg: null, last_response_at: null };
      return {
        id: t.id,
        login: t.login,
        full_name: t.full_name,
        role: t.role,
        is_active: !!t.is_active,
        must_change_password: !!t.must_change_password,
        last_login_at: t.last_login_at,
        created_at: t.created_at,
        responses: s.responses,
        avg: s.avg,
        last_response_at: s.last_response_at,
        disciplines_count: get('SELECT COUNT(*) AS n FROM disciplines WHERE teacher_id = ?', t.id).n,
      };
    });
    res.json({ teachers });
  } catch (err) {
    next(err);
  }
});

router.post('/teachers', async (req, res, next) => {
  try {
    const payload = parseTeacherPayload(req.body || {});
    const exists = get('SELECT id FROM users WHERE login = ?', payload.login);
    if (exists) throw new ApiError(409, 'Такой логин уже занят');

    // Если пароль не передан — генерируем надёжный и показываем один раз.
    const generatedPassword = payload.password ? null : generatePassword();
    const plainPassword = payload.password || generatedPassword;
    const hash = await hashPassword(plainPassword);
    const now = nowIso();

    const inserted = run(
      `INSERT INTO users (login, password_hash, full_name, role, is_active, must_change_password, token_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      payload.login,
      hash,
      payload.full_name,
      payload.role || 'teacher',
      payload.is_active === undefined ? 1 : payload.is_active,
      1, // требуем смену пароля при первом входе
      now,
      now
    );

    logAudit(req, 'teacher.created', {
      entity: 'user',
      entityId: inserted.lastInsertRowid,
      details: { login: payload.login, role: payload.role || 'teacher' },
    });

    res.status(201).json({
      ok: true,
      teacher: get('SELECT id, login, full_name, role, is_active FROM users WHERE id = ?', inserted.lastInsertRowid),
      password: plainPassword,
      password_generated: Boolean(generatedPassword),
      note: 'Пароль показывается один раз — передайте его преподавателю надёжным способом.',
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/teachers/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор пользователя');
    const user = get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new ApiError(404, 'Пользователь не найден');

    const payload = parseTeacherPayload(req.body || {}, { partial: true });

    if (payload.login && payload.login !== user.login) {
      const clash = get('SELECT id FROM users WHERE login = ? AND id <> ?', payload.login, id);
      if (clash) throw new ApiError(409, 'Такой логин уже занят');
    }

    if (payload.role && payload.role !== user.role) {
      if (user.id === req.user.id) throw new ApiError(400, 'Нельзя изменить свою роль');
      if (user.role === 'admin') {
        const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").n;
        if (admins <= 1) throw new ApiError(400, 'В системе должен остаться хотя бы один администратор');
      }
    }

    if (payload.is_active === 0 && user.id === req.user.id) {
      throw new ApiError(400, 'Нельзя заблокировать собственную учётную запись');
    }

    const fields = [];
    const params = [];
    for (const key of ['login', 'full_name', 'role', 'is_active']) {
      if (payload[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(payload[key]);
      }
    }
    if (payload.password) {
      fields.push('password_hash = ?');
      params.push(await hashPassword(payload.password));
      fields.push('must_change_password = 1');
    }
    if (fields.length === 0) throw new ApiError(400, 'Нет данных для обновления');

    fields.push('updated_at = ?');
    params.push(nowIso());
    // смена логина/пароля/статуса отзывает старые токены
    fields.push('token_version = token_version + 1');
    params.push(id);

    run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params);

    logAudit(req, 'teacher.updated', { entity: 'user', entityId: id, details: Object.keys(payload) });

    res.json({
      ok: true,
      teacher: get('SELECT id, login, full_name, role, is_active FROM users WHERE id = ?', id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Удаление пользователя. Если за ним закреплены дисциплины, нужно либо передать их
 * другому преподавателю (?reassign_to=ID), либо явно согласиться их «отвязать» (force=1).
 */
router.delete('/teachers/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор пользователя');
    const user = get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new ApiError(404, 'Пользователь не найден');

    if (user.id === req.user.id) throw new ApiError(400, 'Нельзя удалить собственную учётную запись');

    if (user.role === 'admin') {
      const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
      if (admins <= 1) throw new ApiError(400, 'В системе должен остаться хотя бы один администратор');
    }

    const disciplines = all('SELECT id, title FROM disciplines WHERE teacher_id = ?', id);

    let reassignTo = null;
    if (req.query.reassign_to) {
      reassignTo = parseId(req.query.reassign_to, 'идентификатор преподавателя');
      if (reassignTo === id) throw new ApiError(400, 'Нельзя передать дисциплины удаляемому пользователю');
      const target = get('SELECT id, role FROM users WHERE id = ?', reassignTo);
      if (!target) throw new ApiError(400, 'Преподаватель для передачи дисциплин не найден');
    } else if (disciplines.length > 0 && !parseBool(req.query.force, false)) {
      throw new ApiError(
        409,
        `За пользователем закреплено дисциплин: ${disciplines.length}. Передайте их другому преподавателю ` +
          '(параметр reassign_to) или удалите с параметром force=1 — тогда дисциплины останутся без преподавателя.',
        { disciplines: disciplines.map((d) => ({ id: d.id, title: d.title })) }
      );
    }

    if (disciplines.length > 0) {
      if (reassignTo) {
        run('UPDATE disciplines SET teacher_id = ?, updated_at = ? WHERE teacher_id = ?', reassignTo, nowIso(), id);
        run('UPDATE responses SET teacher_id = ? WHERE teacher_id = ?', reassignTo, id);
      } else {
        run('UPDATE disciplines SET teacher_id = NULL, updated_at = ? WHERE teacher_id = ?', nowIso(), id);
        run('UPDATE responses SET teacher_id = NULL WHERE teacher_id = ?', id);
      }
    }

    run('DELETE FROM users WHERE id = ?', id);
    logAudit(req, 'teacher.deleted', {
      entity: 'user',
      entityId: id,
      details: { login: user.login, reassign_to: reassignTo, disciplines: disciplines.length },
    });
    res.json({ ok: true, reassigned: reassignTo, unassigned_disciplines: reassignTo ? 0 : disciplines.length });
  } catch (err) {
    next(err);
  }
});

/** Сброс пароля администратором: выдаётся новый временный пароль (показывается один раз). */
router.post('/teachers/:id/reset-password', async (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор пользователя');
    const user = get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new ApiError(404, 'Пользователь не найден');

    const { parsePassword } = require('../validate');
    const provided = req.body?.password;
    const plainPassword = provided
      ? parsePassword(provided, { login: user.login })
      : generatePassword();
    const hash = await hashPassword(plainPassword);

    run(
      `UPDATE users SET password_hash = ?, must_change_password = 1,
              token_version = token_version + 1, updated_at = ? WHERE id = ?`,
      hash,
      nowIso(),
      id
    );

    logAudit(req, 'teacher.password_reset', { entity: 'user', entityId: id });
    res.json({
      ok: true,
      password: plainPassword,
      password_generated: !provided,
      note: 'Пароль показывается один раз. Все активные сессии пользователя завершены.',
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Дисциплины                                                          */
/* ------------------------------------------------------------------ */

router.get('/disciplines', (req, res, next) => {
  try {
    const q = sanitizeText(req.query.q || '', { maxLength: 80, keepNewlines: false });
    const teacherId = req.query.teacher_id
      ? parseId(req.query.teacher_id, 'идентификатор преподавателя')
      : null;

    const conditions = [];
    const params = [];
    if (q) {
      conditions.push("d.title LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }
    if (teacherId) {
      conditions.push('d.teacher_id = ?');
      params.push(teacherId);
    }

    const rows = all(
      `SELECT d.id, d.title, d.code, d.teacher_id, d.is_active, d.created_at,
              u.full_name AS teacher_name,
              (SELECT COUNT(*) FROM topics t WHERE t.discipline_id = d.id) AS topics_count,
              (SELECT COUNT(*) FROM responses r WHERE r.discipline_id = d.id) AS responses,
              (SELECT AVG(overall_avg) FROM responses r WHERE r.discipline_id = d.id) AS avg
         FROM disciplines d LEFT JOIN users u ON u.id = d.teacher_id
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY d.title COLLATE NOCASE ASC`,
      ...params
    );

    res.json({
      disciplines: rows.map((row) => ({
        ...row,
        is_active: !!row.is_active,
        avg: row.avg === null ? null : Math.round(row.avg * 100) / 100,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/disciplines', (req, res, next) => {
  try {
    const payload = parseDisciplinePayload(req.body || {});
    if (payload.teacher_id) assertUserIsTeacher(payload.teacher_id);

    const now = nowIso();
    const inserted = run(
      `INSERT INTO disciplines (title, code, teacher_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      payload.title,
      payload.code,
      payload.teacher_id,
      payload.is_active === undefined ? 1 : payload.is_active,
      now,
      now
    );

    logAudit(req, 'discipline.created', {
      entity: 'discipline',
      entityId: inserted.lastInsertRowid,
      details: { title: payload.title, teacher_id: payload.teacher_id },
    });

    res.status(201).json({ ok: true, discipline: getDiscipline(inserted.lastInsertRowid) });
  } catch (err) {
    next(err);
  }
});

router.patch('/disciplines/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор дисциплины');
    const discipline = get('SELECT * FROM disciplines WHERE id = ?', id);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена');

    const payload = parseDisciplinePayload(req.body || {}, { partial: true });
    if (payload.teacher_id) assertUserIsTeacher(payload.teacher_id);

    const fields = [];
    const params = [];
    for (const key of ['title', 'code', 'teacher_id', 'is_active']) {
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

    // Если сменился преподаватель — обновляем и уже собранные отзывы,
    // чтобы они попали в портал нового преподавателя (дисциплина та же).
    if (payload.teacher_id !== undefined) {
      run('UPDATE responses SET teacher_id = ? WHERE discipline_id = ?', payload.teacher_id, id);
    }

    logAudit(req, 'discipline.updated', { entity: 'discipline', entityId: id, details: Object.keys(payload) });
    res.json({ ok: true, discipline: getDiscipline(id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/disciplines/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор дисциплины');
    const discipline = get('SELECT * FROM disciplines WHERE id = ?', id);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена');

    const responses = get('SELECT COUNT(*) AS n FROM responses WHERE discipline_id = ?', id).n;
    const force = parseBool(req.query.force, false);

    if (responses > 0 && !force) {
      throw new ApiError(
        409,
        `По дисциплине уже собрано анкет: ${responses}. Чтобы сохранить их, отключите дисциплину (is_active = 0). ` +
          'Если нужно удалить вместе с ответами — повторите с параметром force=1.'
      );
    }

    run('DELETE FROM disciplines WHERE id = ?', id); // темы и ответы удалятся каскадно
    logAudit(req, 'discipline.deleted', { entity: 'discipline', entityId: id, details: { responses } });
    res.json({ ok: true, deleted_responses: responses });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Темы                                                                */
/* ------------------------------------------------------------------ */

router.get('/disciplines/:id/topics', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор дисциплины');
    const discipline = getDiscipline(id);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена');

    const topics = all(
      `SELECT t.id, t.title, t.lesson_date, t.position, t.is_active, t.created_at,
              (SELECT COUNT(*) FROM responses r WHERE r.topic_id = t.id) AS responses,
              (SELECT AVG(overall_avg) FROM responses r WHERE r.topic_id = t.id) AS avg
         FROM topics t WHERE t.discipline_id = ?
        ORDER BY (t.lesson_date IS NULL) ASC, t.lesson_date DESC, t.position ASC, t.id ASC`,
      id
    ).map((t) => ({ ...t, is_active: !!t.is_active, avg: t.avg === null ? null : Math.round(t.avg * 100) / 100 }));

    res.json({ discipline, topics });
  } catch (err) {
    next(err);
  }
});

router.post('/topics', (req, res, next) => {
  try {
    const payload = parseTopicPayload(req.body || {});
    const disciplineId = parseId(req.body?.discipline_id, 'идентификатор дисциплины');
    const discipline = getDiscipline(disciplineId);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена');

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

/** Массовое добавление тем (например, список занятий семестра). */
router.post('/disciplines/:id/topics/bulk', (req, res, next) => {
  try {
    const disciplineId = parseId(req.params.id, 'идентификатор дисциплины');
    const discipline = getDiscipline(disciplineId);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена');

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
    const topic = get('SELECT * FROM topics WHERE id = ?', id);
    if (!topic) throw new ApiError(404, 'Тема не найдена');

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
    res.json({ ok: true, topic: get('SELECT * FROM topics WHERE id = ?', id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/topics/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор темы');
    const topic = get('SELECT * FROM topics WHERE id = ?', id);
    if (!topic) throw new ApiError(404, 'Тема не найдена');

    const responses = get('SELECT COUNT(*) AS n FROM responses WHERE topic_id = ?', id).n;
    if (responses > 0 && !parseBool(req.query.force, false)) {
      throw new ApiError(
        409,
        `По этому занятию уже собрано анкет: ${responses}. Отключите тему (is_active = 0) либо повторите с force=1.`
      );
    }

    run('DELETE FROM topics WHERE id = ?', id);
    logAudit(req, 'topic.deleted', { entity: 'topic', entityId: id, details: { responses } });
    res.json({ ok: true, deleted_responses: responses });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Сквозные отчёты, выгрузка, QR                                       */
/* ------------------------------------------------------------------ */

router.get('/report', (req, res, next) => {
  try {
    const filters = {
      teacherId: req.query.teacher_id ? parseId(req.query.teacher_id, 'идентификатор преподавателя') : null,
      disciplineId: req.query.discipline_id ? parseId(req.query.discipline_id, 'идентификатор дисциплины') : null,
      topicId: req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null,
      formType: req.query.form_type ? parseFormType(req.query.form_type) : null,
      from: parseDate(req.query.from, { fieldName: 'Дата «с»' }),
      to: parseDate(req.query.to, { fieldName: 'Дата «по»' }),
    };
    const report = aggregate(filters, { enforceMinimum: false });
    report.timeline = timeline(filters, { formType: filters.formType });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.get('/export.csv', (req, res, next) => {
  try {
    const filters = {
      teacherId: req.query.teacher_id ? parseId(req.query.teacher_id, 'идентификатор преподавателя') : null,
      disciplineId: req.query.discipline_id ? parseId(req.query.discipline_id, 'идентификатор дисциплины') : null,
      topicId: req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null,
      formType: req.query.form_type ? parseFormType(req.query.form_type) : null,
      from: parseDate(req.query.from, { fieldName: 'Дата «с»' }),
      to: parseDate(req.query.to, { fieldName: 'Дата «по»' }),
    };
    const rows = exportRows(filters);
    const csv = toCsv(rows);
    logAudit(req, 'report.exported', { details: { rows: rows.length, filters } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
});

/** Ссылка для студентов (её же кодируем в QR). */
function buildStudentUrl(req, { disciplineId = null, topicId = null, formType = null } = {}) {
  const base = config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = new URL('/form.html', `${base}/`);
  if (disciplineId) url.searchParams.set('discipline', String(disciplineId));
  if (topicId) url.searchParams.set('topic', String(topicId));
  if (formType) url.searchParams.set('form', formType);
  return url.toString();
}

router.get('/link', (req, res, next) => {
  try {
    const disciplineId = req.query.discipline_id ? parseId(req.query.discipline_id, 'идентификатор дисциплины') : null;
    const topicId = req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null;
    const formType = req.query.form_type ? parseFormType(req.query.form_type) : null;
    res.json({ url: buildStudentUrl(req, { disciplineId, topicId, formType }) });
  } catch (err) {
    next(err);
  }
});

router.get('/qr.png', async (req, res, next) => {
  try {
    const disciplineId = req.query.discipline_id ? parseId(req.query.discipline_id, 'идентификатор дисциплины') : null;
    const topicId = req.query.topic_id ? parseId(req.query.topic_id, 'идентификатор темы') : null;
    const formType = req.query.form_type ? parseFormType(req.query.form_type) : null;
    const url = buildStudentUrl(req, { disciplineId, topicId, formType });

    const buffer = await QRCode.toBuffer(url, {
      type: 'png',
      width: Math.min(Math.max(Number(req.query.size) || 512, 128), 1024),
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr-feedback.png"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Журнал аудита                                                       */
/* ------------------------------------------------------------------ */

router.get('/audit', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ events: listAudit({ limit }) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Вспомогательные                                                     */
/* ------------------------------------------------------------------ */

function assertUserIsTeacher(userId) {
  const user = get('SELECT id, role FROM users WHERE id = ?', userId);
  if (!user) throw new ApiError(400, 'Преподаватель не найден');
  return user;
}

module.exports = router;
module.exports.buildStudentUrl = buildStudentUrl;
