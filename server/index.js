'use strict';

/** Точка входа: запуск HTTP-сервера. */

const config = require('./config');
const app = require('./app');
const { db, driver } = require('./db');
const { ensureAdminAccount } = require('./seed');

const server = app.listen(config.PORT, config.HOST, () => {
  const shownHost = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
  console.log('');
  console.log('  Анонимная обратная связь от студентов');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  Режим:            ${config.NODE_ENV}`);
  console.log(`  Драйвер БД:       ${driver}`);
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
      '  Примечание: Node.js 22 помечает встроенный SQLite как экспериментальный —\n' +
        '  предупреждение выше безвредно. Установите better-sqlite3 (npm i better-sqlite3),\n' +
        '  чтобы использовать ускоренный драйвер и убрать это сообщение.'
    );
    console.log('');
  }

  const admin = ensureAdminAccount();
  if (admin && admin.generated) {
    console.log(`  Администратор создан: логин «${admin.login}», пароль «${admin.password}»`);
    console.log('  Сохраните пароль и смените его после первого входа (.env → ADMIN_PASSWORD).');
  }
  console.log('');
});

// Корректное завершение: закрываем БД, чтобы не терять WAL-данные.
function shutdown(signal) {
  console.log(`\n[server] получен сигнал ${signal}, завершаем работу…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] необработанное отклонение промиса:', reason);
});

module.exports = server;
