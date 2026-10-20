'use strict';

/** Вход/выход, текущий пользователь, смена пароля. */

const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { get, run, nowIso } = require('../db');
const { ApiError } = require('../errors');
const { parsePassword } = require('../validate');
const { sanitizeLine } = require('../sanitize');
const {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require('../auth');
const { loginGuard } = require('../middleware/loginGuard');
const { logAudit } = require('../audit');

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    full_name: user.full_name,
    role: user.role,
    must_change_password: !!user.must_change_password,
  };
}

function tokenExpiry(token) {
  const decoded = jwt.decode(token);
  return decoded && decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null;
}

router.post('/login', loginGuard, async (req, res, next) => {
  try {
    const login = sanitizeLine(req.body?.login || '', { maxLength: 64 }).toLowerCase();
    const password = String(req.body?.password || '');

    if (!login || !password) {
      throw new ApiError(400, 'Укажите логин и пароль');
    }

    const user = get('SELECT * FROM users WHERE login = ?', login);

    // Одинаковое сообщение и примерно одинаковое время обработки — нельзя выяснить,
    // существует ли такой логин.
    if (!user || !user.is_active) {
      if (!user) await require('../passwordHash').dummyVerify();
      throw new ApiError(401, 'Неверный логин или пароль');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      logAudit(req, 'auth.login_failed', { entity: 'user', entityId: user.id });
      throw new ApiError(401, 'Неверный логин или пароль');
    }

    run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);

    const token = signToken(user);
    const decoded = jwt.decode(token);
    const ttlMs = decoded && decoded.exp ? decoded.exp * 1000 - Date.now() : 8 * 60 * 60 * 1000;
    setAuthCookie(res, token, ttlMs);

    req.user = publicUser(user);
    logAudit(req, 'auth.login', { entity: 'user', entityId: user.id });

    return res.json({
      ok: true,
      user: publicUser(user),
      expires_at: tokenExpiry(token),
      // Токен отдаётся и в теле ответа: панели могут использовать его как
      // Authorization: Bearer, если браузер блокирует cookie (режим iframe/3rd-party).
      token,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход в систему' });
  return res.json({ user: req.user });
});

/** Смена собственного пароля. Все прочие сессии отзываются (token_version). */
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password || '');
    const newPassword = String(req.body?.new_password || '');

    const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!user) throw new ApiError(401, 'Пользователь не найден');

    const ok = await verifyPassword(currentPassword, user.password_hash);
    if (!ok) throw new ApiError(400, 'Текущий пароль указан неверно');

    const password = parsePassword(newPassword, { login: user.login });
    if (await verifyPassword(password, user.password_hash)) {
      throw new ApiError(400, 'Новый пароль совпадает с текущим');
    }

    const hash = await hashPassword(password);
    run(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0,
              token_version = token_version + 1, updated_at = ?
        WHERE id = ?`,
      hash,
      nowIso(),
      user.id
    );

    // Продлеваем текущую сессию новым токеном, остальные становятся недействительными.
    const fresh = get('SELECT * FROM users WHERE id = ?', user.id);
    const token = signToken(fresh);
    setAuthCookie(res, token, 8 * 60 * 60 * 1000);

    logAudit(req, 'auth.password_changed', { entity: 'user', entityId: user.id });

    return res.json({ ok: true, user: publicUser(fresh), token, message: 'Пароль изменён' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
