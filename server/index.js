'use strict';

/**
 * Точка входа: запуск двух HTTP-серверов.
 *
 *   PORT       (по умолчанию 3000) — сайт студентов: каталог дисциплин и анкета;
 *   STAFF_PORT (по умолчанию 3001) — вход, портал преподавателя и админ-панель.
 *
 * Оба сервера работают с одной базой данных в одном процессе.
 */

const config = require('./config');
const createApp = require('./app');
const database = require('./db');
const { db } = database;
const { ensureAdminAccount } = require('./seed');

// Информация о драйвере — видна в стартовом логе и в npm run doctor
const driverInfo = db.info();
const driver = driverInfo.driver;

const studentApp = createApp('student');
const staffApp = createApp('staff');

const servers = [];
const studentServer = studentApp.listen(config.PORT, config.HOST);
servers.push(studentServer);

studentServer.once('listening', () => {
  const staffServer = staffApp.listen(config.STAFF_PORT, config.HOST);
  servers.push(staffServer);
  staffServer.once('listening', onReady);
});

function onReady() {
  const host = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
  const studentBase = `http://${host}:${config.PORT}`;
  const staffBase = `http://${host}:${config.STAFF_PORT}`;

  console.log('');
  console.log('  Анонимная обратная связь от студентов');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  Режим:            ${config.NODE_ENV}`);
  console.log(`  Версия:           ${require('../package.json').version}`);
  console.log(`  Драйвер БД:       ${driver} ${driverInfo.driverVersion ? `(${driverInfo.driverVersion})` : ''}`);
  console.log(`  Файл БД:          ${config.DB_FILE}`);
  console.log('  ────────────────────────────────────────────────');
  console.log('  Студенты (без входа):');
  console.log(`    Главная:        ${studentBase}/`);
  console.log(`    Анкета:         ${studentBase}/form.html`);
  console.log('  Преподаватель и администратор:');
  console.log(`    Вход:           ${staffBase}/login`);
  console.log(`    Портал:         ${staffBase}/portal/`);
  console.log(`    Админ-панель:   ${staffBase}/admin/`);
  if (config.PUBLIC_BASE_URL) {
    console.log(`  Публичный адрес студенческого сайта: ${config.PUBLIC_BASE_URL}`);
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
}

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
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* сервер уже закрыт */
    }
  }
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
    const port = err.port || err.address || config.PORT;
    console.error(
      `[server] порт ${port} уже занят. Закройте другое окно с сервером или запустите с другими портами: ` +
        'PORT=8080 STAFF_PORT=8081 npm start (Windows: .\\start.ps1 -Port 8080 -StaffPort 8081)'
    );
  }
  shutdown(null);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] необработанное отклонение промиса:', reason);
});

module.exports = studentServer;
module.exports.studentServer = studentServer;
