#!/usr/bin/env node
'use strict';

/**
 * Печать QR-кода прямо в терминале (удобно вывести ссылку на анкету на экран).
 *
 *   npm run qr                                  → ссылка на главную страницу анкеты
 *   npm run qr -- --discipline=1 --topic=2 --form=lesson
 *   npm run qr -- --url=https://example.org/form.html?discipline=1
 *
 * Полноценные QR-картинки для печати доступны в админке: «Дисциплины» → «QR-код».
 */

const QRCode = require('qrcode');
const config = require('../server/config');

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const match = /^--([^=]+)=?(.*)$/.exec(item);
    if (match) args[match[1]] = match[2] || true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // QR всегда ведёт на студенческий адрес (порт PORT), а не на порт панелей.
  const base = config.studentBaseUrl();
  let url = args.url || `${base.replace(/\/+$/, '')}/form.html`;
  if (!args.url) {
    const params = new URLSearchParams();
    if (args.discipline) params.set('discipline', String(args.discipline));
    if (args.topic) params.set('topic', String(args.topic));
    if (args.form) params.set('form', String(args.form));
    const query = params.toString();
    if (query) url += `?${query}`;
  }

  const ascii = await QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  console.log(`\nСсылка для студентов: ${url}\n`);
  console.log(ascii);
  console.log(
    `Подсказка: студенческий сайт работает на порту ${config.PORT} (PORT в .env), ` +
      `панели преподавателя и администратора — на порту ${config.STAFF_PORT} (STAFF_PORT).\n` +
      'Если сайт доступен по домену, задайте PUBLIC_BASE_URL в .env — он и попадёт в QR.\n'
  );
}

main().catch((err) => {
  console.error('Не удалось построить QR-код:', err.message);
  process.exitCode = 1;
});
