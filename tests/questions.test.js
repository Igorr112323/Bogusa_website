'use strict';

/**
 * Проверка целостности анкет: состав пунктов, уникальность ключей, наличие
 * открытых вопросов. Если формулировки правятся под PDF — этот тест подскажет,
 * что случайно сломали структуру.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FORMS,
  FORM_LIST,
  getScaleQuestions,
  getTextQuestions,
  questionLabels,
  isFormType,
} = require('../server/questions');

test('определены две анкеты: по занятию и итоговая', () => {
  assert.deepEqual(Object.keys(FORMS).sort(), ['final', 'lesson']);
  assert.equal(FORM_LIST.length, 2);
  assert.ok(isFormType('lesson'));
  assert.ok(isFormType('final'));
  assert.ok(!isFormType('other'));
});

test('анкета по занятию: 6 пунктов шкалы по PDF + открытые вопросы', () => {
  const scale = getScaleQuestions('lesson');
  assert.equal(scale.length, 6, 'ожидается 6 оценочных пунктов');
  assert.deepEqual(
    scale.map((q) => q.key),
    ['l_goals', 'l_logic', 'l_visual', 'l_atmosphere', 'l_pace', 'l_org']
  );
  const text = getTextQuestions('lesson');
  assert.ok(text.length >= 3, 'нужны открытые вопросы (замечания/пожелания)');
});

test('итоговая анкета: 9 пунктов шкалы по PDF, включая рекомендацию', () => {
  const scale = getScaleQuestions('final');
  assert.equal(scale.length, 9);
  assert.ok(scale.some((q) => q.key === 'f_recommend'));
  assert.ok(scale.some((q) => q.key === 'f_feedback'));
  assert.ok(scale.some((q) => q.key === 'f_fairness'));
  assert.ok(getTextQuestions('final').length >= 4);
});

test('ключи вопросов уникальны и подписаны', () => {
  const labels = questionLabels();
  const allKeys = [];
  for (const type of Object.keys(FORMS)) {
    for (const section of FORMS[type].sections) {
      for (const q of section.questions) {
        allKeys.push(q.key);
        assert.ok(q.label && q.label.length > 5, `у пункта ${q.key} должна быть подпись`);
        assert.ok(['scale', 'text'].includes(q.kind));
      }
    }
  }
  assert.equal(new Set(allKeys).size, allKeys.length, 'ключи вопросов не должны повторяться');
  assert.equal(Object.keys(labels).length, allKeys.length);
});

test('шкала описана для всех значений 1..5', () => {
  for (const type of Object.keys(FORMS)) {
    for (let score = 1; score <= 5; score += 1) {
      assert.ok(FORMS[type].scaleLabels[score], `нет подписи для оценки ${score}`);
      assert.ok(FORMS[type].scaleShortLabels[score]);
    }
  }
});
