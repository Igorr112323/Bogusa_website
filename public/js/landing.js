/**
 * Главная страница студента: список дисциплин с двумя анкетами на каждую.
 *
 * На странице только название и две плитки-ссылки:
 *   - «Оценить занятие»   ведёт на /form.html?discipline=ID&form=lesson
 *   - «Оценить дисциплину» ведёт на /form.html?discipline=ID&form=final
 */

import { api, el, mount } from './api.js';

const root = document.querySelector('#status');

function tileHref(disciplineId, formType) {
  return `/form.html?discipline=${encodeURIComponent(disciplineId)}&form=${formType}`;
}

function tile(discipline, { primary, formType, title }) {
  return el(
    'a',
    {
      class: `landing-tile${primary ? ' landing-tile-primary' : ''}`,
      attrs: { href: tileHref(discipline.id, formType) },
    },
    [el('span', { class: 'landing-tile-title', text: title })]
  );
}

function emptyState() {
  mount(root, el('p', { class: 'muted', text: 'Анкетирование пока не открыто.' }));
}

function renderError(message) {
  mount(root, el('div', { class: 'alert alert-danger', text: message }));
}

async function init() {
  let data;
  try {
    data = await api.get('/api/disciplines');
  } catch (error) {
    renderError(error.message);
    return;
  }

  const disciplines = (data && data.disciplines) || [];
  if (disciplines.length === 0) {
    emptyState();
    return;
  }

  const cards = disciplines.map((discipline) => {
    return el('article', { class: 'card card-discipline' }, [
      el('h2', { class: 'card-discipline-title', text: discipline.title }),
      el('div', { class: 'landing-actions' }, [
        tile(discipline, {
          primary: true,
          formType: 'lesson',
          title: 'Оценить занятие',
        }),
        tile(discipline, {
          formType: 'final',
          title: 'Оценить дисциплину',
        }),
      ]),
    ]);
  });

  mount(root, cards);
}

init();
