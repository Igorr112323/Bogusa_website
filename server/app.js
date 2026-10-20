'use strict';

/**
 * Сборка Express-приложения: безопасность, статика, API, обработка ошибок.
 *
 * Приложение создаётся в двух вариантах (scope):
 *   'student' — сайт студентов: каталог дисциплин и анкета. Работает на PORT.
 *               Страницы входа, портал, админ-панель и их API отвечают 404.
 *   'staff'   — вход, портал преподавателя и админ-панель. Работает на STAFF_PORT.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { driver } = require('./db');
const { attachUser, requireAuth, requireRole, requirePasswordChanged } = require('./auth');
const { securityMiddleware, extraHeaders } = require('./middleware/security');
const { apiLimiter } = require('./middleware/rateLimit');
const { ApiError } = require('./errors');
const { errorHandler } = require('./validate');

const publicRouter = require('./routes/public');
const authRouter = require('./routes/auth');
const teacherRouter = require('./routes/teacher');
const adminRouter = require('./routes/admin');

/* Маршруты страниц по вариантам приложения. */
const STUDENT_PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/form\/?$/, 'form.html'],
];

const STAFF_PAGES = [
  [/^\/login\/?$/, 'login.html'],
  [/^\/portal(\/.*)?$/, 'portal/index.html'],
  [/^\/admin(\/.*)?$/, 'admin/index.html'],
];

/** Разделы, которых на студенческом порту не существует. */
const STAFF_ONLY_PREFIXES = ['/login', '/portal', '/admin', '/api/auth', '/api/teacher', '/api/admin'];
const STAFF_ONLY_FILES = [
  '/login.html',
  '/js/login.js',
  '/js/portal.js',
  '/js/admin.js',
  '/js/charts.js',
  '/css/dashboard.css',
];

function isStaffPath(pathname) {
  if (STAFF_ONLY_FILES.includes(pathname)) return true;
  const clean = pathname.replace(/\/+$/, '') || '/';
  return STAFF_ONLY_PREFIXES.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
}

function notFoundPage(req, res, message) {
  if (!req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
    const file = path.join(config.PUBLIC_DIR, '404.html');
    if (fs.existsSync(file)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(404).sendFile(file);
    }
  }
  return res.status(404).json({ error: message });
}

/**
 * @param {'student'|'staff'} scope
 */
function createApp(scope = 'student') {
  const app = express();

  // За прокси (LMS, nginx, preview-окружение) — доверяем ограниченному числу хопов,
  // чтобы корректно определять IP для rate-limit и формировать абсолютные ссылки.
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.set('query parser', 'simple');
  app.locals.scope = scope;

  app.use(securityMiddleware(scope));
  app.use(extraHeaders(scope));
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(cookieParser());

  /* ------------------------- Служебные маршруты ------------------------- */

  // Студентам достаточно знать, что сайт живёт: устройство сервера здесь не нужно.
  app.get('/healthz', (_req, res) => {
    if (scope === 'staff') {
      res.json({ ok: true, scope, driver, uptime: Math.round(process.uptime()) });
      return;
    }
    res.json({ ok: true, scope });
  });

  /* --------------------------------- API ------------------------------- */

  app.use('/api', apiLimiter, attachUser);

  // Публичная часть API (анкеты, каталог, отправка ответов) есть в обоих вариантах.
  app.use('/api', publicRouter);

  if (scope === 'staff') {
    app.use('/api/auth', authRouter);
    app.use(
      '/api/teacher',
      requireAuth,
      requireRole('teacher', 'admin'),
      requirePasswordChanged,
      teacherRouter
    );
    app.use('/api/admin', requireAuth, requireRole('admin'), requirePasswordChanged, adminRouter);
  }

  app.use('/api', (req, _res, next) => next(new ApiError(404, 'Метод API не найден')));

  /* ------------------------------ Фронтенд ----------------------------- */

  // На студенческом порту разделы преподавателя и администратора не существуют:
  // ни страницы, ни их скрипты, ни их API.
  if (scope === 'student') {
    app.use((req, res, next) => {
      if (isStaffPath(req.path)) return notFoundPage(req, res, 'Страница не найдена');
      return next();
    });
  }

  const staticOptions = {
    index: false,
    etag: true,
    // Кеш держим выключенным: правки интерфейса должны быть видны сразу после
    // обновления файлов (ссылки на css/js версиионные - ?v= в HTML).
    maxAge: 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  };

  app.use(express.static(config.PUBLIC_DIR, staticOptions));

  function sendPage(relativePath) {
    return (req, res, next) => {
      const file = path.join(config.PUBLIC_DIR, relativePath);
      if (!fs.existsSync(file)) {
        return next(new ApiError(404, 'Раздел ещё не собран'));
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(file);
    };
  }

  const pages = scope === 'staff' ? [...STUDENT_PAGES, ...STAFF_PAGES] : STUDENT_PAGES;
  for (const [pattern, file] of pages) {
    app.get(pattern, sendPage(file));
  }

  // Страница 404: для браузера — аккуратная HTML-страница, для API — JSON.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
      return notFoundPage(req, res, 'Страница не найдена');
    }
    return next(new ApiError(404, 'Страница не найдена'));
  });

  /* --------------------------- Обработка ошибок ------------------------ */

  // Приводим ошибки разбора тела запроса к единому формату.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return next(new ApiError(400, 'Некорректный JSON в теле запроса'));
    }
    if (err && err.type === 'entity.too.large') {
      return next(new ApiError(413, 'Слишком большой объём данных в запросе'));
    }
    return next(err);
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
module.exports.createApp = createApp;
module.exports.isStaffPath = isStaffPath;
