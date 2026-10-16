/**
 * Главная страница студентов: список дисциплин, у каждой две плитки-"двери".
 * Занятие (янтарная дверь) и дисциплина (белая дверь). Выпадающих списков здесь нет.
 */

import { api, el, mount, plural } from './api.js';

const listNode = document.querySelector('#disciplines');
const statusNode = document.querySelector('#status');

function formHref(disciplineId, formType) {
  return `/form.html?discipline=${encodeURIComponent(disciplineId)}&form=${formType}`;
}

function lessonNote(discipline) {
  const topics = Number(discipline.topics_count) || 0;
  if (topics === 0) return 'темы занятий не добавлены';
  return plural(topics, 'тема занятия', 'темы занятия', 'тем занятия');
}

function finalNote(discipline) {
  return 'итоговая оценка курса';
}

function door(discipline, formType, title, note) {
  const disabled = formType === 'lesson' && (Number(discipline.topics_count) || 0) === 0;
  return el(
    'a',
    {
      class: `door${formType === 'lesson' ? ' door-accent' : ''}`,
      attrs: {
        href: disabled ? '' : formHref(discipline.id, formType),
        'aria-disabled': disabled ? 'true' : 'false',
      },
    },
    [el('span', { class: 'door-title', text: title }), el('span', { class: 'door-note', text: note })]
  );
}

function disciplineCard(discipline, showTeacher) {
  const head = el('div', { class: 'discipline-head' }, [
    el('h2', { class: 'discipline-title' }, [
      el('span', { text: discipline.title }),
      discipline.code ? el('span', { class: 'discipline-code', text: discipline.code }) : null,
    ]),
    showTeacher && discipline.teacher_name
      ? el('div', { class: 'discipline-teacher', text: discipline.teacher_name })
      : null,
  ]);

  return el('article', { class: 'discipline-card' }, [
    head,
    el('div', { class: 'doors' }, [
      door(discipline, 'lesson', 'Оценить занятие', lessonNote(discipline)),
      door(discipline, 'final', 'Оценить дисциплину', finalNote(discipline)),
    ]),
  ]);
}

async function init() {
  let showTeacher = true;
  try {
    const meta = await api.get('/api/meta');
    showTeacher = meta.show_teacher_name !== false;
  } catch {
    /* если метаданные недоступны - показываем только название дисциплины */
  }

  let disciplines = [];
  try {
    const data = await api.get('/api/disciplines');
    disciplines = data.disciplines || [];
  } catch (error) {
    mount(statusNode, el('div', { class: 'alert alert-danger', text: error.message }));
    return;
  }

  if (disciplines.length === 0) {
    mount(statusNode, el('p', { class: 'muted', text: 'Анкетирование пока не открыто.' }));
    return;
  }

  mount(listNode, disciplines.map((discipline) => disciplineCard(discipline, showTeacher)));
}

init();
