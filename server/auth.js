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

/**
 * Имена cookie зависят от роли. Браузер хранит cookie по адресу и не разделяет
 * порты, поэтому одна общая cookie затирала бы вторую сессию: вход в админку
 * выкидывал преподавателя и наоборот. Теперь сессии двух учёток уживаются.
 */
const COOKIE_BY_ROLE = {
  teacher: `${config.COOKIE_NAME}_teacher`,
  admin: `${config.COOKIE_NAME}_admin`,
};

function cookieNameFor(role) {
  return COOKIE_BY_ROLE[role] || config.COOKIE_NAME;
}

/** Панель, из которой пришёл запрос: заголовок X-Panel ставит nginx на своём порту. */
function panelOf(req) {
  const value = String((req.headers && req.headers['x-panel']) || '').toLowerCase();
  return value === 'teacher' || value === 'admin' ? value : null;
}

function setAuthCookie(res, role, token, ttlMs) {
  res.cookie(cookieNameFor(role), token, cookieOptions(ttlMs));
}

function clearAuthCookie(res, role) {
  const names = new Set([config.COOKIE_NAME]);
  if (role && COOKIE_BY_ROLE[role]) {
    names.add(COOKIE_BY_ROLE[role]);
  } else {
    Object.values(COOKIE_BY_ROLE).forEach((name) => names.add(name));
  }
  for (const name of names) res.clearCookie(name, cookieOptions());
}

/**
 * Все возможные токены запроса в порядке предпочтения: cookie своей панели,
 * cookie второй панели, прежнее имя cookie, затем заголовок Bearer (клиенты
 * панелей в iframe, где браузер блокирует cookie).
 */
function extractTokens(req) {
  const tokens = [];
  const cookies = req.cookies || {};
  const names = [];
  const panel = panelOf(req);
  if (panel) names.push(COOKIE_BY_ROLE[panel]);
  for (const name of Object.values(COOKIE_BY_ROLE)) {
    if (!names.includes(name)) names.push(name);
  }
  names.push(config.COOKIE_NAME);
  for (const name of names) {
    const value = cookies[name];
    if (value && !tokens.includes(value)) tokens.push(value);
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    if (value && !tokens.includes(value)) tokens.push(value);
  }
  return tokens;
}

/** Все валидные токены запроса с их payload в порядке предпочтения. */
function extractSessions(req) {
  const sessions = [];
  for (const token of extractTokens(req)) {
    try {
      sessions.push({ token, payload: verifyToken(token) });
    } catch {
      /* пробуем следующий токен */
    }
  }
  return sessions;
}

/** Первый валидный токен запроса или null. */
function extractToken(req) {
  const sessions = extractSessions(req);
  return sessions.length > 0 ? sessions[0] : null;
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
  // req.users — все живые сессии запроса (например, преподаватель и админ в одном
  // браузере); req.user — «своя» учётка для этой панели или просто первая.
  req.users = [];
  for (const session of extractSessions(req)) {
    const user = loadUserById(session.payload.sub);
    if (user && user.is_active && Number(user.token_version) === Number(session.payload.tv)) {
      const pub = {
        id: user.id,
        login: user.login,
        full_name: user.full_name,
        role: user.role,
        must_change_password: !!user.must_change_password,
      };
      if (!req.users.some((u) => u.id === pub.id)) req.users.push(pub);
    }
  }
  const panel = panelOf(req);
  if (panel) {
    const own = req.users.find((u) => u.role === panel);
    if (own) req.users = [own, ...req.users.filter((u) => u.id !== own.id)];
  }
  req.user = req.users[0] || null;
  return next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'Требуется вход в систему'));
  return next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    // Среди сессий запроса ищем учётку с подходящей ролью: админ в админке
    // остаётся админом, даже когда в этом же браузере открыт кабинет преподавателя.
    const users = req.users || (req.user ? [req.user] : []);
    const match = users.find((u) => roles.includes(u.role));
    if (!match) {
      if (users.length === 0) return next(new ApiError(401, 'Требуется вход в систему'));
      return next(new ApiError(403, 'Недостаточно прав для этого действия'));
    }
    req.user = match;
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
