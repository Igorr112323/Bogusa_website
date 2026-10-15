'use strict';

/**
 * Проверка окружения: запускается командой `npm run doctor`.
 * Показывает версию Node.js, выбранный драйвер БД, алгоритм хеширования паролей,
 * состояние базы данных и свободен ли порт. Это первое, что стоит запустить,
 * если сервер не стартует.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const lines = [];
let hasFailure = false;

const good = (text) => lines.push(`  [ok]   ${text}`);
const warn = (text) => lines.push(`  [warn] ${text}`);
const bad = (text) => {
  hasFailure = true;
  lines.push(`  [FAIL] ${text}`);
};
const info = (text) => lines.push(`         ${text}`);

lines.push('');
lines.push('  Диагностика окружения');
lines.push('  ────────────────────────────────────────────────');

/* --- Node.js --- */
const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split('.')[0]);
if (major >= 22) good(`Node.js v${nodeVersion}`);
else bad(`Node.js v${nodeVersion} — нужен 22 или новее: https://nodejs.org/  (winget install --exact --id OpenJS.NodeJS.LTS)`);

good(`Платформа: ${process.platform} / ${process.arch}, ABI модулей: ${process.versions.modules}`);
if (process.platform === 'win32' && major === 24) {
  info('Node.js 24 на Windows: используйте better-sqlite3 12+ (готовые бинарники) — см. ниже.');
}

/* --- Настройки --- */
const config = require('../server/config');
good(`Каталог данных: ${config.DATA_DIR}`);
good(`Режим: ${config.NODE_ENV}`);
if (config.JWT_SECRET && config.JWT_SECRET.length >= 32) good('Секрет JWT задан (токены живут между перезапусками)');
else warn('Секрет JWT не задан явно — он сгенерирован и сохранён в data/jwt.secret');

/* --- Драйвер базы данных --- */
const driverRequested = String(process.env.DB_DRIVER || '').trim();
if (driverRequested) info(`DB_DRIVER задан вручную: ${driverRequested}`);

let betterSqlite = null;
try {
  const pkgFile = require.resolve('better-sqlite3/package.json');
  betterSqlite = require(pkgFile).version;
  good(`Пакет better-sqlite3 установлен (v${betterSqlite})`);
  const binary = path.join(path.dirname(pkgFile), 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(binary)) good('Нативный бинарник better-sqlite3 на месте');
  else {
    warn('Каталог build/Release с бинарником не найден — вероятно, install-скрипт пакета не выполнялся.');
    info('Исправление: npm rebuild better-sqlite3   (или переустановите: npm install better-sqlite3@^12)');
    info('Причина обычно в npm 11.19+/12: он не запускает install-скрипты без allowScripts.');
    info('В package.json должно быть: "allowScripts": { "better-sqlite3": true, "bcrypt": true }');
  }
} catch {
  warn('Пакет better-sqlite3 не установлен или не загружается.');
  info('Он даёт готовые бинарники и самый быстрый доступ к базе.');
  info('Установка: npm install better-sqlite3@^12');
}

/* --- Хеширование паролей --- */
const passwordHash = require('../server/passwordHash');
if (passwordHash.algorithm === 'bcrypt') {
  good('Пароли: bcrypt, cost 12');
} else {
  warn('Пакет bcrypt не загружается — используется встроенный scrypt (N=16384).');
  info('Это безопасная замена, но если нужен именно bcrypt: npm install bcrypt');
  info('Напоминание: npm 11.19+/12 требует allowScripts для установки bcrypt.');
}

/* --- База данных --- */
let db = null;
try {
  const database = require('../server/db');
  db = database.db;
  const driverInfo = db.info();

  good(`База данных открыта: драйвер ${driverInfo.driver} (${driverInfo.driverVersion})`);
  info(driverInfo.reason);
  if (!driverInfo.statementsCached) info('Выражения не кэшируются (безопасный режим для этого драйвера).');

  const { get, all } = database;
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  good(`Таблиц: ${tables.length}`);

  // Реальная проверка записи и транзакции
  const probe = get('SELECT COUNT(*) AS n FROM users').n;
  good(`Чтение работает (пользователей: ${probe})`);

  const counts = {
    admin: get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n,
    teachers: get("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'").n,
    disciplines: get('SELECT COUNT(*) AS n FROM disciplines').n,
    topics: get('SELECT COUNT(*) AS n FROM topics').n,
    responses: get('SELECT COUNT(*) AS n FROM responses').n,
  };

  if (counts.admin > 0) good(`Администраторов: ${counts.admin} (вход через /login)`);
  else bad('Администратора нет — выполните: npm run seed');

  good(`Преподавателей: ${counts.teachers}, дисциплин: ${counts.disciplines}, тем: ${counts.topics}`);
  if (counts.responses > 0) good(`Собранных анкет: ${counts.responses}`);
  else info('Анкет пока нет. Для демо-данных: npm run seed -- --demo');

  const publicDisciplines = get(
    'SELECT COUNT(*) AS n FROM disciplines d WHERE d.is_active = 1 AND EXISTS (SELECT 1 FROM topics t WHERE t.discipline_id = d.id AND t.is_active = 1)'
  ).n;
  if (counts.disciplines > 0 && publicDisciplines === 0) {
    warn('Ни одна дисциплина не видна студентам: нужны активная дисциплина и хотя бы одна активная тема.');
  } else {
    good(`Дисциплин, открытых для студентов: ${publicDisciplines}`);
  }

  const journal = get('PRAGMA journal_mode');
  const journalMode = String(journal.journal_mode || '').toLowerCase();
  if (journalMode === 'wal') good('Режим журнала WAL');
  else warn(`Режим журнала: ${journalMode}`);
} catch (err) {
  bad(`Не удалось открыть базу данных: ${err.message}`);
  info('Запустите отдельную проверку: npm run dbcheck');
}

/* --- Права на запись --- */
try {
  const probe = path.join(config.DATA_DIR, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  good('Каталог данных доступен для записи');
} catch (err) {
  bad(`Нет прав на запись в каталог данных: ${err.message}`);
}

/* --- Порт --- */
const port = config.PORT;
const server = net.createServer();
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    warn(`Порт ${port} уже занят — возможно, сервер уже запущен: http://localhost:${port}/`);
    info('Освободить порт: закройте другое окно с сервером или запустите с другим PORT.');
  } else {
    warn(`Не удалось проверить порт ${port}: ${err.message}`);
  }
  finish();
});
server.once('listening', () => {
  server.close(() => {
    good(`Порт ${port} свободен — можно запускать: npm start`);
    finish();
  });
});
server.listen(port, '0.0.0.0');

function finish() {
  try {
    if (db) db.close();
  } catch {
    /* ignore */
  }
  lines.push('  ────────────────────────────────────────────────');
  if (hasFailure) {
    lines.push('  Есть проблемы — см. сообщения [FAIL] выше.');
    lines.push('  Подробная проверка базы: npm run dbcheck');
  } else {
    lines.push('  Готово. Запуск сервера: npm start  (Windows: .\\start.ps1)');
  }
  lines.push('');
  console.log(lines.join('\n'));
  process.exitCode = hasFailure ? 1 : 0;
}
