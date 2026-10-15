'use strict';

/**
 * Тонкая обёртка над validate.js — оставлена для читаемости импортов в маршрутах.
 * Здесь же собраны «составные» проверки для сущностей (дисциплина, тема).
 */

const { badRequest } = require('./errors');
const { sanitizeLine, sanitizeForStorage } = require('./sanitize');
const { parseDate, parseId, parseBool } = require('./validate');

const MAX_TITLE = 200;
const MAX_CODE = 40;

function parseDisciplinePayload(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = sanitizeLine(body.title, { maxLength: MAX_TITLE });
    if (title.length < 2) throw badRequest('Название дисциплины: минимум 2 символа');
    out.title = sanitizeForStorage(title, { maxLength: MAX_TITLE });
  }
  if (!partial || body.code !== undefined) {
    if (body.code === undefined || body.code === null || String(body.code).trim() === '') {
      out.code = null;
    } else {
      const code = sanitizeLine(body.code, { maxLength: MAX_CODE });
      if (code.length > MAX_CODE) throw badRequest('Код дисциплины: не более 40 символов');
      out.code = sanitizeForStorage(code, { maxLength: MAX_CODE });
    }
  }
  if (!partial || body.teacher_id !== undefined) {
    if (body.teacher_id === undefined || body.teacher_id === null || body.teacher_id === '') {
      out.teacher_id = null;
    } else {
      out.teacher_id = parseId(body.teacher_id, 'идентификатор преподавателя');
    }
  }
  if (!partial || body.is_active !== undefined) {
    out.is_active = parseBool(body.is_active, true) ? 1 : 0;
  }
  return out;
}

function parseTopicPayload(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = sanitizeLine(body.title, { maxLength: MAX_TITLE });
    if (title.length < 2) throw badRequest('Название темы: минимум 2 символа');
    out.title = sanitizeForStorage(title, { maxLength: MAX_TITLE });
  }
  if (!partial || body.lesson_date !== undefined) {
    out.lesson_date = parseDate(body.lesson_date, { fieldName: 'Дата занятия' });
  }
  if (!partial || body.position !== undefined) {
    const pos = Number.parseInt(String(body.position ?? '0'), 10);
    out.position = Number.isFinite(pos) ? Math.min(Math.max(pos, 0), 9999) : 0;
  }
  if (!partial || body.is_active !== undefined) {
    out.is_active = parseBool(body.is_active, true) ? 1 : 0;
  }
  return out;
}

function parseTeacherPayload(body, { partial = false } = {}) {
  const { parseLogin, parsePassword } = require('./validate');
  const out = {};
  if (!partial || body.login !== undefined) {
    out.login = parseLogin(body.login);
  }
  if (!partial || body.full_name !== undefined) {
    const name = sanitizeLine(body.full_name, { maxLength: MAX_TITLE });
    if (name.length < 2) throw badRequest('ФИО преподавателя: минимум 2 символа');
    out.full_name = sanitizeForStorage(name, { maxLength: MAX_TITLE });
  }
  if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
    out.password = parsePassword(body.password, { login: out.login || body.login });
  }
  if (body.role !== undefined) {
    const role = String(body.role).trim().toLowerCase();
    if (!['teacher', 'admin'].includes(role)) throw badRequest('Роль: teacher или admin');
    out.role = role;
  }
  if (body.is_active !== undefined) out.is_active = parseBool(body.is_active, true) ? 1 : 0;
  // Пароль можно не передавать — тогда сервер сгенерирует надёжный и покажет его один раз.
  return out;
}

module.exports = { parseDisciplinePayload, parseTopicPayload, parseTeacherPayload, MAX_TITLE, MAX_CODE };
