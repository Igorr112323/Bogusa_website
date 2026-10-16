'use strict';

/**
 * Очистка пользовательского ввода.
 *
 * Стратегия защиты от XSS: HTML-экранирование на входе + экранирование при
 * выводе (фронтенд использует textContent, а не innerHTML). Двойная защита
 * означает, что даже если один слой будет ослаблен при доработке, скрипт не
 * выполнится.
 */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`=/]/g, (char) => HTML_ESCAPES[char]);
}

/** Убираем управляющие символы, «нулевые» и невидимые символы (защита от подмены текста). */
function stripControlChars(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
}

/**
 * Нормализация длинного текста (открытые ответы).
 * @returns {string} очищенная строка (без HTML-экранирования — см. escapeHtml)
 */
function sanitizeText(input, { maxLength = 2000, keepNewlines = true } = {}) {
  let value = typeof input === 'string' ? input : '';
  value = stripControlChars(value);
  // нормализуем переводы строк и «кавычки-ёлочки» не трогаем
  value = value.replace(/\r\n?/g, '\n');
  if (!keepNewlines) value = value.replace(/\n+/g, ' ');
  // не больше двух пустых строк подряд
  value = value.replace(/\n{3,}/g, '\n\n');
  value = value.replace(/[ \t]{2,}/g, ' ');
  value = value.replace(/[ \t]+\n/g, '\n');
  value = value.trim();
  if (value.length > maxLength) value = value.slice(0, maxLength);
  return value;
}

/** Однострочный текст (логины, названия): без переводов строк, схлопнутые пробелы. */
function sanitizeLine(input, { maxLength = 200 } = {}) {
  const value = sanitizeText(input, { maxLength, keepNewlines: false })
    .replace(/\s+/g, ' ')
    .trim();
  return value;
}

/**
 * Текст для хранения: очищен + HTML-экранирован.
 * Именно так и хранятся открытые ответы студентов и названия дисциплин/тем.
 */
function sanitizeForStorage(input, options) {
  return escapeHtml(sanitizeText(input, options));
}

/** Удаление HTML-тегов (для очень «грязного» ввода, например выгрузок). */
function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
}

const HTML_UNESCAPES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x2F;': '/',
  '&#x60;': '`',
  '&#x3D;': '=',
};

/**
 * Снимает HTML-экранирование. Используется только для «не-HTML» вывода:
 * CSV-выгрузки и текстовые логи. В HTML всегда выводим экранированное значение.
 */
function unescapeHtml(value) {
  return String(value ?? '').replace(
    /&(amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g,
    (match) => HTML_UNESCAPES[match] || match
  );
}

module.exports = {
  escapeHtml,
  unescapeHtml,
  stripTags,
  stripControlChars,
  sanitizeText,
  sanitizeLine,
  sanitizeForStorage,
};
