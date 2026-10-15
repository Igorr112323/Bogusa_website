'use strict';

/**
 * Валидация входных данных. Никакие «сырые» данные не попадают в SQL — только
 * через placeholders; здесь мы проверяем типы, длины и допустимые значения.
 */

const { ApiError, badRequest } = require('./errors');
const {
  MAX_TEXT_LENGTH,
  getScaleQuestions,
  getTextQuestions,
  isFormType,
} = require('./questions');

const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 10;
// bcrypt учитывает только первые 72 байта, поэтому ограничиваем длину явно
const MAX_PASSWORD_LENGTH = 72;

const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'passw0rd',
  'qwerty12345',
  'qwertyuiop',
  '1234567890',
  '12345678910',
  'administrator',
  'student123',
  'teacher123',
  'letmein123',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(value, message = 'Ожидается объект JSON') {
  if (!isPlainObject(value)) throw badRequest(message);
  return value;
}

/** Логин: латиница/цифры, точка, дефис, подчёркивание; 3–32 символа; приводим к нижнему регистру. */
function parseLogin(input) {
  const login = String(input ?? '').trim().toLowerCase();
  if (!LOGIN_RE.test(login)) {
    throw badRequest(
      'Логин: 3–32 символа, только латинские буквы, цифры и символы . _ - (без пробелов)'
    );
  }
  return login;
}

function parsePassword(input, { login = '' } = {}) {
  const password = String(input ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw badRequest(`Пароль слишком длинный (не более ${MAX_PASSWORD_LENGTH} символов)`);
  }
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower.replace(/[^a-z0-9]/g, ''))) {
    throw badRequest('Пароль слишком простой, выберите другой');
  }
  if (login && lower === String(login).toLowerCase()) {
    throw badRequest('Пароль не должен совпадать с логином');
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    throw badRequest('Пароль должен содержать хотя бы два вида символов: строчные, прописные, цифры, знаки');
  }
  return password;
}

function parseId(input, fieldName = 'id') {
  const raw = String(input ?? '').trim();
  if (!/^\d{1,12}$/.test(raw)) throw badRequest(`Некорректный ${fieldName}`);
  const id = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`Некорректный ${fieldName}`);
  return id;
}

function parseFormType(input) {
  const value = String(input ?? '').trim().toLowerCase();
  const aliases = {
    lesson: 'lesson',
    final: 'final',
    'занятие': 'lesson',
    'итог': 'final',
  };
  const type = aliases[value] || value;
  if (!isFormType(type)) throw badRequest('Неизвестный тип анкеты');
  return type;
}

function parseBool(input, fallback = false) {
  if (input === undefined || input === null || input === '') return fallback;
  if (typeof input === 'boolean') return input;
  const value = String(input).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'да'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(value)) return false;
  return fallback;
}

function parseDate(input, { required = false, fieldName = 'Дата' } = {}) {
  if (input === undefined || input === null || String(input).trim() === '') {
    if (required) throw badRequest(`${fieldName}: заполните значение`);
    return null;
  }
  const raw = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`${fieldName}: ожидается формат ГГГГ-ММ-ДД`);
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${fieldName}: некорректная дата`);
  return raw;
}

function parseIdList(input, fieldName = 'Список идентификаторов') {
  if (!Array.isArray(input)) throw badRequest(`${fieldName}: ожидается массив`);
  if (input.length > 500) throw badRequest(`${fieldName}: слишком много элементов`);
  return input.map((item) => parseId(item, fieldName));
}

/**
 * Валидация ответов студента.
 * @returns {{ scores: Array<{key: string, score: number}>, comments: Array<{key: string, body: string}> }}
 */
function validateSubmission(payload, formType) {
  const data = assertPlainObject(payload, 'Некорректное тело запроса');
  const scaleQuestions = getScaleQuestions(formType);
  const textQuestions = getTextQuestions(formType);
  const scaleKeys = new Set(scaleQuestions.map((q) => q.key));
  const textKeys = new Set(textQuestions.map((q) => q.key));

  const rawScores = data.scores;
  if (!isPlainObject(rawScores)) throw badRequest('Не переданы оценки по пунктам анкеты');

  const scores = [];
  for (const [key, value] of Object.entries(rawScores)) {
    if (!scaleKeys.has(key)) throw badRequest(`Неизвестный пункт анкеты: ${key}`);
    const raw = typeof value === 'string' ? value.trim() : value;
    if (raw === '' || raw === null || raw === undefined) continue; // пропущенный пункт
    if (!/^[1-5]$/.test(String(raw))) {
      throw badRequest(`Оценка по пункту «${key}» должна быть целым числом от 1 до 5`);
    }
    scores.push({ key, score: Number.parseInt(String(raw), 10) });
  }

  const missing = scaleQuestions.filter((q) => !scores.some((s) => s.key === q.key));
  if (missing.length > 0) {
    throw badRequest(
      `Заполните все пункты анкеты: не хватает ${missing.length} из ${scaleQuestions.length} оценок`,
      { missing: missing.map((q) => q.key) }
    );
  }

  const comments = [];
  const rawComments = data.comments;
  if (rawComments !== undefined) {
    if (!isPlainObject(rawComments)) throw badRequest('Некорректный формат открытых ответов');
    for (const [key, value] of Object.entries(rawComments)) {
      if (!textKeys.has(key)) throw badRequest(`Неизвестный открытый вопрос: ${key}`);
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') throw badRequest(`Ответ на «${key}» должен быть текстом`);
      if (value.length > MAX_TEXT_LENGTH + 100) {
        throw badRequest(`Ответ на «${key}» слишком длинный (не более ${MAX_TEXT_LENGTH} символов)`);
      }
      const body = value.trim();
      if (body.length === 0) continue;
      comments.push({ key, body });
    }
  }

  // защита от «лавины» текста: суммарный объём открытых ответов
  const totalLength = comments.reduce((acc, c) => acc + c.body.length, 0);
  if (totalLength > 6000) throw badRequest('Слишком большой объём текста в анкете');

  return { scores, comments };
}

/** Единый обработчик ошибок Express. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isApiError = err instanceof ApiError;
  const status = isApiError ? err.status : err.status && Number.isInteger(err.status) ? err.status : 500;

  if (status >= 500) {
    // Внутренние детали пишем только в лог сервера, клиенту — общее сообщение.
    console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  }

  const body = {
    error: isApiError ? err.message : status === 500 ? 'Внутренняя ошибка сервера' : err.message,
  };
  if (isApiError && err.extra && Object.keys(err.extra).length > 0) Object.assign(body, err.extra);

  if (res.headersSent) return;
  res.status(status).json(body);
}

module.exports = {
  LOGIN_RE,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  isPlainObject,
  assertPlainObject,
  parseLogin,
  parsePassword,
  parseId,
  parseFormType,
  parseBool,
  parseDate,
  parseIdList,
  validateSubmission,
  errorHandler,
};
