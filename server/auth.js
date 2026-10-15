'use strict';

/**
 * Аутентификация и авторизация.
 *  - пароли: bcrypt (cost 12), открытый пароль нигде не хранится и не логируется;
 *  - сессия: JWT с ограниченным сроком жизни (по умолчанию 8 часов);
 *    токен кладётся в httpOnly-cookie (фронтенд не имеет к нему доступа из JS);
 *  - поддержка заголовка Authorization: Bearer <token> для интеграций;
 *  - token_version позволяет мгновенно отозвать все токены пользователя
 *    (смена пароля администратором / деактивация аккаунта).
 */

const jwt = require('jsonwebtoken');

const config = require('./config');
const { get } = require('./db');
const { ApiError } = require('./errors');
const passwordHash = require('./passwordHash');

const {
  BCRYPT_ROUNDS,
  hashPassword,
  verifyPassword,
  generatePassword,
} = passwordHash;

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      login: user.login,
      role: user.role,
      tv: Number(user.token_version || 1),
    },
    config.JWT_SECRET,
    {
      expiresIn: config.JWT_EXPIRES_IN,
      issuer: config.JWT_ISSUER,
      algorithm: 'HS256',
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET, {
    issuer: config.JWT_ISSUER,
    algorithms: ['HS256'],
  });
}

function cookieOptions(maxAgeMs) {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    path: '/',
  };
  if (maxAgeMs) opts.maxAge = maxAgeMs;
  return opts;
}

function setAuthCookie(res, token, ttlMs) {
  res.cookie(config.COOKIE_NAME, token, cookieOptions(ttlMs));
}

function clearAuthCookie(res) {
  res.clearCookie(config.COOKIE_NAME, cookieOptions());
}

/** Достаёт токен из cookie или заголовка Authorization. */
function extractToken(req) {
  const cookieToken = req.cookies ? req.cookies[config.COOKIE_NAME] : null;
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

function loadUserById(id) {
  return get(
    `SELECT id, login, full_name, role, is_active, must_change_password, token_version, created_at
       FROM users WHERE id = ?`,
    id
  );
}

/**
 * Мягкая аутентификация: если токен есть и валиден — req.user заполнен,
 * иначе запрос продолжается анонимным (для публичных эндпоинтов).
 */
function attachUser(req, _res, next) {
  const token = extractToken(req);
  req.user = null;
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    const user = loadUserById(payload.sub);
    if (user && user.is_active && Number(user.token_version) === Number(payload.tv)) {
      req.user = {
        id: user.id,
        login: user.login,
        full_name: user.full_name,
        role: user.role,
        must_change_password: !!user.must_change_password,
      };
    }
  } catch {
    req.user = null;
  }
  return next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'Требуется вход в систему'));
  return next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Требуется вход в систему'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'Недостаточно прав для этого действия'));
    }
    return next();
  };
}

/** Пока пользователь не сменил выданный пароль — доступ только к /auth/*. */
function requirePasswordChanged(req, _res, next) {
  if (req.user && req.user.must_change_password) {
    return next(
      new ApiError(403, 'Сначала смените временный пароль', {
        code: 'PASSWORD_CHANGE_REQUIRED',
      })
    );
  }
  return next();
}

module.exports = {
  algorithm: passwordHash.algorithm,
  hashPasswordSync: passwordHash.hashPasswordSync,
  BCRYPT_ROUNDS,
  hashPassword,
  verifyPassword,
  generatePassword,
  signToken,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireRole,
  requirePasswordChanged,
  loadUserById,
};
