'use strict';

/**
 * Заголовки безопасности (helmet) и политика CSP.
 *
 * CSP описана явно и не допускает inline-скриптов: весь фронтенд — внешние .js/.css,
 * поэтому XSS-эксплуатация существенно затруднена.
 * frame-ancestors настраивается переменной FRAME_ANCESTORS (по умолчанию '*',
 * чтобы анкету можно было встраивать в LMS/iframe).
 */

const helmet = require('helmet');
const config = require('../config');

const frameAncestors = String(config.FRAME_ANCESTORS)
  .split(/[\s,]+/)
  .map((v) => v.trim())
  .filter(Boolean);

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: frameAncestors.length > 0 ? frameAncestors : ["'self'"],
  upgradeInsecureRequests: config.IS_PROD && config.COOKIE_SECURE ? [] : null,
};

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: cspDirectives,
  },
  // X-Frame-Options мешал бы встраивать анкету в iframe; ограничиваем через CSP frame-ancestors
  frameguard: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.IS_PROD && config.COOKIE_SECURE ? { maxAge: 15552000 } : false,
});

/**
 * Дополнительные заголовки:
 *  - no-store для API (ответы и токены не должны кэшироваться);
 *  - Permissions-Policy: отключаем геолокацию, камеру и т.п.
 */
function extraHeaders(req, res, next) {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  // Служебные страницы не индексируем — это внутренний инструмент
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

module.exports = { helmetMiddleware, extraHeaders };
