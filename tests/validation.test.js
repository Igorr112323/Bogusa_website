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

const validLesson = {
  scores: { l_goals: 5, l_logic: 4, l_visual: 3, l_atmosphere: 5, l_pace: 4, l_org: 5 },
  comments: { l_liked: '  Хорошо  ', l_improve: '', l_wishes: 'Спасибо!' },
};

test('корректная анкета проходит валидацию и тримится', () => {
  const { scores, comments } = validateSubmission(validLesson, 'lesson');
  assert.equal(scores.length, 6);
  assert.deepEqual(
    scores.map((s) => s.score),
    [5, 4, 3, 5, 4, 5]
  );
  assert.equal(comments.length, 2, 'пустые открытые ответы не сохраняются');
  assert.equal(comments[0].body, 'Хорошо');
});

test('незаполненные пункты отклоняются', () => {
  assert.throws(
    () => validateSubmission({ scores: { l_goals: 5 } }, 'lesson'),
    /Заполните все пункты/
  );
});

test('некорректные оценки и посторонние ключи отклоняются', () => {
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...validLesson.scores, l_goals: 7 } }, 'lesson'),
    /от 1 до 5/
  );
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...validLesson.scores, l_goals: 'five' } }, 'lesson'),
    /от 1 до 5/
  );
  assert.throws(
    () => validateSubmission({ ...validLesson, scores: { ...validLesson.scores, evil: 5 } }, 'lesson'),
    /Неизвестный пункт/
  );
});

test('пункты другой анкеты не принимаются', () => {
  assert.throws(
    () => validateSubmission({ scores: { l_goals: 5, f_depth: 5 } }, 'lesson'),
    /Неизвестный пункт/
  );
});

test('слишком длинные тексты не проходят', () => {
  assert.throws(
    () =>
      validateSubmission(
        { ...validLesson, comments: { l_wishes: 'я'.repeat(2500) } },
        'lesson'
      ),
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
      scores: { l_goals: 5, l_logic: 4, l_visual: 3, l_atmosphere: 5, l_pace: 4, l_org: 5 },
      comments: [{ key: 'l_liked', body: 'Было "полезно"' }],
    },
  ]);

  const [header, row] = csv.trim().split('\n');
  assert.ok(header.startsWith('ID анкеты;Тип анкеты;Дисциплина'));
  assert.ok(row.includes('"Основы; программирования"'), 'разделитель внутри значения экранируется');
  assert.ok(row.includes('""полезно""'), 'кавычки удваиваются');
  assert.equal(row.split(';').length >= 7, true, 'значения не должны «разъезжаться» по колонкам');
});

test('комментарии не «перетекают» между анкетами с одинаковыми подписями', () => {
  // «Пожелания преподавателю» есть и в анкете по занятию (l_wishes), и в итоговой (f_wishes)
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

  const [, finalRow, lessonRow] = csv.trim().split('\n');
  const finalCells = finalRow.split(';');
  const lessonCells = lessonRow.split(';');

  assert.equal(finalCells.filter((c) => c === 'ТОЛЬКО_ИТОГОВЫЙ_ТЕКСТ').length, 1);
  assert.equal(finalCells.filter((c) => c === 'ТОЛЬКО_ЗАНЯТИЕ_ТЕКСТ').length, 0);
  assert.equal(lessonCells.filter((c) => c === 'ТОЛЬКО_ЗАНЯТИЕ_ТЕКСТ').length, 1);
  assert.equal(lessonCells.filter((c) => c === 'ТОЛЬКО_ИТОГОВЫЙ_ТЕКСТ').length, 0);
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
  const row = csv.trim().split('\n')[1];
  const cells = row.split(';');
  // колонки l_goals..l_org идут до f_* и должны быть пустыми
  assert.equal(cells[7], '');
  assert.equal(cells[12], '');
});
