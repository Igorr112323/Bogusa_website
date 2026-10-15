'use strict';

/**
 * ОПРЕДЕЛЕНИЯ АНКЕТ.
 *
 * Это единственный файл, который нужно править, если формулировки вопросов
 * должны точно совпадать с PDF-анкетами. Ключи (`key`) менять нельзя для уже
 * собранных ответов — по ним хранятся оценки в БД.
 *
 * kind: 'scale' — оценка по шкале 1..5 (участвует в средних баллах)
 *       'text'  — открытый ответ (замечание / пожелание)
 */

const SCALE_LABELS = {
  1: 'Совсем нет',
  2: 'Скорее нет',
  3: 'Затрудняюсь ответить',
  4: 'Скорее да',
  5: 'Полностью да',
};

const SCALE_SHORT = {
  1: '1 — совсем нет',
  2: '2',
  3: '3',
  4: '4',
  5: '5 — полностью да',
};

/** Короткие подписи под цифрами — влезают в мобильную сетку из 5 кнопок. */
const SCALE_WORDS = {
  1: 'Нет',
  2: 'Скорее нет',
  3: 'Средне',
  4: 'Скорее да',
  5: 'Да',
};

const MAX_TEXT_LENGTH = 2000;

const FORMS = {
  lesson: {
    key: 'lesson',
    title: 'Анкета оценки качества проведённого занятия',
    shortTitle: 'Анкета по занятию',
    cardTitle: 'Оценить занятие',
    description:
      'Оцените прошедшее занятие по нескольким пунктам и напишите замечания или пожелания преподавателю. Анкета анонимная.',
    intro:
      'Отметьте, насколько Вы согласны с каждым утверждением, по шкале от 1 до 5: ' +
      '1 — совсем нет, 5 — полностью да. Открытые вопросы можно оставить пустыми.',
    scaleLabels: SCALE_LABELS,
    scaleShortLabels: SCALE_SHORT,
    scaleWords: SCALE_WORDS,
    sections: [
      {
        title: 'Оцените занятие по шкале от 1 до 5',
        questions: [
          {
            key: 'l_goals',
            kind: 'scale',
            label: 'Цели и задачи занятия были понятны',
            hint: 'были озвучены в начале, понятно, что должно быть освоено',
          },
          {
            key: 'l_logic',
            kind: 'scale',
            label: 'Материал излагался логично и последовательно',
            hint: 'структура занятия, переходы между блоками, связь с предыдущими темами',
          },
          {
            key: 'l_visual',
            kind: 'scale',
            label: 'Изложение было наглядным и подкреплено примерами',
            hint: 'презентация, схемы, задачи, практические примеры, раздаточный материал',
          },
          {
            key: 'l_atmosphere',
            kind: 'scale',
            label: 'Атмосфера на занятии была доброжелательной',
            hint: 'можно было задать вопрос, не страшно ошибиться, диалог со студентами',
          },
          {
            key: 'l_pace',
            kind: 'scale',
            label: 'Темп занятия был удобным',
            hint: 'успевали ли Вы понимать и записывать материал',
          },
          {
            key: 'l_org',
            kind: 'scale',
            label: 'Занятие было организовано хорошо',
            hint: 'пунктуальность, регламент, порядок, оборудование, работа в команде с группой',
          },
        ],
      },
      {
        title: 'Ваши замечания и пожелания',
        questions: [
          {
            key: 'l_liked',
            kind: 'text',
            label: 'Что на занятии было особенно полезным? Что понравилось?',
            placeholder: 'Например: подробный разбор задачи, живой диалог, понятные слайды…',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'l_improve',
            kind: 'text',
            label: 'Что стоит изменить, добавить или объяснить подробнее?',
            placeholder: 'Например: больше примеров, медленнее темп, больше практики…',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'l_wishes',
            kind: 'text',
            label: 'Пожелания преподавателю',
            placeholder: 'Свободная форма. Ваше сообщение будет передано преподавателю анонимно.',
            maxLength: MAX_TEXT_LENGTH,
          },
        ],
      },
    ],
  },

  final: {
    key: 'final',
    title: 'Итоговая анкета оценки дисциплины и работы ведущего преподавателя',
    shortTitle: 'Итоговая анкета по дисциплине',
    cardTitle: 'Оценить дисциплину',
    description:
      'Итоговая оценка дисциплины и работы преподавателя. Заполняется один раз в конце семестра. Анкета анонимная.',
    intro:
      'Отметьте, насколько Вы согласны с каждым утверждением, по шкале от 1 до 5: ' +
      '1 — совсем нет, 5 — полностью да. Открытые вопросы можно оставить пустыми.',
    scaleLabels: SCALE_LABELS,
    scaleShortLabels: SCALE_SHORT,
    scaleWords: SCALE_WORDS,
    sections: [
      {
        title: 'Оцените дисциплину по шкале от 1 до 5',
        questions: [
          {
            key: 'f_theory_practice',
            kind: 'scale',
            label: 'Лекции и практические занятия были связаны между собой',
            hint: 'теория подкреплялась практикой, задания соответствовали лекциям',
          },
          {
            key: 'f_depth',
            kind: 'scale',
            label: 'Материал излагался глубоко и содержательно',
            hint: 'достаточный уровень детализации, разбор сложных мест',
          },
          {
            key: 'f_materials',
            kind: 'scale',
            label: 'Учебные материалы были доступны и полезны',
            hint: 'презентации, методические указания, литература, записи, задания',
          },
          {
            key: 'f_workload',
            kind: 'scale',
            label: 'Нагрузка по дисциплине была посильной и равномерной',
            hint: 'объём заданий соответствовал времени и распределялся по семестру',
          },
          {
            key: 'f_style',
            kind: 'scale',
            label: 'Стиль работы преподавателя устраивал',
            hint: 'уважительное отношение, контакт с аудиторией, готовность помочь',
          },
          {
            key: 'f_fairness',
            kind: 'scale',
            label: 'Критерии оценивания были понятны и прозрачны',
            hint: 'заранее известно, как выставляется оценка, требования не менялись по ходу',
          },
          {
            key: 'f_feedback',
            kind: 'scale',
            label: 'Обратная связь по работам была своевременной и полезной',
            hint: 'комментарии к работам, разбор ошибок, возможность задать вопрос',
          },
          {
            key: 'f_overall',
            kind: 'scale',
            label: 'Общее впечатление от дисциплины положительное',
            hint: 'насколько в целом довольны изучением дисциплины',
          },
          {
            key: 'f_recommend',
            kind: 'scale',
            label: 'Порекомендовали бы дисциплину другим студентам',
            hint: '5 — точно да, 1 — точно нет',
          },
        ],
      },
      {
        title: 'Ваши замечания и пожелания',
        questions: [
          {
            key: 'f_useful',
            kind: 'text',
            label: 'Какие темы или задания оказались самыми полезными?',
            placeholder: 'Например: раздел о…, практические задания…',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'f_difficult',
            kind: 'text',
            label: 'Что вызывало затруднения?',
            placeholder: 'Например: темп, объём заданий, нехватка материалов…',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'f_improve',
            kind: 'text',
            label: 'Что стоит изменить в дисциплине?',
            placeholder: 'Замечания и предложения по организации курса',
            maxLength: MAX_TEXT_LENGTH,
          },
          {
            key: 'f_wishes',
            kind: 'text',
            label: 'Пожелания преподавателю',
            placeholder: 'Свободная форма. Ваше сообщение будет передано преподавателю анонимно.',
            maxLength: MAX_TEXT_LENGTH,
          },
        ],
      },
    ],
  },
};

/** Список форм для API (без лишних деталей). */
const FORM_LIST = Object.values(FORMS).map((form) => ({
  key: form.key,
  title: form.title,
  shortTitle: form.shortTitle,
  cardTitle: form.cardTitle,
  description: form.description,
  questionCount:
    form.sections.reduce((acc, s) => acc + s.questions.length, 0),
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

function getQuestion(formType, key) {
  const form = FORMS[formType];
  if (!form) return null;
  return form.sections.flatMap((s) => s.questions).find((q) => q.key === key) || null;
}

/** Словарь «ключ → подпись вопроса» для одного или всех типов анкет. */
function questionLabels(formTypes = Object.keys(FORMS)) {
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
  }
  return map;
}

const isFormType = (value) => Object.prototype.hasOwnProperty.call(FORMS, value);

module.exports = {
  FORMS,
  FORM_LIST,
  MAX_TEXT_LENGTH,
  SCALE_LABELS,
  SCALE_WORDS,
  questionLabels,
  getScaleQuestions,
  getTextQuestions,
  getQuestion,
  isFormType,
};
