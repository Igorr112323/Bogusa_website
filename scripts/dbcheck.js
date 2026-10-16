'use strict';

/**
 * Проверка драйвера базы данных: `npm run dbcheck`.
 *
 * Запускается отдельным процессом — поэтому корректно переживает даже аварийное
 * падение нативного модуля (именно так ведёт себя сломанный node:sqlite в сборке
 * Node.js): скрипт вернёт код 1 и объяснит, что делать, вместо непонятного
 * «Assertion failed» из недр Node.js.
 *
 * Проверяет: открытие базы, запись, чтение, транзакцию, внешние ключи и WAL.
 *
 * Параметры:
 *   --temp   использовать временную базу вместо рабочей (по умолчанию рабочая)
 *   --quiet  печатать только итог
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const useTemp = args.includes('--temp');
const quiet = args.includes('--quiet');

function ok(text) {
  if (!quiet) console.log(`  [ok]   ${text}`);
}
function fail(text) {
  console.log(`  [FAIL] ${text}`);
}

console.log('');
console.log('  Проверка базы данных');
console.log('  ────────────────────────────────────────────────');

let config = null;
let tempDir = null;
let dbFile = null;
try {
  config = require('../server/config');
  dbFile = config.DB_FILE;
} catch (err) {
  console.log(`  [FAIL] Не удалось определить каталог данных: ${err.message}`);
  console.log('         Проверьте переменную DATA_DIR в .env и права на каталог data.');
  console.log('');
  process.exit(1);
}
// Рабочей базы ещё нет - проверяем на временном файле. Иначе открытие базы
// создало бы data/feedback.sqlite, и start.ps1 решил бы, что база уже есть.
let tempCheck = useTemp;
if (!useTemp && !fs.existsSync(dbFile)) tempCheck = true;
if (tempCheck) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bogusa-dbcheck-'));
  dbFile = path.join(tempDir, 'check.sqlite');
  if (!quiet) console.log('  [info] рабочей базы ещё нет - проверка на временном файле');
}

const startedAt = Date.now();
let db = null;

try {
  const { Database } = require('../server/db/driver');
  db = new Database(dbFile);
  const info = db.info();
  const ms = Date.now() - startedAt;

  ok(`Драйвер: ${info.driver} (${info.driverVersion}) за ${ms} мс`);
  if (!quiet) console.log(`         ${info.reason}`);

  // 1. Схема и запись
  db.exec(`
    CREATE TABLE IF NOT EXISTS _dbcheck (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const inserted = db.run('INSERT INTO _dbcheck (note, created_at) VALUES (?, ?)', 'проверка', new Date().toISOString());
  ok(`Запись выполнена (id=${inserted.lastInsertRowid})`);

  // 2. Чтение
  const row = db.get('SELECT note, created_at FROM _dbcheck WHERE id = ?', inserted.lastInsertRowid);
  if (!row || row.note !== 'проверка') throw new Error('чтение вернуло неожиданный результат');
  ok('Чтение вернуло ожидаемые данные');

  // 3. Транзакция и её откат
  const txResult = db.transaction(() => db.run('INSERT INTO _dbcheck (note, created_at) VALUES (?, ?)', 'транзакция', new Date().toISOString()));
  if (!txResult.lastInsertRowid) throw new Error('транзакция не выполнилась');
  try {
    db.transaction(() => {
      db.run('INSERT INTO _dbcheck (note, created_at) VALUES (?, ?)', 'откат', new Date().toISOString());
      throw new Error('намеренная ошибка для проверки отката');
    });
  } catch (err) {
    if (!/намеренная ошибка/.test(err.message)) throw err;
  }
  const rollbackCount = db.get("SELECT COUNT(*) AS n FROM _dbcheck WHERE note = 'откат'").n;
  if (rollbackCount !== 0) throw new Error('откат транзакции не сработал');
  ok('Транзакции и откат работают');

  // 4. Внешние ключи
  const fk = db.get('PRAGMA foreign_keys');
  if (Number(fk.foreign_keys) !== 1) throw new Error('внешние ключи не включены');
  ok('Внешние ключи включены');

  // 5. Режим журнала (WAL — устойчивее к сбоям)
  const journal = db.get('PRAGMA journal_mode');
  const journalMode = String(journal.journal_mode || '').toLowerCase();
  if (journalMode !== 'wal') {
    if (!quiet) console.log(`  [warn] режим журнала: ${journalMode} (обычно ожидается wal; для сетевых дисков это нормально)`);
  } else {
    ok('Режим журнала WAL');
  }

  // Уборка за собой
  db.exec('DROP TABLE IF EXISTS _dbcheck;');
  if (tempCheck) db.exec('VACUUM;');

  ok(`Файл базы: ${dbFile}`);
  console.log('  ────────────────────────────────────────────────');
  console.log('  База данных работает нормально.');
  console.log('');
  process.exitCode = 0;
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  message.split('\n').forEach((line, index) => {
    if (index === 0) fail(line);
    else console.log(`         ${line}`);
  });
  console.log('  ────────────────────────────────────────────────');
  console.log('  Проверка не пройдена. Что делать:');
  console.log('');
  console.log('   1) проверьте версию Node.js:  node -v   (нужны 22 или новее)');
  console.log('   2) установите нативный драйвер с готовым бинарником:');
  console.log('        npm install better-sqlite3@^12');
  console.log('   3) повторите проверку:  npm run dbcheck');
  console.log('');
  console.log('  Если npm сообщает «install scripts not yet covered by allowScripts»,');
  console.log('  в package.json должно быть поле:');
  console.log('        "allowScripts": { "better-sqlite3": true, "bcrypt": true }');
  console.log('  Без него npm 12 не запускает install-скрипты и нативные модули');
  console.log('  остаются без бинарников.');
  console.log('');
  console.log('  Если сообщение про каталог данных и права — проверьте DATA_DIR и');
  console.log('  доступность папки data (проще всего распаковать проект в свою папку).');
  console.log('');
  console.log('  Если готовый бинарник не скачивается (ошибки сети, прокси или');
  console.log('  сертификата при обращении к github.com) — повторите установку из');
  console.log('  другой сети: это единственное, что нужно для нативного драйвера.');
  console.log('');
  console.log('  Диагностика окружения целиком:  npm run doctor');
  console.log('');
  process.exitCode = 1;
} finally {
  try {
    if (db) db.close();
  } catch {
    /* ignore */
  }
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
