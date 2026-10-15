'use strict';

/**
 * Слой доступа к SQLite.
 *
 * Приложение умеет работать с двумя драйверами:
 *   1. better-sqlite3  — быстрый нативный драйвер (устанавливается опционально,
 *      у него есть готовые бинарники; если сборка недоступна — npm не упадёт);
 *   2. node:sqlite     — встроенный в Node.js 22+ модуль, не требует компиляции.
 *
 * Наружу отдаётся единый минимальный интерфейс: exec / run / get / all / transaction.
 * Все параметры передаются только через placeholders (?) — конкатенации значений в SQL нет.
 */

function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

class Database {
  constructor(file) {
    this.file = file;
    this.driver = null;
    this.raw = null;
    this.stmtCache = new Map();
    this.txDepth = 0;
    this.savepointSeq = 0;
    this._open();
  }

  _open() {
    let BetterSqlite3 = null;
    try {
      // eslint-disable-next-line global-require
      BetterSqlite3 = require('better-sqlite3');
    } catch {
      BetterSqlite3 = null;
    }

    if (BetterSqlite3) {
      const raw = new BetterSqlite3(this.file);
      raw.pragma('journal_mode = WAL');
      raw.pragma('busy_timeout = 5000');
      raw.pragma('foreign_keys = ON');
      this.driver = 'better-sqlite3';
      this.raw = raw;
      this._prepareRaw = (sql) => raw.prepare(sql);
      return;
    }

    let nodeSqlite = null;
    try {
      // eslint-disable-next-line global-require
      nodeSqlite = require('node:sqlite');
    } catch {
      nodeSqlite = null;
    }

    if (!nodeSqlite || typeof nodeSqlite.DatabaseSync !== 'function') {
      throw new Error(
        'Не найден ни один драйвер SQLite.\n' +
          'Установите better-sqlite3 (npm install better-sqlite3) или используйте Node.js 22+ ' +
          '(встроенный модуль node:sqlite).'
      );
    }

    const raw = new nodeSqlite.DatabaseSync(this.file);
    raw.exec('PRAGMA journal_mode = WAL;');
    raw.exec('PRAGMA busy_timeout = 5000;');
    raw.exec('PRAGMA foreign_keys = ON;');
    this.driver = 'node:sqlite';
    this.raw = raw;
    this._prepareRaw = (sql) => raw.prepare(sql);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  _prepare(sql) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this._prepareRaw(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /** Возвращает { changes, lastInsertRowid } */
  run(sql, ...params) {
    const result = this._prepare(sql).run(...normalizeParams(params));
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: Number(result?.lastInsertRowid ?? 0),
    };
  }

  /** Возвращает одну строку (обычный объект) или undefined */
  get(sql, ...params) {
    const row = this._prepare(sql).get(...normalizeParams(params));
    return row ? { ...row } : undefined;
  }

  /** Возвращает массив строк (обычные объекты) */
  all(sql, ...params) {
    const rows = this._prepare(sql).all(...normalizeParams(params));
    return rows.map((row) => ({ ...row }));
  }

  /**
   * Синхронная транзакция. Вложенные вызовы используют SAVEPOINT.
   * fn должна быть синхронной функцией.
   */
  transaction(fn) {
    const nested = this.txDepth > 0;
    const name = `sp_${++this.savepointSeq}`;
    this.exec(nested ? `SAVEPOINT ${name};` : 'BEGIN IMMEDIATE;');
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      this.exec(nested ? `RELEASE ${name};` : 'COMMIT;');
      return result;
    } catch (err) {
      this.txDepth -= 1;
      try {
        this.exec(nested ? `ROLLBACK TO ${name};` : 'ROLLBACK;');
        if (nested) this.exec(`RELEASE ${name};`);
      } catch {
        /* транзакция уже откатилась */
      }
      throw err;
    }
  }

  close() {
    try {
      this.stmtCache.clear();
      this.raw.close();
    } catch {
      /* уже закрыта */
    }
  }
}

module.exports = { Database, normalizeParams };
