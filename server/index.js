'use strict';

/** Точка входа: запуск HTTP-сервера. */

const config = require('./config');
const app = require('./app');
const database = require('./db');
const { db } = database;
const { ensureAdminAccount } = require('./seed');

// Информация о драйвере — видна в стартовом логе и в npm run doctor
const driverInfo = db.info();
const driver = driverInfo.driver;

const server = app.listen(config.PORT, config.HOST, () => {
  const shownHost = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
  console.log('');
  console.log('  Анонимная обратная связь от студентов');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  Режим:            ${config.NODE_ENV}`);
  console.log(`  Драйвер БД:       ${driver} ${driverInfo.driverVersion ? `(${driverInfo.driverVersion})` : ''}`);
  console.log(`  Файл БД:          ${config.DB_FILE}`);
  console.log(`  Сайт студентов:   http://${shownHost}:${config.PORT}/`);
  console.log(`  Вход (общий):     http://${shownHost}:${config.PORT}/login`);
  console.log(`  Портал препода:   http://${shownHost}:${config.PORT}/portal/`);
  console.log(`  Админка:          http://${shownHost}:${config.PORT}/admin/`);
  if (config.PUBLIC_BASE_URL) {
    console.log(`  Публичный адрес:  ${config.PUBLIC_BASE_URL}`);
  }
  console.log('  ────────────────────────────────────────────────');

  if (driver === 'node:sqlite') {
    console.log(
      '  Примечание: используется встроенный в Node.js SQLite (экспериментальный).\n' +
        '  Для скорости и стабильности рекомендуется: npm install better-sqlite3@^12\n' +
        '  Проверка драйвера: npm run dbcheck'
    );
    console.log('');
  } else if (driverInfo.reason && driverInfo.reason.includes('не сработало')) {
    console.log(`  ${driverInfo.reason}`);
    console.log('');
  }

  const admin = ensureAdminAccount();
  if (admin && admin.generated) {
    console.log(`  Администратор создан: логин «${admin.login}», пароль «${admin.password}»`);
    console.log('  Сохраните пароль и смените его после первого входа (.env → ADMIN_PASSWORD).');
  }
  console.log('');
});

// Корректное завершение: закрываем БД, чтобы не терять WAL-данные
// и не оставлять нативные объекты до разрушения окружения Node.js.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  if (signal) console.log(`\n[server] получен сигнал ${signal}, завершаем работу…`);
  try {
    db.close();
  } catch {
    /* база уже закрыта */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Страховка: если процесс завершается по любой причине, база будет закрыта корректно.
process.on('exit', () => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

// Ошибки не должны превращаться в «немой» нативный краш: печатаем причину и выходим аккуратно.
process.on('uncaughtException', (err) => {
  console.error('\n[server] необработанная ошибка:', err && err.stack ? err.stack : err);
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[server] порт ${config.PORT} уже занят. Закройте другое окно с сервером ` +
        'или запустите с другим портом: PORT=8080 npm start (Windows: .\\start.ps1 -Port 8080)'
    );
  }
  shutdown(null);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] необработанное отклонение промиса:', reason);
});

module.exports = server;
