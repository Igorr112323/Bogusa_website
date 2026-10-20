'use strict';

/**
 * Конфигурация приложения. Все значения читаются из переменных окружения
 * (файл .env в корне проекта) и имеют безопасные значения по умолчанию.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

function toBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'да'].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Каталог для данных (БД, секреты). По умолчанию ./data */
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Секрет для подписи JWT. Если он не задан в окружении — генерируем случайный
 * и сохраняем в data/jwt.secret (права 600), чтобы токены не «слетали» при
 * перезапуске сервера.
 */
function loadJwtSecret() {
  const fromEnv = (process.env.JWT_SECRET || '').trim();
  if (fromEnv.length >= 16) return fromEnv;
  if (fromEnv.length > 0 && fromEnv.length < 16) {
    throw new Error('JWT_SECRET слишком короткий: задайте не менее 32 случайных символов.');
  }
  const secretFile = path.join(DATA_DIR, 'jwt.secret');
  try {
    const saved = fs.readFileSync(secretFile, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* файла ещё нет — создадим ниже */
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  if (IS_PROD) {
    console.warn(
      '[config] JWT_SECRET не задан — сгенерирован и сохранён в data/jwt.secret. ' +
        'Для продакшена задайте JWT_SECRET в .env.'
    );
  }
  return generated;
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const config = {
  NODE_ENV,
  IS_PROD,
  ROOT_DIR,
  DATA_DIR,
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),

  HOST: process.env.HOST || '0.0.0.0',
  /** Порт для студентов: анкета и каталог дисциплин. */
  PORT: toInt(process.env.PORT, 3000),
  /** Порт для преподавателя и администратора: вход, портал, админ-панель. */
  STAFF_PORT: toInt(process.env.STAFF_PORT, 3001),

  /** Сколько доверенных прокси перед приложением (для корректного IP в rate-limit). */
  TRUST_PROXY_HOPS: toInt(process.env.TRUST_PROXY_HOPS, 1),

  DB_FILE: process.env.DB_FILE
    ? path.resolve(process.env.DB_FILE)
    : path.join(DATA_DIR, 'feedback.sqlite'),

  JWT_SECRET: loadJwtSecret(),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '8h',
  JWT_ISSUER: 'bogusa-feedback',
  COOKIE_NAME: process.env.COOKIE_NAME || 'bf_token',
  COOKIE_SECURE: toBool(process.env.COOKIE_SECURE, PUBLIC_BASE_URL.startsWith('https://')),

  /** Публичный адрес сайта — используется для QR-кодов и ссылок. */
  PUBLIC_BASE_URL,

  /** Показывать ли студентам ФИО преподавателя в каталоге дисциплин. */
  SHOW_TEACHER_NAME: toBool(process.env.SHOW_TEACHER_NAME, true),

  /**
   * Минимальное число ответов, при котором преподаватель видит результаты
   * (защита анонимности: при 1–2 ответах отзыв легко «вычислить»).
   */
  MIN_ANSWERS_TO_SHOW: Math.max(1, toInt(process.env.MIN_ANSWERS_TO_SHOW, 1)),

  /** Простейшая анти-бот проверка: минимальное время заполнения анкеты (мс). */
  ANTI_BOT_MIN_FILL_MS: toInt(process.env.ANTI_BOT_MIN_FILL_MS, 2500),

  /**
   * Кто может встраивать сайт в iframe. По умолчанию разрешено всем —
   * это нужно для вставки анкеты в LMS/iframe и для предпросмотра.
   * Для «жёсткого» режима укажите, например: FRAME_ANCESTORS='self' https://lms.example.ru
   */
  FRAME_ANCESTORS: process.env.FRAME_ANCESTORS || '*',

  RATE_LIMIT: {
    /** Лимиты: [количество запросов, окно в минутах] */
    submit: [toInt(process.env.RATE_LIMIT_SUBMIT, 15), toInt(process.env.RATE_LIMIT_SUBMIT_WINDOW_MIN, 60)],
    api: [toInt(process.env.RATE_LIMIT_API, 600), toInt(process.env.RATE_LIMIT_API_WINDOW_MIN, 15)],
  },

  /**
   * Неверные пароли: после скольких попыток подряд включается пауза.
   * LOGIN_COOLDOWN_SECONDS - её длительность; она всегда одна и та же и не
   * растёт при повторных ошибках. 0 в любом из значений - отключить паузу.
   */
  LOGIN_MAX_ATTEMPTS: toInt(process.env.LOGIN_MAX_ATTEMPTS, 5),
  LOGIN_COOLDOWN_SECONDS: toInt(process.env.LOGIN_COOLDOWN_SECONDS, 10),

  /** Аккаунт администратора, создаваемый при первом запуске / в сидере. */
  ADMIN_LOGIN: (process.env.ADMIN_LOGIN || 'admin').trim(),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ADMIN_NAME: process.env.ADMIN_NAME || 'Администратор',
};

if (config.STAFF_PORT === config.PORT) {
  throw new Error(
    'PORT и STAFF_PORT совпадают: студенческий сайт и вход для преподавателей ' +
      'должны работать на разных портах (например, 3000 и 3001).'
  );
}

/** Хосты, которым можно доверять при построении ссылок, сверх локальных и частных. */
const EXTRA_ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const LOOPBACK_HOST_RE = /^(localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0)$/;
const PRIVATE_HOST_RE =
  /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){3})$/;

/**
 * Имя хоста из запроса используется для ссылок и QR-кодов только если это локальный
 * или частный адрес либо он явно разрешён в ALLOWED_HOSTS. Иначе подставной
 * заголовок Host превратился бы в чужую ссылку, которую преподаватель показал бы
 * студентам. При заданном PUBLIC_URL заголовок Host не используется вовсе.
 */
function isTrustedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!host || host.length > 253) return false;
  if (EXTRA_ALLOWED_HOSTS.includes(host)) return true;
  if (LOOPBACK_HOST_RE.test(host) || PRIVATE_HOST_RE.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.lan')) return true;
  return false;
}

config.isTrustedHost = isTrustedHost;

/**
 * Адрес студенческого сайта. Ссылки и QR-коды для студентов всегда строятся от
 * студенческого порта, даже если их показывает панель на STAFF_PORT.
 *
 * @param {object} [req] запрос Express — из него берётся имя хоста (если оно надёжное)
 * @returns {string} например, http://localhost:3000
 */
function studentBaseUrl(req) {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL;
  let host = 'localhost';
  if (req) {
    const fromRequest = req.hostname || (req.headers && req.headers.host ? String(req.headers.host).split(':')[0] : '');
    if (fromRequest && isTrustedHost(fromRequest)) host = fromRequest;
  }
  return `http://${host}:${config.PORT}`;
}

config.studentBaseUrl = studentBaseUrl;

module.exports = config;
