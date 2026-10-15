'use strict';

/**
 * Публичные маршруты (без авторизации) — то, что видит студент.
 * Никаких персональных данных здесь не принимается и не отдаётся.
 */

const express = require('express');

const config = require('../config');
const { ApiError } = require('../errors');
const { parseId, parseFormType, validateSubmission } = require('../validate');
const { sanitizeForStorage, sanitizeText } = require('../sanitize');
const { FORMS, FORM_LIST, getScaleQuestions, getTextQuestions } = require('../questions');
const pkg = require('../../package.json');
const { listPublicDisciplines, getPublicDiscipline } = require('../services/catalog');
const { createResponse } = require('../services/responses');
const { catalogLimiter, submitLimiter } = require('../middleware/rateLimit');
const { logAudit } = require('../audit');

const router = express.Router();

/** Метаданные: описания анкет, версия, базовый адрес (для QR). */
router.get('/meta', (req, res) => {
  res.json({
    app: 'bogusa-feedback',
    version: pkg.version,
    forms: FORM_LIST,
    show_teacher_name: config.SHOW_TEACHER_NAME,
    public_base_url: config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`,
  });
});

/** Полное описание одной анкеты (структура, вопросы, шкала). */
router.get('/forms/:formType', (req, res, next) => {
  try {
    const formType = parseFormType(req.params.formType);
    const form = FORMS[formType];
    res.json({
      key: form.key,
      title: form.title,
      short_title: form.shortTitle,
      description: form.description,
      intro: form.intro,
      scale_labels: form.scaleShortLabels,
      scale_words: form.scaleWords,
      sections: form.sections.map((section) => ({
        title: section.title,
        questions: section.questions.map((q) => ({
          key: q.key,
          kind: q.kind,
          label: q.label,
          hint: q.hint || null,
          placeholder: q.placeholder || null,
          max_length: q.maxLength || null,
        })),
      })),
      scale_count: getScaleQuestions(formType).length,
      text_count: getTextQuestions(formType).length,
    });
  } catch (err) {
    next(err);
  }
});

/** Каталог дисциплин с темами (шаг 1 и 2 анкеты). */
router.get('/disciplines', catalogLimiter, (req, res, next) => {
  try {
    const search = sanitizeText(req.query.q || '', { maxLength: 80, keepNewlines: false });
    res.json({ disciplines: listPublicDisciplines({ search }) });
  } catch (err) {
    next(err);
  }
});

router.get('/disciplines/:id', catalogLimiter, (req, res, next) => {
  try {
    const id = parseId(req.params.id, 'идентификатор дисциплины');
    const discipline = getPublicDiscipline(id);
    if (!discipline) throw new ApiError(404, 'Дисциплина не найдена или ещё не открыта для анкетирования');
    res.json({ discipline });
  } catch (err) {
    next(err);
  }
});

/**
 * Отправка анкеты.
 * Защита: rate-limit по IP, валидация каждого поля, «ловушка» для ботов,
 * минимальное время заполнения, полное отсутствие идентификаторов студента.
 */
router.post('/responses', submitLimiter, (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Honeypot: скрытое поле, которое заполняют только боты.
    // Отвечаем «успехом», но ничего не сохраняем.
    const honeypot = sanitizeText(body.contact_email || '', { maxLength: 100 });
    if (honeypot.length > 0) {
      logAudit(req, 'response.honeypot_rejected', { details: { discipline_id: body.discipline_id ?? null } });
      return res.status(202).json({ ok: true, message: 'Спасибо! Ваш ответ отправлен.' });
    }

    const disciplineId = parseId(body.discipline_id, 'идентификатор дисциплины');
    const formType = parseFormType(body.form_type);
    const topicId =
      body.topic_id === undefined || body.topic_id === null || body.topic_id === ''
        ? null
        : parseId(body.topic_id, 'идентификатор темы');

    // Минимальное время заполнения — отсекает автоматические отправки.
    const startedAt = Number.parseInt(String(body.started_at ?? ''), 10);
    if (Number.isFinite(startedAt) && startedAt > 0) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 0 && elapsed < config.ANTI_BOT_MIN_FILL_MS) {
        throw new ApiError(429, 'Анкета заполнена слишком быстро. Проверьте ответы и отправьте снова.');
      }
    }

    const { scores, comments } = validateSubmission(body, formType);

    // Тексты очищаем и экранируем (защита от XSS) — в БД попадает безопасная строка.
    const safeComments = comments.map((c) => ({
      key: c.key,
      body: sanitizeForStorage(c.body, { maxLength: 2000 }),
    }));

    const saved = createResponse({
      disciplineId,
      topicId,
      formType,
      scores,
      comments: safeComments,
    });

    logAudit(req, 'response.created', {
      entity: 'response',
      entityId: saved.id,
      details: { form_type: formType, discipline_id: disciplineId, topic_id: topicId },
    });

    return res.status(201).json({
      ok: true,
      id: saved.id,
      message: 'Спасибо! Ваш ответ сохранён анонимно.',
    });
  } catch (err) {
    return next(err);
  }
});

/** Небольшая справка о том, какие данные НЕ собираются (доверие студентов). */
router.get('/privacy', (_req, res) => {
  res.json({
    collects: ['дисциплина', 'тема занятия', 'тип анкеты', 'оценки 1–5', 'текст открытых ответов', 'дата отправки'],
    does_not_collect: [
      'ФИО и любые имена',
      'номер группы и зачётной книжки',
      'IP-адрес в базе данных (используется только в счётчике частоты запросов в памяти)',
      'cookies и любые идентификаторы студента',
      'e-mail и телефон',
    ],
    note: 'Ответы нельзя связать с конкретным студентом: в базе нет ни одной колонки с идентификатором автора.',
  });
});

module.exports = router;
