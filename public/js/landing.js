/** Главная страница: каталог дисциплин, поиск, информационные блоки. */

import { api, el, mount, clear, debounce, toast, plural } from './api.js';

const listNode = document.querySelector('#catalog-list');
const statusNode = document.querySelector('#catalog-status');
const countNode = document.querySelector('#catalog-count');
const searchNode = document.querySelector('#catalog-search');

function tile(discipline) {
  const topicsLabel = `${discipline.topics_count} ${plural(
    discipline.topics_count,
    'тема',
    'темы',
    'тем'
  )}`;

  return el(
    'a',
    {
      class: 'tile',
      attrs: { href: `/form.html?discipline=${discipline.id}` },
    },
    [
      el('span', { class: 'tile-title', text: discipline.title }),
      el('span', { class: 'tile-meta' }, [
        discipline.code ? el('span', { class: 'badge', text: discipline.code }) : null,
        el('span', { class: 'badge badge-brand', text: topicsLabel }),
        discipline.teacher_name
          ? el('span', { text: `Преподаватель: ${discipline.teacher_name}` })
          : null,
      ]),
      el('span', { class: 'tile-meta' }, [
        el('span', { text: 'Заполнить анкету' }),
        el('span', { class: 'chev', text: '→', attrs: { 'aria-hidden': 'true' } }),
      ]),
    ]
  );
}

function renderEmpty(searchTerm) {
  mount(statusNode, null);
  mount(listNode, [
    el('div', { class: 'card empty' }, [
      el('div', { class: 'empty-mark', text: '🔍', attrs: { 'aria-hidden': 'true' } }),
      el('p', {
        text: searchTerm
          ? 'По вашему запросу ничего не найдено. Попробуйте изменить формулировку.'
          : 'Пока ни одна дисциплина не открыта для анкетирования.',
      }),
      el('p', {
        class: 'small muted',
        text: 'Дисциплины и темы добавляет администратор — обратитесь к ответственному за опросы.',
      }),
    ]),
  ]);
}

function renderLoading() {
  mount(listNode, [
    el('div', { class: 'card' }, [el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })]),
    el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]),
  ]);
}

let currentSearch = '';

async function loadDisciplines() {
  renderLoading();
  try {
    const url = currentSearch
      ? `/api/disciplines?q=${encodeURIComponent(currentSearch)}`
      : '/api/disciplines';
    const data = await api.get(url);
    const disciplines = data.disciplines || [];

    clear(statusNode);
    countNode.textContent = disciplines.length
      ? `найдено: ${disciplines.length}`
      : '';

    if (disciplines.length === 0) {
      renderEmpty(currentSearch);
      return;
    }
    mount(
      listNode,
      disciplines.map(tile)
    );
  } catch (error) {
    clear(statusNode);
    mount(listNode, null);
    mount(statusNode, el('div', { class: 'alert alert-danger', text: error.message }));
    toast(error.message, 'danger');
  }
}

async function loadPrivacy() {
  const collects = document.querySelector('#privacy-collects');
  const notCollects = document.querySelector('#privacy-not');
  const note = document.querySelector('#privacy-note');
  try {
    const data = await api.get('/api/privacy');
    mount(collects, (data.collects || []).map((item) => el('li', { text: item })));
    mount(notCollects, (data.does_not_collect || []).map((item) => el('li', { text: item })));
    note.textContent = data.note || '';
  } catch {
    mount(collects, el('li', { text: 'Информация временно недоступна' }));
  }
}

searchNode.addEventListener(
  'input',
  debounce((event) => {
    currentSearch = event.target.value.trim();
    loadDisciplines();
  }, 250)
);

loadDisciplines();
loadPrivacy();
