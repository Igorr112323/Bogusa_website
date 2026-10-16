'use strict';

/**
 * Выгрузка в CSV. Используется детерминированный порядок колонок:
 * служебные поля → оценки по пунктам → открытые ответы.
 * Все значения экранируются; пустая строка вместо null.
 */

const {
  questionLabels,
  getScaleQuestions,
  getTextQuestions,
  getLegacyQuestions,
  FORMS,
} = require('./questions');
const { FORM_TYPE_RU } = require('./constants');
const { unescapeHtml } = require('./sanitize');

function csvCell(value, delimiter) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // В CSV — читаемый текст: снимаем HTML-экранирование, добавленное при хранении.
  str = unescapeHtml(str).replace(/\r?\n/g, ' ');
  if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * @param {Array<{id:number, form_type:string, discipline:string, topic:string|null,
 *  created_date:string, created_at:string, overall_avg:number|null,
 *  scores:Record<string,number>, comments:Array<{key:string, body:string}>}>} rows
 */
function toCsv(rows, { delimiter = ';' } = {}) {
  const scaleKeys = [...getScaleQuestions('lesson'), ...getScaleQuestions('final')];
  const textKeys = [...getTextQuestions('lesson'), ...getTextQuestions('final')];
  const labels = questionLabels(undefined, { includeLegacy: true });

  // Снятые с анкет вопросы: колонки добавляются только если по ним есть ответы,
  // иначе выгрузка обрастала бы пустыми столбцами.
  const legacyKeys = [...getLegacyQuestions('lesson'), ...getLegacyQuestions('final')];
  const usedLegacyKeys = legacyKeys.filter((q) =>
    rows.some((row) => (row.comments || []).some((c) => c.key === q.key))
  );

  const header = [
    'ID анкеты',
    'Тип анкеты',
    'Дисциплина',
    'Тема занятия',
    'Дата отправки',
    'Дата и время (UTC)',
    'Средний балл анкеты',
    ...scaleKeys.map((q) => labels[q.key]?.label || q.key),
    ...textKeys.map((q) => `[комментарий] ${labels[q.key]?.label || q.key}`),
    ...usedLegacyKeys.map((q) => `[комментарий, снят с анкеты] ${labels[q.key]?.label || q.key}`),
  ];

  const lines = [header.map((h) => csvCell(h, delimiter)).join(delimiter)];

  for (const row of rows) {
    // Группируем строго по ключу вопроса: подписи в двух анкетах могут совпадать
    // (например, «Пожелания преподавателю» есть и в анкете по занятию, и в итоговой).
    const commentsByKey = new Map();
    for (const c of row.comments || []) {
      if (!commentsByKey.has(c.key)) commentsByKey.set(c.key, []);
      commentsByKey.get(c.key).push(c.body);
    }

    const cells = [
      row.id,
      FORM_TYPE_RU[row.form_type] || row.form_type,
      row.discipline,
      row.topic || '',
      row.created_date,
      row.created_at,
      row.overall_avg,
      ...scaleKeys.map((q) => {
        const value = row.scores ? row.scores[q.key] : undefined;
        // оценки другого типа анкеты не заполнены — оставляем пусто
        return value === undefined ? '' : value;
      }),
      ...textKeys.map((q) => {
        const items = commentsByKey.get(q.key);
        return items ? items.join(' | ') : '';
      }),
      ...usedLegacyKeys.map((q) => {
        const items = commentsByKey.get(q.key);
        return items ? items.join(' | ') : '';
      }),
    ];
    lines.push(cells.map((cell) => csvCell(cell, delimiter)).join(delimiter));
  }

  return `${lines.join('\n')}\n`;
}

/** Описание колонок для README/справки в интерфейсе. */
function formTitles() {
  return Object.values(FORMS).map((f) => ({ key: f.key, title: f.title }));
}

module.exports = { toCsv, formTitles };
