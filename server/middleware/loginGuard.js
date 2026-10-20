'use strict';

/**
 * Пауза после неудачных попыток входа.
 *
 * Правило одно и то же всегда: после нескольких неверных паролей подряд вход
 * недоступ ровно LOGIN_COOLDOWN_SECONDS секунд. Пауза не накапливается и не
 * растёт - ни для преподавателя, ни для администратора. Как только она
 * закончилась, снова доступно LOGIN_MAX_ATTEMPTS попыток.
 *
 * Успешный вход обнуляет счётчик. Счётчики живут только в памяти процесса и
 * никуда не записываются.
 */

const config = require('../config');

const MAX_TRACKED_IPS = 20000;
const state = new Map();

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function isDisabled() {
  return config.LOGIN_MAX_ATTEMPTS <= 0 || config.LOGIN_COOLDOWN_SECONDS <= 0;
}

/** Чистим протухшие записи, чтобы словарь не рос бесконечно. */
function cleanup(now) {
  for (const [key, entry] of state) {
    if (entry.blockedUntil <= now && entry.lastFail <= now - config.LOGIN_COOLDOWN_SECONDS * 1000) {
      state.delete(key);
    }
  }
  if (state.size > MAX_TRACKED_IPS) {
    for (const [key, entry] of state) {
      if (entry.blockedUntil <= now) state.delete(key);
    }
  }
}

function registerFailure(key) {
  const now = Date.now();
  const entry = state.get(key) || { fails: 0, blockedUntil: 0, lastFail: 0 };
  entry.fails += 1;
  entry.lastFail = now;
  if (entry.fails >= config.LOGIN_MAX_ATTEMPTS) {
    // фиксированная пауза: всегда одинаковая длина, счётчик начинается заново
    entry.blockedUntil = now + config.LOGIN_COOLDOWN_SECONDS * 1000;
    entry.fails = 0;
  }
  state.set(key, entry);
  cleanup(now);
}

function respondBlocked(req, res) {
  const seconds = config.LOGIN_COOLDOWN_SECONDS;
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    error: `Слишком много неверных попыток входа. Повторите через ${seconds} секунд.`,
    code: 'LOGIN_COOLDOWN',
    retryAfterSeconds: seconds,
  });
}

function loginGuard(req, res, next) {
  if (isDisabled() || req.method !== 'POST') return next();

  const key = clientKey(req);
  const now = Date.now();
  const entry = state.get(key);
  cleanup(now);
  if (entry && entry.blockedUntil > now) return respondBlocked(req, res);

  res.on('finish', () => {
    if (res.statusCode === 401) registerFailure(key);
    else if (res.statusCode < 400) state.delete(key);
  });
  return next();
}

/** Только для тестов: забыть все счётчики. */
function resetLoginGuard() {
  state.clear();
}

module.exports = { loginGuard, resetLoginGuard };
