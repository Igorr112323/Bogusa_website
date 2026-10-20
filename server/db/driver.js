'use strict';

/**
 * Слой доступа к SQLite.
 *
 * Драйверы (выбор через переменную окружения DB_DRIVER, иначе автоматически):
 *   1. better-sqlite3 — быстрый нативный драйвер; ставится из готового бинарника,
 *      компилятор не нужен (для Node 22/24/25/26 нужна версия 12 и новее);
 *   2. node:sqlite    — встроенный в Node.js 22.5+ модуль (компиляция не нужна).
 *
 * Автовыбор: сначала better-sqlite3, при неудаче — node:sqlite. Причина выбора
 * запоминается (this.reason) и показывается в `npm run doctor` и в стартовом логе.
 *
 * Особенность node:sqlite: подготовленные выражения (Statement) не кэшируются —
 * так надёжнее, потому что нативные объекты не живут до самого завершения процесса.
 *
 * Все параметры передаются только через placeholders (?), конкатенации значений в SQL нет.
 */

const fs = require('fs');
const path = require('path');

const DRIVERS = ['better-sqlite3', 'node:sqlite'];

function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

function loadBetterSqlite3() {
  // eslint-disable-next-line global-require
  const BetterSqlite3 = require('better-sqlite3');
  return {
    name: 'better-sqlite3',
    version: (() => {
      try {
        // eslint-disable-next-line global-require
        return require('better-sqlite3/package.json').version;
      } catch {
        return 'unknown';
      }
    })(),
    open(file) {
      const raw = new BetterSqlite3(file);
      raw.pragma('journal_mode = WAL');
      raw.pragma('busy_timeout = 5000');
      raw.pragma('foreign_keys = ON');
      return {
        exec: (sql) => raw.exec(sql),
        prepare: (sql) => raw.prepare(sql),
        close: () => raw.close(),
      };
    },
  };
}

function loadNodeSqlite() {
  // eslint-disable-next-line global-require
  const nodeSqlite = require('node:sqlite');
  if (!nodeSqlite || typeof nodeSqlite.DatabaseSync !== 'function') {
    throw new Error('модуль node:sqlite недоступен');
  }
  return {
    name: 'node:sqlite',
    version: process.versions.node,
    open(file) {
      const raw = new nodeSqlite.DatabaseSync(file);
      raw.exec('PRAGMA journal_mode = WAL;');
      raw.exec('PRAGMA busy_timeout = 5000;');
      raw.exec('PRAGMA foreign_keys = ON;');
      return {
        exec: (sql) => raw.exec(sql),
        // Выражения не кэшируем: короткоживущие нативные объекты ведут себя предсказуемее
        prepare: (sql) => raw.prepare(sql),
        close: () => raw.close(),
      };
    },
  };
}

const LOADERS = { 'better-sqlite3': loadBetterSqlite3, 'node:sqlite': loadNodeSqlite };

/** Какой драйвер пытаться использовать (можно переопределить через DB_DRIVER). */
function preferredDrivers() {
  const requested = String(process.env.DB_DRIVER || '').trim().toLowerCase();
  if (requested) {
    if (!DRIVERS.includes(requested)) {
      throw new Error(`DB_DRIVER=${requested} не поддерживается. Допустимо: ${DRIVERS.join(', ')}`);
    }
    // явный выбор пользователя уважаем: сначала он, затем остальные как страховка
    return [requested, ...DRIVERS.filter((d) => d !== requested)];
  }
  return [...DRIVERS];
}

class Database {
  constructor(file) {
    this.file = file;
    this.driver = null;
    this.driverVersion = null;
    this.reason = null;
    this.raw = null;
    this.stmtCache = new Map();
    this.cacheStatements = true;
    this.txDepth = 0;
    this.savepointSeq = 0;
    this._prepareRaw = null;
    this._open();
  }

  _open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const failures = [];

    for (const name of preferredDrivers()) {
      let implementation = null;
      try {
        implementation = LOADERS[name]();
      } catch (err) {
        failures.push(`${name}: ${err.code === 'MODULE_NOT_FOUND' ? 'пакет не установлен' : err.message}`);
        continue;
      }

      try {
        const connection = implementation.open(this.file);
        this.raw = connection;
        this.driver = implementation.name;
        this.driverVersion = implementation.version;
        this._prepareRaw = (sql) => connection.prepare(sql);
        this.cacheStatements = implementation.name !== 'node:sqlite';
        this.reason =
          failures.length > 0
            ? `выбран ${name} (не сработало — ${failures.join('; ')})`
            : `выбран ${name}`;
        return;
      } catch (err) {
        failures.push(`${name}: ${err.message}`);
      }
    }

    throw new Error(
      'Не найден рабочий драйвер SQLite.\n' +
        `Попытки: ${failures.join('; ') || 'нет доступных драйверов'}\n` +
        'Что сделать: npm install better-sqlite3@^12 (нужны Node.js 22 или новее и интернет)\n' +
        'Проверка: npm run dbcheck'
    );
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  _prepare(sql) {
    if (!this.cacheStatements) return this._prepareRaw(sql);
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

  /** Информация для диагностики (npm run doctor, стартовый лог). */
  info() {
    return {
      driver: this.driver,
      driverVersion: this.driverVersion,
      reason: this.reason,
      file: this.file,
      statementsCached: this.cacheStatements,
    };
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

module.exports = { Database, normalizeParams, DRIVERS, preferredDrivers };
