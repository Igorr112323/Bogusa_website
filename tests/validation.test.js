'use strict';

/** Тесты валидации, очистки ввода и выгрузки CSV. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSubmission } = require('../server/validate');
const {
  escapeHtml,
  unescapeHtml,
  sanitizeText,
  sanitizeLine,
  sanitizeForStorage,
} = require('../server/sanitize');
const { toCsv } = require('../server/csv');
const { getScaleQuestions } = require('../server/questions');

/** Оценки по всем пунктам анкеты — состав берётся из определений, чтобы тест не «отставал». */
function allScores(formType, start = 5) {
  const keys = getScaleQuestions(formType).map((q) => q.key);
  const scores = {};
  keys.forEach((key, index) => {
    scores[key] = ((start + index - 1) % 5) + 1;
  });
  return scores;
}

/** Разбор строки CSV с учётом кавычек — чтобы колонки не «разъезжались». */
function splitCsvLine(line, delimiter = ';') {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

const lessonScores = allScores('lesson');
const finalScores = allScores('final');

const validLesson = {
  scores: lessonScores,
  comments: { l_liked: '  Хорошо  ', l_improve: '' },
};

test('корректная анкета проходит валидацию и тримится', () => {
  const { scores, comments } = validateSubmission(validLesson, 'lesson');
  assert.equal(scores.length, 12, 'в анкете по занятию 12 пунктов шкалы');
  assert.equal(new Set(scores.map((s) => s.key)).size, 12);
  assert.ok(scores.every((s) => s.score >= 1 && s.score <= 5));
  assert.equal(comments.length, 1, 'пустые открытые ответы не сохраняются');
  assert.equal(comments[0].key, 'l_liked');
  assert.equal(comments[0].body, 'Хорошо');
});

test('итоговая анкета принимает все свои пункты', () => {
  const { scores, comments } = validateSubmission(
    { scores: finalScores, comments: { f_strengths: 'Понятно объясняет', f_memorable: 'Разбор задач' } },
    'final'
  );
  assert.equal(scores.length, 15, 'в итоговой анкете 15 пунктов шкалы');
  assert.deepEqual(comments.map((c) => c.key).sort(), ['f_memorable', 'f_strengths']);
});

test('незаполненные пункты отклоняются', () => {
  assert.throws(() => validateSubmission({ scores: { l_goals: 5 } }, 'lesson'), /Заполните все пункты/);
  assert.throws(() => validateSubmission({ scores: { f_overall: 5 } }, 'final'), /Заполните все пункты/);
});

test('некорректные оценки и посторонние ключи отклоняются', () => {
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...lessonScores, l_goals: 7 } }, 'lesson'),
    /от 1 до 5/
  );
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...lessonScores, l_goals: 'five' } }, 'lesson'),
    /от 1 до 5/
  );
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...lessonScores, evil: 5 } }, 'lesson'),
    /Неизвестный пункт/
  );
});

test('пункты другой анкеты не принимаются', () => {
  assert.throws(() => validateSubmission({ scores: { l_goals: 5, f_depth: 5 } }, 'lesson'), /Неизвестный пункт/);
});

test('вопросы, которых нет в PDF, из формы убраны и сервером отклоняются', () => {
  // «Пожелания преподавателю» и «Что вызывало затруднения» остались только в старых ответах.
  assert.throws(
    () => validateSubmission({ ...validLesson, comments: { l_wishes: 'Спасибо!' } }, 'lesson'),
    /Неизвестный открытый вопрос/
  );
  assert.throws(
    () => validateSubmission({ scores: finalScores, comments: { f_difficult: 'Темп' } }, 'final'),
    /Неизвестный открытый вопрос/
  );
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...lessonScores, l_wishes: 5 } }, 'lesson'),
    /Неизвестный пункт/
  );
});

test('слишком длинные тексты не проходят', () => {
  assert.throws(
    () => validateSubmission({ ...validLesson, comments: { l_improve: 'я'.repeat(2500) } }, 'lesson'),
    /слишком длинный/
  );
});

test('HTML экранируется при хранении и корректно разэкранируется для CSV', () => {
  const payload = '<script>alert("x")</script>';
  const stored = sanitizeForStorage(payload);
  assert.ok(!stored.includes('<script>'));
  assert.ok(stored.includes('&lt;script&gt;'));
  assert.equal(unescapeHtml(stored), payload);
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;&#x2F;b&gt;');
});

test('управляющие символы удаляются, переводы строк сохраняются', () => {
  const value = sanitizeText('Первая строка\u0000\n\n\n\nВторая строка');
  assert.ok(!value.includes('\u0000'));
  assert.equal(value, 'Первая строка\n\nВторая строка');
});

test('однострочный текст склеивается в одну строку', () => {
  assert.equal(sanitizeLine('  Основы\n\nпрограммирования  '), 'Основы программирования');
});

test('CSV экранирует разделители и кавычки, снимает HTML-экранирование', () => {
  const csv = toCsv([
    {
      id: 1,
      form_type: 'lesson',
      discipline: 'Основы; программирования',
      topic: 'Тема «Кавычки»',
      created_date: '2026-09-10',
      created_at: '2026-09-10T10:00:00.000Z',
      overall_avg: 4.5,
      scores: lessonScores,
      comments: [{ key: 'l_liked', body: 'Было "полезно"' }],
    },
  ]);

  const [header, row] = csv.trim().split('\n');
  assert.ok(header.startsWith('ID анкеты;Тип анкеты;Дисциплина'));
  assert.ok(header.includes('Понятность целей'), 'в заголовке — формулировка пункта из анкеты');
  assert.ok(row.includes('"Основы; программирования"'), 'разделитель внутри значения экранируется');
  assert.ok(row.includes('""полезно""'), 'кавычки удваиваются');
  // 7 служебных колонок + 27 пунктов шкалы (12 по занятию и 15 итоговых) + 5 открытых вопросов
  const headerCells = splitCsvLine(header);
  const rowCells = splitCsvLine(row);
  assert.equal(headerCells.length, 39, 'число колонок в заголовке');
  assert.equal(rowCells.length, headerCells.length, 'значения не разъезжаются по колонкам');
  assert.equal(rowCells[2], 'Основы; программирования', 'разделитель внутри значения не ломает колонки');
  const likedColumn = headerCells.findIndex((h) => h.startsWith('[комментарий] Что вам больше всего понравилось'));
  assert.ok(likedColumn > 0, 'колонка открытого вопроса есть в заголовке');
  assert.equal(rowCells[likedColumn], 'Было "полезно"', 'открытый ответ стоит в своей колонке');
});

test('комментарии не «перетекают» между анкетами и снятыми вопросами', () => {
  // «Пожелания преподавателю» раньше были и в анкете по занятию (l_wishes), и в итоговой (f_wishes)
  const csv = toCsv([
    {
      id: 3,
      form_type: 'final',
      discipline: 'Дисциплина',
      topic: null,
      created_date: '2026-09-10',
      created_at: '2026-09-10T10:00:00.000Z',
      overall_avg: 5,
      scores: { f_depth: 5 },
      comments: [{ key: 'f_wishes', body: 'ТОЛЬКО_ИТОГОВЫЙ_ТЕКСТ' }],
    },
    {
      id: 4,
      form_type: 'lesson',
      discipline: 'Дисциплина',
      topic: 'Тема',
      created_date: '2026-09-11',
      created_at: '2026-09-11T10:00:00.000Z',
      overall_avg: 4,
      scores: { l_goals: 4 },
      comments: [{ key: 'l_wishes', body: 'ТОЛЬКО_ЗАНЯТИЕ_ТЕКСТ' }],
    },
  ]);

  const [header, finalRow, lessonRow] = csv.trim().split('\n');
  const finalCells = splitCsvLine(finalRow);
  const lessonCells = splitCsvLine(lessonRow);

  assert.ok(header.includes('[комментарий, снят с анкеты]'), 'старые ответы попадают в отдельные колонки');
  assert.equal(finalCells.filter((c) => c === 'ТОЛЬКО_ИТОГОВЫЙ_ТЕКСТ').length, 1);
  assert.equal(finalCells.filter((c) => c === 'ТОЛЬКО_ЗАНЯТИЕ_ТЕКСТ').length, 0);
  assert.equal(lessonCells.filter((c) => c === 'ТОЛЬКО_ЗАНЯТИЕ_ТЕКСТ').length, 1);
  assert.equal(lessonCells.filter((c) => c === 'ТОЛЬКО_ИТОГОВЫЙ_ТЕКСТ').length, 0);
});

test('колонки снятых с анкеты вопросов появляются только при наличии ответов', () => {
  const csv = toCsv([
    {
      id: 5,
      form_type: 'lesson',
      discipline: 'Дисциплина',
      topic: 'Тема',
      created_date: '2026-09-12',
      created_at: '2026-09-12T10:00:00.000Z',
      overall_avg: 4,
      scores: lessonScores,
      comments: [{ key: 'l_liked', body: 'Всё понятно' }],
    },
  ]);
  assert.ok(!csv.includes('снят с анкеты'), 'пустые колонки старых вопросов не добавляются');
});

test('пустые оценки другого типа анкеты остаются пустыми в CSV', () => {
  const csv = toCsv([
    {
      id: 2,
      form_type: 'final',
      discipline: 'Дисциплина',
      topic: null,
      created_date: '2026-09-10',
      created_at: '2026-09-10T10:00:00.000Z',
      overall_avg: 5,
      scores: { f_depth: 5 },
      comments: [],
    },
  ]);
  const [header, row] = csv.trim().split('\n');
  const cells = splitCsvLine(row);
  assert.equal(cells.length, splitCsvLine(header).length);
  // колонки пунктов анкеты по занятию (l_goals и далее) идут до итоговых и должны быть пустыми
  assert.equal(cells[7], '');
  assert.equal(cells[12], '');
  assert.equal(cells[18], '');
});
