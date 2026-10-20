'use strict';

const config = require('../config');
const { Database } = require('./driver');
const SCHEMA = require('./schema');

const db = new Database(config.DB_FILE);

/** Применение схемы (идемпотентно). */
function migrate() {
  db.exec(SCHEMA);
  const row = db.get('SELECT value FROM schema_meta WHERE key = ?', 'schema_version');
  if (!row) {
    db.run(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?)',
      'schema_version',
      '1'
    );
  }
}

migrate();

module.exports = {
  db,
  driver: db.driver,
  migrate,
  /** Хелперы-сокращения */
  run: (sql, ...params) => db.run(sql, ...params),
  get: (sql, ...params) => db.get(sql, ...params),
  all: (sql, ...params) => db.all(sql, ...params),
  tx: (fn) => db.transaction(fn),
  nowIso: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
};
