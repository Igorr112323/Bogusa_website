'use strict';

/**
 * Нужен ли сидинг: `node scripts/needs-seed.js`.
 *
 * Печатает ровно одну строку в stdout:
 *   empty      - файла базы нет, таблиц нет или в таблице disciplines 0 строк;
 *   populated  - в базе есть хотя бы одна дисциплина.
 *
 * Скрипт нужен start.ps1 и start.sh. Раньше они решали по факту существования
 * data/feedback.sqlite, но этот файл создаёт и `npm run dbcheck` (он открывается
 * раньше сидинга), поэтому на чистой машине наполнение базы пропускалось и
 * главная студента оставалась пустой.
 *
 * Здесь намеренно ничего не создаётся и не меняется: база открывается напрямую,
 * без server/db (тот при require применяет схему).
 */

const fs = require('fs');

function report(state, note) {
  console.log(state);
  if (note) console.error(`needs-seed: ${note}`);
  process.exitCode = 0;
}

let dbFile;
try {
  const config = require('../server/config');
  dbFile = config.DB_FILE;
} catch (err) {
  report('empty', `не удалось прочитать настройки: ${err.message}`);
  return;
}

// Первого запуска: файловой базы ещё нет, смотреть не на что - скрипты старта сидируют.
if (!fs.existsSync(dbFile)) {
  report('empty');
  return;
}

try {
  const { Database } = require('../server/db/driver');
  const db = new Database(dbFile);
  let count = 0;
  try {
    const row = db.get('SELECT COUNT(*) AS n FROM disciplines');
    count = Number(row && row.n ? row.n : 0);
  } finally {
    db.close();
  }
  report(count > 0 ? 'populated' : 'empty');
} catch (err) {
  // Битая или пустая база: считаем, что наполнение нужно.
  report('empty', err.message);
}
