/** Главная страница студентов: выбор дисциплины и переход к анкете. */

import { api, el, mount } from './api.js';

const selectNode = document.querySelector('#discipline-select');
const linkNode = document.querySelector('#open-form');
const statusNode = document.querySelector('#status');

function optionText(discipline, showTeacher) {
  const parts = [discipline.title];
  if (discipline.code) parts.push(`(${discipline.code})`);
  if (showTeacher && discipline.teacher_name) parts.push(`— ${discipline.teacher_name}`);
  return parts.join(' ');
}

function updateLink() {
  const id = selectNode.value;
  linkNode.href = id ? `/form.html?discipline=${encodeURIComponent(id)}` : '/form.html';
}

async function init() {
  let showTeacher = true;
  try {
    const meta = await api.get('/api/meta');
    showTeacher = meta.show_teacher_name !== false;
  } catch {
    /* если метаданные недоступны — показываем только название дисциплины */
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
    linkNode.hidden = true;
    selectNode.disabled = true;
    mount(selectNode, el('option', { text: 'Дисциплин нет', attrs: { value: '' } }));
    mount(statusNode, el('p', { class: 'muted', text: 'Анкетирование пока не открыто.' }));
    return;
  }

  mount(selectNode, [
    el('option', { text: '— выберите дисциплину —', attrs: { value: '' } }),
    ...disciplines.map((discipline) =>
      el('option', {
        text: optionText(discipline, showTeacher),
        attrs: { value: String(discipline.id) },
      })
    ),
  ]);

  selectNode.addEventListener('change', updateLink);
  updateLink();
}

init();
