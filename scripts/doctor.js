'use strict';

/**
 * Проверка окружения: запускается командой `npm run doctor`.
 * Показывает версию Node.js, доступный драйвер БД, алгоритм хеширования паролей,
 * состояние базы данных и свободен ли порт. Это первое, что стоит запустить,
 * если сервер не стартует.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const lines = [];
const good = (text) => lines.push(`  [ok]   ${text}`);
const warn = (text) => lines.push(`  [warn] ${text}`);
const bad = (text) => lines.push(`  [FAIL] ${text}`);

lines.push('');
lines.push('  Диагностика окружения');
lines.push('  ────────────────────────────────────────────────');

/* --- Node.js --- */
const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split('.')[0]);
if (major >= 20) good(`Node.js v${nodeVersion}`);
else if (major >= 18) warn(`Node.js v${nodeVersion} — работает, но рекомендуется 20 или 22 LTS`);
else bad(`Node.js v${nodeVersion} — нужен 18.18 или новее: https://nodejs.org/`);

good(`Платформа: ${process.platform} / ${process.arch}`);

/* --- Настройки --- */
const config = require('../server/config');
good(`Каталог данных: ${config.DATA_DIR}`);
good(`Режим: ${config.NODE_ENV}`);
if (config.JWT_SECRET && config.JWT_SECRET.length >= 32) good('Секрет JWT задан (токены живут между перезапусками)');
else warn('Секрет JWT не задан явно — он сгенерирован и сохранён в data/jwt.secret');

/* --- Драйвер базы данных --- */
let driverInfo = 'нет';
try {
  require('better-sqlite3');
  driverInfo = 'better-sqlite3 (быстрый нативный драйвер)';
  good(`SQLite: ${driverInfo}`);
} catch {
  try {
    require('node:sqlite');
    driverInfo = 'node:sqlite (встроенный в Node.js)';
    good(`SQLite: ${driverInfo}`);
    warn('Для ускорения можно установить: npm install better-sqlite3');
  } catch {
    driverInfo = 'нет';
    bad('Не найден ни один драйвер SQLite.');
    lines.push('         Установите better-sqlite3 (npm install better-sqlite3)');
    lines.push('         или используйте Node.js 22 LTS и новее — там есть встроенный node:sqlite.');
  }
}

/* --- Хеширование паролей --- */
const passwordHash = require('../server/passwordHash');
if (passwordHash.algorithm === 'bcrypt') {
  good('Пароли: bcrypt, cost 12');
} else {
  warn('Пакет bcrypt недоступен — используется встроенный scrypt (N=16384). Работает безопасно,');
  lines.push('         но если нужен именно bcrypt: npm install bcrypt');
}

/* --- База данных --- */
try {
  const { db, get, all } = require('../server/db');
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  good(`База данных открыта: ${config.DB_FILE}`);
  good(`Таблиц: ${tables.length}`);

  const counts = {
    admin: get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n,
    teachers: get("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'").n,
    disciplines: get("SELECT COUNT(*) AS n FROM disciplines").n,
    topics: get('SELECT COUNT(*) AS n FROM topics').n,
    responses: get('SELECT COUNT(*) AS n FROM responses').n,
  };

  if (counts.admin > 0) good(`Администраторов: ${counts.admin} (вход через /login)`);
  else bad('Администратора нет — выполните: npm run seed');

  good(`Преподавателей: ${counts.teachers}, дисциплин: ${counts.disciplines}, тем: ${counts.topics}`);
  if (counts.responses > 0) good(`Собранных анкет: ${counts.responses}`);
  else lines.push('  [i]    Анкет пока нет. Для демо-данных: npm run seed -- --demo');

  const publicDisciplines = get(
    'SELECT COUNT(*) AS n FROM disciplines d WHERE d.is_active = 1 AND EXISTS (SELECT 1 FROM topics t WHERE t.discipline_id = d.id AND t.is_active = 1)'
  ).n;
  if (counts.disciplines > 0 && publicDisciplines === 0) {
    warn('Ни одна дисциплина не видна студентам: нужны активная дисциплина и хотя бы одна активная тема.');
  } else {
    good(`Дисциплин, открытых для студентов: ${publicDisciplines}`);
  }
  db.close();
} catch (err) {
  bad(`Не удалось открыть базу данных: ${err.message}`);
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
    lines.push('         Освободить порт: закройте другое окно с сервером или запустите с другим PORT.');
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
  lines.push('  ────────────────────────────────────────────────');
  if (lines.some((line) => line.includes('[FAIL]'))) {
    lines.push('  Есть проблемы — см. сообщения [FAIL] выше.');
  } else {
    lines.push('  Всё готово. Запуск сервера: npm start  (или .\\start.ps1 в Windows)');
  }
  lines.push('');
  console.log(lines.join('\n'));
}
