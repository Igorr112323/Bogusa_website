'use strict';

/** Краткая шпаргалка: `npm run help` */

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

/** Порты берём из .env, чтобы шпаргалка показывала реальные адреса. */
function envValue(name, fallback) {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
      if (match) {
        const value = match[1].trim().replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  } catch {
    /* файла .env нет — используем значения по умолчанию */
  }
  return fallback;
}

const studentPort = envValue('PORT', '3000');
const staffPort = envValue('STAFF_PORT', '3001');
const student = `http://localhost:${studentPort}`;
const staff = `http://localhost:${staffPort}`;

const text = `
  Сервис «Анонимная обратная связь от студентов» v${pkg.version}
  ────────────────────────────────────────────────────────────────
  Команды
    npm start              запустить сервер (студенты и панели — на разных портах)
    npm run dev            запустить с автоперезапуском при изменении кода
    npm run seed           администратор, преподаватель, дисциплины и темы
    npm run seed -- --demo то же + примеры анонимных ответов
    npm run doctor         проверить окружение (Node.js, драйвер БД, порты, данные)
    npm run dbcheck        отдельно проверить базу данных
    npm run qr             напечатать QR-код со ссылкой на анкету в терминале
    npm test               запустить автотесты
    npm run reset          ПОЛНЫЙ СБРОС: удалить базу и создать заново

  Windows (PowerShell), самый простой путь
    .\\start.ps1                             установка (если нужно) + запуск сервера
    .\\start.ps1 -Port 8080 -StaffPort 8081  другие порты
    .\\start.ps1 -Reset                      пересоздать базу
    .\\start.cmd                             то же двойным щелчком по файлу

  macOS / Linux
    ./start.sh             установка (если нужно) + запуск сервера
    ./start.sh --port 8080 --staff-port 8081

  Адреса
    Студенты (порт ${studentPort}, без входа):
      ${student}/            список дисциплин
      ${student}/form.html   заполнение анкеты
      ${student}/healthz     проверка работоспособности

    Преподаватель и администратор (порт ${staffPort}):
      ${staff}/login     вход
      ${staff}/portal/   портал преподавателя
      ${staff}/admin/    админ-панель

    На студенческом порту вход, портал и админ-панель не работают (отдают 404).
    Ссылки и QR-коды для студентов всегда ведут на ${student}

  Настройки портов и паролей — в файле .env (шаблон: .env.example).
  Подробности: README.md
`;

console.log(text);
