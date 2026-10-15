'use strict';

/** Сборка Express-приложения: безопасность, статика, API, обработка ошибок. */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { driver } = require('./db');
const { attachUser, requireAuth, requireRole, requirePasswordChanged } = require('./auth');
const { helmetMiddleware, extraHeaders } = require('./middleware/security');
const { apiLimiter } = require('./middleware/rateLimit');
const { ApiError } = require('./errors');
const { errorHandler } = require('./validate');

const publicRouter = require('./routes/public');
const authRouter = require('./routes/auth');
const teacherRouter = require('./routes/teacher');
const adminRouter = require('./routes/admin');

const app = express();

// За прокси (LMS, nginx, preview-окружение) — доверяем ограниченному числу хопов,
// чтобы корректно определять IP для rate-limit и формировать абсолютные ссылки.
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.set('query parser', 'simple');

app.use(helmetMiddleware);
app.use(extraHeaders);
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());

/* ------------------------- Служебные маршруты ------------------------- */

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, driver, uptime: Math.round(process.uptime()) });
});

/* --------------------------------- API ------------------------------- */

app.use('/api', apiLimiter, attachUser);

app.use('/api/auth', authRouter);
app.use('/api', publicRouter);

app.use(
  '/api/teacher',
  requireAuth,
  requireRole('teacher', 'admin'),
  requirePasswordChanged,
  teacherRouter
);

app.use('/api/admin', requireAuth, requireRole('admin'), requirePasswordChanged, adminRouter);

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Метод API не найден')));

/* ------------------------------ Фронтенд ----------------------------- */

const staticOptions = {
  index: false,
  etag: true,
  maxAge: config.IS_PROD ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
};

app.use(express.static(config.PUBLIC_DIR, staticOptions));

function sendPage(relativePath) {
  return (req, res, next) => {
    const file = path.join(config.PUBLIC_DIR, relativePath);
    if (!fs.existsSync(file)) {
      return next(new ApiError(404, 'Раздел ещё не собран'));
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(file);
  };
}

const pages = [
  [/^\/$/, 'index.html'],
  [/^\/login\/?$/, 'login.html'],
  [/^\/form\/?$/, 'form.html'],
  [/^\/portal(\/.*)?$/, 'portal/index.html'],
  [/^\/admin(\/.*)?$/, 'admin/index.html'],
];

for (const [pattern, file] of pages) {
  app.get(pattern, sendPage(file));
}

// Страница 404: для браузера — аккуратная HTML-страница, для API — JSON.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
    const file = path.join(config.PUBLIC_DIR, '404.html');
    if (fs.existsSync(file)) return res.status(404).sendFile(file);
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

module.exports = app;
