#!/usr/bin/env node
'use strict';

/**
 * Смена пароля администратора, когда вход в панель уже недоступен или пароль
 * засветился в переписке, логах и выводе seed.
 *
 *   node scripts/set-admin-password.js 'Новый пароль'
 *   node scripts/set-admin-password.js                    # сгенерировать и показать один раз
 *
 * Вопросы не задаются: пароль либо из аргумента, либо случайный. Все прежние сессии
 * администратора завершаются (token_version + 1), поэтому украденный токен перестаёт
 * работать. ADMIN_PASSWORD в .env этот скрипт не меняет: он используется только при
 * создании базы, но если базу пересоздать (npm run reset), вернётся старый пароль -
 * после смены обновите и строку ADMIN_PASSWORD в .env.
 */

const config = require('../server/config');
const { get, run, nowIso } = require('../server/db');
const { hashPassword, generatePassword } = require('../server/auth');
const { parsePassword } = require('../server/validate');

function fail(message, hint) {
  console.error(`[set-admin-password] ${message}`);
  if (hint) console.error(`[set-admin-password] ${hint}`);
  process.exitCode = 1;
}

async function main() {
  const provided = process.argv.slice(2).join(' ').trim();
  if (provided && process.argv.slice(2).length > 1) {
    fail('пароль передают одной строкой в кавычках', "пример: node scripts/set-admin-password.js 'Мой пароль 2026'");
    return;
  }

  const login = config.ADMIN_LOGIN;
  const user = get(`SELECT id, login, role, is_active FROM users WHERE login = ? AND role = 'admin'`, login);
  if (!user) {
    fail(`администратор «${login}» не найден в базе`, 'создайте базу: npm run seed (пароль возьмётся из ADMIN_PASSWORD в .env)');
    return;
  }
  if (!user.is_active) {
    fail(`учётная запись «${login}» отключена`, `включите: node -e "const{run}=require('./server/db');run('UPDATE users SET is_active=1 WHERE id=?',${user.id})"`);
    return;
  }

  let password;
  let generated = false;
  if (provided) {
    try {
      password = parsePassword(provided, { login });
    } catch (err) {
      fail(`пароль не подошёл: ${err.message}`, 'нужно не короче 10 символов и минимум два разных класса символов');
      return;
    }
  } else {
    password = generatePassword();
    generated = true;
  }

  const hash = await hashPassword(password);
  run(
    `UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, updated_at = ? WHERE id = ?`,
    hash,
    nowIso(),
    user.id
  );

  console.log(`[set-admin-password] Пароль администратора «${login}» обновлён.`);
  if (generated) {
    console.log(`[set-admin-password] Новый пароль (показывается один раз): ${password}`);
    console.log('[set-admin-password] Сохраните его в менеджер паролей сразу - в логах сервера его не будет.');
  } else {
    console.log('[set-admin-password] Прежние сессии администратора завершены, вход с новым паролем работает сразу.');
  }
  console.log(`[set-admin-password] База: ${config.DB_FILE}`);
}

main().catch((err) => fail(err.message, err.stack ? err.stack.split('\n')[1] : null));
