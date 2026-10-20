'use strict';

/**
 * Проверка соответствия анкет PDF-формулировкам.
 *
 * Эталоны: docs/anketa-zanyatie.pdf и docs/anketa-disciplina.pdf.
 * Если формулировки правятся — этот тест покажет, что именно разошлось.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FORMS,
  FORM_LIST,
  LEGACY_QUESTIONS,
  getScaleQuestions,
  getTextQuestions,
  getLegacyQuestions,
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

test('анкета по занятию: название и подзаголовок как в PDF', () => {
  const form = FORMS.lesson;
  assert.equal(form.title, 'Анкета оценки качества проведенного занятия');
  assert.equal(
    form.subtitle,
    'Пожалуйста, оцените проведенное занятие. Опрос является полностью анонимным, ' +
      'а его результаты будут использованы для улучшения учебного процесса.'
  );
  assert.match(form.intro, /1 — совершенно не согласен/);
  assert.match(form.intro, /5 — полностью согласен/);
});

test('анкета по занятию: четыре блока, 12 пунктов шкалы и 2 открытых вопроса', () => {
  const form = FORMS.lesson;
  assert.deepEqual(form.sections.map((s) => s.title), [
    'Блок 1. Содержание и структура занятия',
    'Блок 2. Преподавательское мастерство и атмосфера',
    'Блок 3. Организация и дисциплина',
    'Блок 4. Открытые вопросы',
  ]);
  assert.deepEqual(form.sections.map((s) => s.questions.length), [5, 5, 2, 2]);
  assert.equal(getScaleQuestions('lesson').length, 12);
  assert.equal(getTextQuestions('lesson').length, 2);
});

test('анкета по занятию: формулировки пунктов дословно из PDF', () => {
  const expected = [
    ['l_goals', 'Понятность целей: В начале занятия были четко обозначены его тема и основные цели.'],
    ['l_logic', 'Логика и структура: Материал излагался последовательно, логично и без хаотичных переходов.'],
    [
      'l_relevance',
      'Актуальность и польза: Предложенный материал интересен, применим на практике или важен для освоения дисциплины.',
    ],
    [
      'l_visual',
      'Наглядность: Преподаватель эффективно использовал наглядные материалы ' +
        '(презентации, схемы, раздаточный материал, примеры на доске/экране).',
    ],
    [
      'l_examples',
      'Связь с теорией/практикой: Преподаватель приводил понятные жизненные или профессиональные примеры ' +
        'для иллюстрирования сложных тем.',
    ],
    ['l_clarity', 'Доступность изложения: Преподаватель объясняет сложный материал простым и понятным языком.'],
    ['l_attention', 'Удержание внимания: Преподаватель вел занятие динамично и умел удержать внимание аудитории.'],
    [
      'l_interaction',
      'Взаимодействие с аудиторией: Преподаватель вовлекал студентов в обсуждение, задавал вопросы, побуждал к размышлению.',
    ],
    [
      'l_atmosphere',
      'Доброжелательность и такт: На занятии преобладала уважительная и комфортная атмосфера; преподаватель был открыт к вопросам.',
    ],
    ['l_pace', 'Темп подачи: Темп занятия был оптимальным (не слишком быстрый и не слишком затянутый).'],
    ['l_org', 'Соблюдение регламента: Занятие началось и завершилось вовремя.'],
    ['l_readiness', 'Готовность: Преподаватель был полностью подготовлен к занятию (материалы, оборудование, план).'],
    ['l_liked', 'Что вам больше всего понравилось на этом занятии?'],
    ['l_improve', 'Что, по вашему мнению, можно было бы улучшить или изменить в формате проведения?'],
  ];

  const actual = FORMS.lesson.sections
    .flatMap((s) => s.questions)
    .map((q) => [q.key, q.label]);

  assert.deepEqual(actual, expected);
});

test('итоговая анкета: название как в PDF, пять блоков, 15 пунктов шкалы и 3 открытых вопроса', () => {
  const form = FORMS.final;
  assert.equal(form.title, 'Итоговая анкета оценки дисциплины и работы ведущего преподавателя');
  assert.deepEqual(form.sections.map((s) => s.title), [
    'Блок 1. Содержание дисциплины и учебный процесс',
    'Блок 2. Преподавательское мастерство и стиль работы',
    'Блок 3. Оценивание и обратная связь',
    'Блок 4. Общие итоги',
    'Блок 5. Открытые вопросы (качественная обратная связь)',
  ]);
  assert.deepEqual(form.sections.map((s) => s.questions.length), [4, 5, 3, 3, 3]);
  assert.equal(getScaleQuestions('final').length, 15);
  assert.equal(getTextQuestions('final').length, 3);
  assert.match(form.intro, /1 — совершенно не согласен/);
});

test('итоговая анкета: формулировки пунктов дословно из PDF', () => {
  const expected = [
    [
      'f_theory_practice',
      'Целостность курса: Лекционный материал и практические/лабораторные задания идеально дополняли друг друга.',
    ],
    ['f_depth', 'Актуальность и глубина: Преподаватель давал глубокие, современные и применимые на практике знания.'],
    [
      'f_materials',
      'Учебно-методическое обеспечение: Преподаватель предоставил все необходимые материалы для подготовки ' +
        '(презентации, списки литературы, задания, материалы в LMS).',
    ],
    [
      'f_workload',
      'Ритмичность и нагрузка: Объем домашних заданий и текущего контроля распределялся равномерно ' +
        'в течение семестра (без авралов под конец).',
    ],
    [
      'f_clarity',
      'Доступность и наглядность изложения: Преподаватель объяснял даже самые сложные темы понятно, уверенно и с яркими примерами.',
    ],
    [
      'f_engagement',
      'Вовлечение и динамика: Преподаватель умел удержать внимание аудитории, стимулировал вопросы и втягивал студентов в дискуссию.',
    ],
    [
      'f_punctuality',
      'Организованность и пунктуальность: Занятия всегда начинались и заканчивались вовремя, ' +
        'срывы и переносы без предупреждения отсутствовали.',
    ],
    [
      'f_style',
      'Уважение и педагогический такт: Преподаватель относился к студентам корректно, уважительно и соблюдал этику общения.',
    ],
    [
      'f_consultations',
      'Доступность для консультаций: Преподаватель был готов ответить на возникающие вопросы во время занятий ' +
        'или в отведенное для консультаций время/переписке.',
    ],
    [
      'f_fairness',
      'Прозрачность правил: Требования к зачету/экзамену и система накопления баллов были четко объявлены ' +
        'в начале курса и не менялись.',
    ],
    [
      'f_feedback',
      'Качество обратной связи: Преподаватель подробнее разбирал ошибки в выполненных работах ' +
        'и давал полезные рекомендации по их исправлению.',
    ],
    [
      'f_objectivity',
      'Объективность и беспристрастность: Оценки выставлены справедливо, исключительно на основе знаний ' +
        'и выполненной работы, без предвзятости.',
    ],
    [
      'f_benefit',
      'Польза курса: Данная дисциплина существенно расширила мои профессиональные/академические компетенции.',
    ],
    ['f_overall', 'Общее впечатление: Я высоко оцениваю работу преподавателя по данному курсу.'],
    [
      'f_recommend',
      'Рекомендация: Я бы рекомендовал(а) пройти этот курс под руководством этого преподавателя другим студентам.',
    ],
    [
      'f_strengths',
      'Сильные стороны преподавателя: Что на ваш взгляд является ключевым преимуществом преподавания данного лектора ' +
        '(подход, подача, авторитет, юмор, примеры из практики)?',
    ],
    [
      'f_improve',
      'Зоны роста / предложения: Что бы вы посоветовали преподавателю изменить или скорректировать ' +
        'в проведении этого курса в будущем?',
    ],
    [
      'f_memorable',
      'Незабываемый момент: Какой элемент курса (конкретная тема, практическое задание, дискуссия, случай на занятии) ' +
        'вам запомнился больше всего и почему?',
    ],
  ];

  const actual = FORMS.final.sections.flatMap((s) => s.questions).map((q) => [q.key, q.label]);

  assert.deepEqual(actual, expected);
});

test('прежние ключи сохранены там, где смысл пункта совпал', () => {
  const lessonKeys = getScaleQuestions('lesson').map((q) => q.key);
  for (const key of ['l_goals', 'l_logic', 'l_visual', 'l_atmosphere', 'l_pace', 'l_org']) {
    assert.ok(lessonKeys.includes(key), `в анкете по занятию потерялся ключ ${key}`);
  }
  const finalKeys = getScaleQuestions('final').map((q) => q.key);
  for (const key of [
    'f_theory_practice',
    'f_depth',
    'f_materials',
    'f_workload',
    'f_style',
    'f_fairness',
    'f_feedback',
    'f_overall',
    'f_recommend',
  ]) {
    assert.ok(finalKeys.includes(key), `в итоговой анкете потерялся ключ ${key}`);
  }
  assert.ok(getTextQuestions('lesson').some((q) => q.key === 'l_liked'));
  assert.ok(getTextQuestions('lesson').some((q) => q.key === 'l_improve'));
  assert.ok(getTextQuestions('final').some((q) => q.key === 'f_improve'));
});

test('пунктов, которых нет в PDF, в анкетах не осталось — они вынесены в устаревшие', () => {
  const allKeys = Object.keys(questionLabels());
  for (const removed of ['l_wishes', 'f_useful', 'f_difficult', 'f_wishes']) {
    assert.ok(!allKeys.includes(removed), `${removed} не должен оставаться в анкете`);
  }
  const legacyKeys = [...getLegacyQuestions('lesson'), ...getLegacyQuestions('final')].map((q) => q.key);
  assert.deepEqual(legacyKeys.sort(), ['f_difficult', 'f_useful', 'f_wishes', 'l_wishes']);
  assert.deepEqual(Object.keys(LEGACY_QUESTIONS).sort(), ['final', 'lesson']);

  // Подписи устаревших пунктов доступны — они нужны для отчётов и CSV по старым ответам.
  const withLegacy = questionLabels(undefined, { includeLegacy: true });
  assert.ok(withLegacy.l_wishes.label.length > 0);
  assert.equal(withLegacy.l_wishes.legacy, true);
  assert.equal(withLegacy.f_wishes.form_type, 'final');
});

test('у пунктов нет пояснений и подсказок — только вопрос и шкала', () => {
  for (const type of Object.keys(FORMS)) {
    for (const section of FORMS[type].sections) {
      for (const q of section.questions) {
        assert.equal(q.hint, undefined, `у пункта ${q.key} не должно быть пояснения`);
        assert.equal(q.placeholder, undefined, `у пункта ${q.key} не должно быть подсказки-примера`);
        if (q.kind === 'text') assert.equal(q.maxLength, 2000);
      }
    }
  }
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

test('шкала описана для всех значений 1..5 и соответствует PDF', () => {
  for (const type of Object.keys(FORMS)) {
    const form = FORMS[type];
    for (let score = 1; score <= 5; score += 1) {
      assert.ok(form.scaleLabels[score], `нет подписи для оценки ${score}`);
      assert.ok(form.scaleShortLabels[score]);
      assert.ok(form.scaleWords[score]);
    }
    assert.equal(form.scaleLabels[1], 'Совершенно не согласен');
    assert.equal(form.scaleLabels[5], 'Полностью согласен');
    assert.equal(form.scaleShortLabels[1], '1 — совершенно не согласен');
    assert.equal(form.scaleShortLabels[5], '5 — полностью согласен');
  }
});

test('в списке форм для интерфейса есть состав и число пунктов', () => {
  const lesson = FORM_LIST.find((f) => f.key === 'lesson');
  const final = FORM_LIST.find((f) => f.key === 'final');
  assert.equal(lesson.questionCount, 14);
  assert.equal(lesson.scaleCount, 12);
  assert.equal(final.questionCount, 18);
  assert.equal(final.scaleCount, 15);
});
