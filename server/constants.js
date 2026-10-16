'use strict';

const config = require('./config');

/** Сообщение о пороге анонимности (показывается, когда ответов слишком мало). */
const MIN_ANSWERS_LABEL =
  `Пока ответов слишком мало — результаты скрыты, чтобы нельзя было вычислить автора. ` +
  `Нужно не менее ${config.MIN_ANSWERS_TO_SHOW} заполненных анкет.`;

const FORM_TYPE_RU = {
  lesson: 'По занятию',
  final: 'Итоговая по дисциплине',
};

module.exports = { MIN_ANSWERS_LABEL, FORM_TYPE_RU };
