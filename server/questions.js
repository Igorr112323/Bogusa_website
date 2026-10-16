'use strict';

/**
 * ОПРЕДЕЛЕНИЯ АНКЕТ.
 *
 * Формулировки дословно соответствуют анкетам преподавателя:
 *   docs/anketa-zanyatie.pdf    — анкета оценки качества проведенного занятия
 *   docs/anketa-disciplina.pdf  — итоговая анкета оценки дисциплины
 *
 * Это единственный файл, который нужно править, если формулировки должны
 * совпадать с PDF. Ключи (`key`) уже собранных ответов менять нельзя: по ним
 * хранятся оценки в БД. Пункты, исключённые из анкет, перечислены в
 * LEGACY_QUESTIONS — ответы по ним остаются в базе и попадают в отчёты и
 * выгрузку CSV отдельной группой.
 *
 * kind: 'scale' — оценка по шкале 1..5 (участвует в средних баллах)
 *       'text'  — открытый ответ
 */

const SCALE_LABELS = {
  1: 'Совершенно не согласен',
  2: 'Скорее не согласен',
  3: 'Частично согласен',
  4: 'Скорее согласен',
  5: 'Полностью согласен',
};

const SCALE_SHORT = {
  1: '1 — совершенно не согласен',
  2: '2',
  3: '3',
  4: '4',
  5: '5 — полностью согласен',
};

/** Короткие подписи под цифрами — влезают в мобильную сетку из 5 кнопок. */
const SCALE_WORDS = {
  1: 'Не согласен',
  2: 'Скорее нет',
  3: 'Частично',
  4: 'Скорее да',
  5: 'Полностью',
};

/** Строка о шкале — общая для обеих анкет (как в PDF перед первым блоком). */
const SCALE_INTRO =
  'Оцените утверждения по шкале от 1 до 5, где 1 — совершенно не согласен, 5 — полностью согласен.';

const MAX_TEXT_LENGTH = 2000;

const FORMS = {
  lesson: {
    key: 'lesson',
    title: 'Анкета оценки качества проведенного занятия',
    subtitle:
      'Пожалуйста, оцените проведенное занятие. Опрос является полностью анонимным, ' +
      'а его результаты будут использованы для улучшения учебного процесса.',
    shortTitle: 'Анкета по занятию',
    cardTitle: 'Оценить занятие',
    description: 'Оценка проведенного занятия. Анкета анонимная.',
    intro: SCALE_INTRO,
    scaleLabels: SCALE_LABELS,
    scaleShortLabels: SCALE_SHORT,
    scaleWords: SCALE_WORDS,
    sections: [
      {
        title: 'Блок 1. Содержание и структура занятия',
        questions: [
          {
            key: 'l_goals',
            kind: 'scale',
            label: 'Понятность целей: В начале занятия были четко обозначены его тема и основные цели.',
          },
          {
            key: 'l_logic',
            kind: 'scale',
            label: 'Логика и структура: Материал излагался последовательно, логично и без хаотичных переходов.',
          },
          {
            key: 'l_relevance',
            kind: 'scale',
            label:
              'Актуальность и польза: Предложенный материал интересен, применим на практике ' +
              'или важен для освоения дисциплины.',
          },
          {
            key: 'l_visual',
            kind: 'scale',
            label:
              'Наглядность: Преподаватель эффективно использовал наглядные материалы ' +
              '(презентации, схемы, раздаточный материал, примеры на доске/экране).',
          },
          {
            key: 'l_examples',
            kind: 'scale',
            label:
              'Связь с теорией/практикой: Преподаватель приводил понятные жизненные ' +
              'или профессиональные примеры для иллюстрирования сложных тем.',
          },
        ],
      },
      {
        title: 'Блок 2. Преподавательское мастерство и атмосфера',
        questions: [
          {
            key: 'l_clarity',
            kind: 'scale',
            label: 'Доступность изложения: Преподаватель объясняет сложный материал простым и понятным языком.',
          },
          {
            key: 'l_attention',
            kind: 'scale',
            label: 'Удержание внимания: Преподаватель вел занятие динамично и умел удержать внимание аудитории.',
          },
          {
            key: 'l_interaction',
            kind: 'scale',
            label:
              'Взаимодействие с аудиторией: Преподаватель вовлекал студентов в обсуждение, ' +
              'задавал вопросы, побуждал к размышлению.',
          },
          {
            key: 'l_atmosphere',
            kind: 'scale',
            label:
              'Доброжелательность и такт: На занятии преобладала уважительная и комфортная атмосфера; ' +
              'преподаватель был открыт к вопросам.',
          },
          {
            key: 'l_pace',
            kind: 'scale',
            label: 'Темп подачи: Темп занятия был оптимальным (не слишком быстрый и не слишком затянутый).',
          },
        ],
      },
      {
        title: 'Блок 3. Организация и дисциплина',
        questions: [
          {
            key: 'l_org',
            kind: 'scale',
            label: 'Соблюдение регламента: Занятие началось и завершилось вовремя.',
          },
          {
            key: 'l_readiness',
            kind: 'scale',
            label: 'Готовность: Преподаватель был полностью подготовлен к занятию (материалы, оборудование, план).',
          },
        ],
      },
      {
        title: 'Блок 4. Открытые вопросы (необязательно, но желательно)',
        questions: [
          {
            key: 'l_liked',
            kind: 'text',
            label: 'Что вам больше всего понравилось на этом занятии?',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'l_improve',
            kind: 'text',
            label: 'Что, по вашему мнению, можно было бы улучшить или изменить в формате проведения?',
            maxLength: MAX_TEXT_LENGTH,
          },
        ],
      },
    ],
  },

  final: {
    key: 'final',
    title: 'Итоговая анкета оценки дисциплины и работы ведущего преподавателя',
    subtitle: '',
    shortTitle: 'Итоговая анкета по дисциплине',
    cardTitle: 'Оценить дисциплину',
    description: 'Итоговая оценка дисциплины и работы ведущего преподавателя. Анкета анонимная.',
    intro: SCALE_INTRO,
    scaleLabels: SCALE_LABELS,
    scaleShortLabels: SCALE_SHORT,
    scaleWords: SCALE_WORDS,
    sections: [
      {
        title: 'Блок 1. Содержание дисциплины и учебный процесс',
        questions: [
          {
            key: 'f_theory_practice',
            kind: 'scale',
            label:
              'Целостность курса: Лекционный материал и практические/лабораторные задания ' +
              'идеально дополняли друг друга.',
          },
          {
            key: 'f_depth',
            kind: 'scale',
            label: 'Актуальность и глубина: Преподаватель давал глубокие, современные и применимые на практике знания.',
          },
          {
            key: 'f_materials',
            kind: 'scale',
            label:
              'Учебно-методическое обеспечение: Преподаватель предоставил все необходимые материалы ' +
              'для подготовки (презентации, списки литературы, задания, материалы в LMS).',
          },
          {
            key: 'f_workload',
            kind: 'scale',
            label:
              'Ритмичность и нагрузка: Объем домашних заданий и текущего контроля распределялся равномерно ' +
              'в течение семестра (без авралов под конец).',
          },
        ],
      },
      {
        title: 'Блок 2. Преподавательское мастерство и стиль работы',
        questions: [
          {
            key: 'f_clarity',
            kind: 'scale',
            label:
              'Доступность и наглядность изложения: Преподаватель объяснял даже самые сложные темы понятно, ' +
              'уверенно и с яркими примерами.',
          },
          {
            key: 'f_engagement',
            kind: 'scale',
            label:
              'Вовлечение и динамика: Преподаватель умел удержать внимание аудитории, стимулировал вопросы ' +
              'и втягивал студентов в дискуссию.',
          },
          {
            key: 'f_punctuality',
            kind: 'scale',
            label:
              'Организованность и пунктуальность: Занятия всегда начинались и заканчивались вовремя, ' +
              'срывы и переносы без предупреждения отсутствовали.',
          },
          {
            key: 'f_style',
            kind: 'scale',
            label:
              'Уважение и педагогический такт: Преподаватель относился к студентам корректно, уважительно ' +
              'и соблюдал этику общения.',
          },
          {
            key: 'f_consultations',
            kind: 'scale',
            label:
              'Доступность для консультаций: Преподаватель был готов ответить на возникающие вопросы ' +
              'во время занятий или в отведенное для консультаций время/переписке.',
          },
        ],
      },
      {
        title: 'Блок 3. Оценивание и обратная связь',
        questions: [
          {
            key: 'f_fairness',
            kind: 'scale',
            label:
              'Прозрачность правил: Требования к зачету/экзамену и система накопления баллов были четко ' +
              'объявлены в начале курса и не менялись.',
          },
          {
            key: 'f_feedback',
            kind: 'scale',
            label:
              'Качество обратной связи: Преподаватель подробнее разбирал ошибки в выполненных работах ' +
              'и давал полезные рекомендации по их исправлению.',
          },
          {
            key: 'f_objectivity',
            kind: 'scale',
            label:
              'Объективность и беспристрастность: Оценки выставлены справедливо, исключительно на основе ' +
              'знаний и выполненной работы, без предвзятости.',
          },
        ],
      },
      {
        title: 'Блок 4. Общие итоги',
        questions: [
          {
            key: 'f_benefit',
            kind: 'scale',
            label:
              'Польза курса: Данная дисциплина существенно расширила мои профессиональные/академические компетенции.',
          },
          {
            key: 'f_overall',
            kind: 'scale',
            label: 'Общее впечатление: Я высоко оцениваю работу преподавателя по данному курсу.',
          },
          {
            key: 'f_recommend',
            kind: 'scale',
            label:
              'Рекомендация: Я бы рекомендовал(а) пройти этот курс под руководством этого преподавателя ' +
              'другим студентам.',
          },
        ],
      },
      {
        title: 'Блок 5. Открытые вопросы (качественная обратная связь)',
        questions: [
          {
            key: 'f_strengths',
            kind: 'text',
            label:
              'Сильные стороны преподавателя: Что на ваш взгляд является ключевым преимуществом преподавания ' +
              'данного лектора (подход, подача, авторитет, юмор, примеры из практики)?',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'f_improve',
            kind: 'text',
            label:
              'Зоны роста / предложения: Что бы вы посоветовали преподавателю изменить или скорректировать ' +
              'в проведении этого курса в будущем?',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'f_memorable',
            kind: 'text',
            label:
              'Незабываемый момент: Какой элемент курса (конкретная тема, практическое задание, дискуссия, ' +
              'случай на занятии) вам запомнился больше всего и почему?',
            maxLength: MAX_TEXT_LENGTH,
          },
        ],
      },
    ],
  },
};

/**
 * Пункты, которых больше нет в анкетах. Ответы по этим ключам остались в базе —
 * они показываются в отчётах и выгрузке отдельной группой, но в форму не попадают.
 */
const LEGACY_QUESTIONS = {
  lesson: [
    { key: 'l_wishes', kind: 'text', label: 'Пожелания преподавателю' },
  ],
  final: [
    { key: 'f_useful', kind: 'text', label: 'Какие темы или задания оказались самыми полезными?' },
    { key: 'f_difficult', kind: 'text', label: 'Что вызывало затруднения?' },
    { key: 'f_wishes', kind: 'text', label: 'Пожелания преподавателю' },
  ],
};

/** Список форм для API (без лишних деталей). */
const FORM_LIST = Object.values(FORMS).map((form) => ({
  key: form.key,
  title: form.title,
  shortTitle: form.shortTitle,
  cardTitle: form.cardTitle,
  description: form.description,
  questionCount: form.sections.reduce((acc, s) => acc + s.questions.length, 0),
  scaleCount: form.sections.reduce(
    (acc, s) => acc + s.questions.filter((q) => q.kind === 'scale').length,
    0
  ),
}));

function getScaleQuestions(formType) {
  const form = FORMS[formType];
  if (!form) return [];
  return form.sections
    .flatMap((s) => s.questions)
    .filter((q) => q.kind === 'scale');
}

function getTextQuestions(formType) {
  const form = FORMS[formType];
  if (!form) return [];
  return form.sections.flatMap((s) => s.questions).filter((q) => q.kind === 'text');
}

/** Снятые с анкеты пункты: нужны только для отчётов и выгрузки старых ответов. */
function getLegacyQuestions(formType) {
  return LEGACY_QUESTIONS[formType] || [];
}

function getQuestion(formType, key) {
  const form = FORMS[formType];
  if (!form) return null;
  return form.sections.flatMap((s) => s.questions).find((q) => q.key === key) || null;
}

/**
 * Словарь «ключ → подпись вопроса» для одного или всех типов анкет.
 * @param {string|string[]} formTypes
 * @param {{includeLegacy?: boolean}} options
 */
function questionLabels(formTypes = Object.keys(FORMS), options = {}) {
  const { includeLegacy = false } = options;
  const map = {};
  const list = Array.isArray(formTypes) ? formTypes : [formTypes];
  for (const type of list) {
    const form = FORMS[type];
    if (!form) continue;
    for (const section of form.sections) {
      for (const q of section.questions) {
        map[q.key] = {
          label: q.label,
          kind: q.kind,
          section: section.title,
          form_type: form.key,
        };
      }
    }
    if (includeLegacy) {
      for (const q of getLegacyQuestions(type)) {
        if (map[q.key]) continue;
        map[q.key] = {
          label: q.label,
          kind: q.kind,
          section: 'Снятые с анкеты вопросы',
          form_type: form.key,
          legacy: true,
        };
      }
    }
  }
  return map;
}

const isFormType = (value) => Object.prototype.hasOwnProperty.call(FORMS, value);

module.exports = {
  FORMS,
  FORM_LIST,
  LEGACY_QUESTIONS,
  MAX_TEXT_LENGTH,
  SCALE_LABELS,
  SCALE_WORDS,
  SCALE_INTRO,
  questionLabels,
  getScaleQuestions,
  getTextQuestions,
  getLegacyQuestions,
  getQuestion,
  isFormType,
};
