'use strict';

/**
 * Ограничение частоты запросов (rate-limit).
 * IP используется только в оперативной памяти счётчиков и нигде не сохраняется.
 */

const rateLimitModule = require('express-rate-limit');
const config = require('../config');

const rateLimit = rateLimitModule.rateLimit || rateLimitModule.default || rateLimitModule;
const ipKeyGenerator =
  typeof rateLimitModule.ipKeyGenerator === 'function' ? rateLimitModule.ipKeyGenerator : null;

const minutes = (n) => n * 60 * 1000;

function keyGenerator(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  // ipKeyGenerator корректно нормализует IPv6-подсети (требование express-rate-limit v7.5+)
  if (ipKeyGenerator) {
    try {
      return ipKeyGenerator(ip);
    } catch {
      /* падаём на «сырой» IP */
    }
  }
  return ip;
}

function buildLimiter({ name, limit, windowMs, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.status(429).json({
        error: message || 'Слишком много запросов. Попробуйте позже.',
        code: `RATE_LIMIT_${String(name).toUpperCase()}`,
        retryAfterSeconds: retryAfter,
      });
    },
  });
}

/** Вход в систему: защита от перебора паролей. */
const loginLimiter = buildLimiter({
  name: 'login',
  limit: config.RATE_LIMIT.login[0],
  windowMs: minutes(config.RATE_LIMIT.login[1]),
  message: 'Слишком много попыток входа. Повторите позже.',
});

/** Отправка анкеты: защита от накрутки и спама (границы указаны в README). */
const submitLimiter = buildLimiter({
  name: 'submit',
  limit: config.RATE_LIMIT.submit[0],
  windowMs: minutes(config.RATE_LIMIT.submit[1]),
  message: 'Слишком много отправленных анкет с этого адреса. Попробуйте позже.',
});

/** Общий лимит на API — защита от простого флуда. */
const apiLimiter = buildLimiter({
  name: 'api',
  limit: config.RATE_LIMIT.api[0],
  windowMs: minutes(config.RATE_LIMIT.api[1]),
  message: 'Слишком много запросов к серверу. Попробуйте позже.',
});

/** Публичный каталог дисциплин (его грузят все студенты). */
const catalogLimiter = buildLimiter({
  name: 'catalog',
  limit: 120,
  windowMs: minutes(5),
  message: 'Слишком много запросов каталога. Подождите немного.',
});

module.exports = { loginLimiter, submitLimiter, apiLimiter, catalogLimiter };
