'use strict';

/**
 * Заголовки безопасности: политика CSP и ограничения на встраивание в кадр.
 *
 * Inline-скрипты запрещены, весь фронтенд - внешние .js/.css. Инлайн-стили
 * задаются через CSSOM (node.style), поэтому 'unsafe-inline' не требуется.
 *
 * Студенческие страницы можно встраивать в LMS (переменная FRAME_ANCESTORS),
 * а страницы панелей встраивать нельзя никуда: иначе на форме входа или в
 * настройках можно подсовывать чужую кнопку поверх настоящих.
 */

const helmet = require('helmet');
const config = require('../config');

/**
 * Кавычки в значениях CSP. И dotenv, и EnvironmentFile у systemd снимают одинарные
 * кавычки, а helmet требует `'self'` именно с кавычками: из-за строки
 * `FRAME_ANCESTORS='self'` в .env приложение падало ещё до прослушивания порта.
 * Поэтому ключевые слова дописываем здесь - в .env можно писать и `self`, и `'self'`.
 */
const CSP_KEYWORDS = new Set([
  'none', 'self', 'unsafe-inline', 'unsafe-eval', 'unsafe-allow-redirects',
  'strict-dynamic', 'report-sample', 'wasm-unsafe-eval', 'no-eval', 'none-allow-scripts',
]);

function normalizeSource(token) {
  const value = String(token).trim().replace(/^["']|["']$/g, '').trim();
  if (!value) return null;
  if (value === '*') return '*';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(value)) return value;          // data:, https:, blob:
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value)) return value; // https://lms.university.ru
  if (CSP_KEYWORDS.has(value)) return `'${value}'`;
  return value;
}

/** @returns {string[]} список источников для директивы CSP */
function normalizeCspList(value) {
  return String(value == null ? '' : value)
    .split(/[\s,]+/)
    .map(normalizeSource)
    .filter(Boolean);
}

function frameAncestorsFor(scope) {
  if (scope === 'staff') return ["'none'"];
  const list = normalizeCspList(config.FRAME_ANCESTORS);
  return list.length > 0 ? list : ["'self'"];
}

function cspDirectives(scope) {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: frameAncestorsFor(scope),
    upgradeInsecureRequests: config.IS_PROD && config.COOKIE_SECURE ? [] : null,
  };
}

/**
 * @param {'student'|'staff'} scope
 */
function securityMiddleware(scope) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives(scope),
    },
    // X-Frame-Options на студенческом порту ломает встраивание анкеты в LMS,
    // на служебном он нужен как страховка для старых браузеров.
    frameguard: scope === 'staff' ? { action: 'deny' } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.IS_PROD && config.COOKIE_SECURE ? { maxAge: 15552000 } : false,
  });
}

/**
 * Дополнительные заголовки: no-store для API (ответы и сессии не кэшируются),
 * отказ от индексации служебных страниц и запрет на кадр для панелей.
 *
 * @param {'student'|'staff'} scope
 */
function extraHeaders(scope) {
  return function setExtraHeaders(req, res, next) {
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (scope === 'staff') res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}

module.exports = { securityMiddleware, extraHeaders, normalizeCspList, frameAncestorsFor };
