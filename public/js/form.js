/**
 * Заполнение анкеты студентом.
 *
 * На странице только:
 *   - селект «Дисциплина»;
 *   - селект «Тема занятия» (показывается только для анкеты по занятию);
 *   - вопросы (масштаб 1..5 и открытые ответы);
 *   - кнопка «Отправить».
 *
 * Тип анкеты приходит из URL: ?form=lesson (по занятию) или ?form=final (итоговая).
 *
 * Приватность: ничего не пишем в localStorage/sessionStorage, cookie не используем,
 * никаких данных о студенте не отправляем. Единственная «метка» — время начала
 * заполнения, оно живёт в памяти вкладки и нужно анти-бот проверке.
 */

import { api, el, mount, clear, setParams, qsParam, toast } from './api.js';

const MAX_TEXT = 2000;

const state = {
  disciplines: [],
  discipline: null,
  topics: [],
  formType: null,
  form: null,
  topic: null,
  scores: new Map(),
  comments: new Map(),
  startedAt: null,
  submitting: false,
};

const titleNode = document.querySelector('#form-title');
const alertsNode = document.querySelector('#alerts');
const surveyNode = document.querySelector('#survey');
const disciplineSelect = document.querySelector('#discipline-select');
const topicField = document.querySelector('#topic-field');
const topicSelect = document.querySelector('#topic-select');

/* ------------------------------ вспомогательное ------------------------------ */

function alertBox(message, kind = 'info') {
  if (!message) {
    clear(alertsNode);
    return;
  }
  mount(alertsNode, el('div', { class: `alert alert-${kind}`, attrs: { role: 'alert' }, text: message }));
}

function optionText(discipline) {
  return discipline.code ? `${discipline.title} (${discipline.code})` : discipline.title;
}

function topicText(topic) {
  return topic.lesson_date ? `${topic.lesson_date} — ${topic.title}` : topic.title;
}

function fillDisciplineSelect() {
  mount(disciplineSelect, [
    el('option', { text: '— выберите дисциплину —', attrs: { value: '' } }),
    ...state.disciplines.map((discipline) =>
      el('option', { text: optionText(discipline), attrs: { value: String(discipline.id) } })
    ),
  ]);
  disciplineSelect.value = state.discipline ? String(state.discipline.id) : '';
}

function fillTopicSelect() {
  mount(topicSelect, [
    el('option', { text: '— выберите тему занятия —', attrs: { value: '' } }),
    ...state.topics.map((topic) =>
      el('option', { text: topicText(topic), attrs: { value: String(topic.id) } })
    ),
  ]);
  topicSelect.value = state.topic ? String(state.topic.id) : '';
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------ пункты анкеты ------------------------------ */

function scaleQuestion(question) {
  const groupName = `q_${question.key}`;
  const wrapper = el('div', { class: 'question', dataset: { key: question.key } });

  wrapper.append(el('div', { class: 'question-label', text: question.label }));

  const scale = el('div', {
    class: 'scale',
    attrs: { role: 'radiogroup', 'aria-label': question.label },
  });

  for (let score = 1; score <= 5; score += 1) {
    const inputId = `${groupName}_${score}`;
    const input = el('input', {
      attrs: { type: 'radio', name: groupName, id: inputId, value: String(score) },
      on: {
        change: () => {
          state.scores.set(question.key, score);
          wrapper.classList.remove('invalid');
          const errorNode = wrapper.querySelector('.error-text');
          if (errorNode) errorNode.textContent = '';
        },
      },
    });
    if (state.scores.get(question.key) === score) input.checked = true;

    scale.append(
      input,
      el('label', { attrs: { for: inputId } }, [
        el('span', { text: String(score) }),
      ])
    );
  }

  wrapper.append(scale, el('div', { class: 'error-text', attrs: { role: 'alert' } }));
  return wrapper;
}

function textQuestion(question) {
  const wrapper = el('div', { class: 'question', dataset: { key: question.key } });
  const textareaId = `text_${question.key}`;
  const limit = question.max_length || MAX_TEXT;

  const textarea = el('textarea', {
    class: 'textarea',
    attrs: { id: textareaId, maxlength: String(limit), rows: '4' },
    on: {
      input: (event) => {
        state.comments.set(question.key, event.target.value);
      },
    },
  });
  const saved = state.comments.get(question.key);
  if (saved) textarea.value = saved;

  wrapper.append(
    el('label', { class: 'question-label', text: question.label, attrs: { for: textareaId } }),
    textarea
  );
  return wrapper;
}

function allScaleQuestions() {
  return state.form.sections.flatMap((section) => section.questions).filter((q) => q.kind === 'scale');
}

/* ------------------------------ отрисовка анкеты ------------------------------ */

function surveyReady() {
  if (!state.discipline || !state.form) return false;
  if (state.formType === 'lesson' && !state.topic) return false;
  return true;
}

function renderSurvey() {
  const needsTopic = state.formType === 'lesson';
  topicField.hidden = !needsTopic;

  if (!state.form) {
    clear(surveyNode);
    return;
  }

  titleNode.textContent = state.form.title;
  document.title = state.form.title;

  if (!surveyReady()) {
    clear(surveyNode);
    if (needsTopic && state.discipline && state.topics.length === 0) {
      alertBox('Для этой дисциплины темы занятий не добавлены.', 'warn');
    }
    return;
  }

  if (!state.startedAt) state.startedAt = Date.now();

  const sections = state.form.sections.map((section) => {
    const nodes = section.questions.map((question) =>
      question.kind === 'scale' ? scaleQuestion(question) : textQuestion(question)
    );
    return el('section', { class: 'survey-section' }, [el('h2', { text: section.title }), ...nodes]);
  });

  // Honeypot: скрытое поле, которое заполняют только боты
  const honeypot = el('input', {
    class: 'honeypot',
    attrs: {
      type: 'text',
      name: 'contact_email',
      id: 'contact_email',
      tabindex: '-1',
      autocomplete: 'off',
      'aria-hidden': 'true',
    },
  });

  const submitButton = el('button', {
    class: 'btn btn-primary btn-lg btn-submit',
    text: 'Отправить',
    attrs: { type: 'submit', id: 'submit-button' },
  });

  const form = el('form', { attrs: { novalidate: true }, on: { submit: onSubmit } }, [
    ...sections,
    submitButton,
    honeypot,
  ]);

  mount(surveyNode, form);
}

/* ------------------------------ отправка ------------------------------ */

async function onSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;

  const button = document.querySelector('#submit-button');
  const unanswered = allScaleQuestions().filter((q) => !state.scores.has(q.key));

  if (unanswered.length > 0) {
    for (const question of unanswered) {
      const node = surveyNode.querySelector(`[data-key="${question.key}"]`);
      if (!node) continue;
      node.classList.add('invalid');
      const errorNode = node.querySelector('.error-text');
      if (errorNode) errorNode.textContent = 'Выберите оценку от 1 до 5';
    }
    const first = surveyNode.querySelector(`[data-key="${unanswered[0].key}"]`);
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    alertBox(`Без оценки осталось пунктов: ${unanswered.length}`, 'warn');
    return;
  }

  const scores = {};
  for (const question of allScaleQuestions()) scores[question.key] = state.scores.get(question.key);

  const comments = {};
  for (const [key, value] of state.comments.entries()) {
    const trimmed = String(value || '').trim();
    if (trimmed) comments[key] = trimmed;
  }

  const payload = {
    discipline_id: state.discipline.id,
    topic_id: state.formType === 'lesson' && state.topic ? state.topic.id : null,
    form_type: state.formType,
    scores,
    comments,
    started_at: state.startedAt || Date.now(),
    contact_email: document.querySelector('#contact_email')?.value || '',
  };

  state.submitting = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Отправка…';
  }
  alertBox('');

  try {
    await api.post('/api/responses', payload);
    state.scores.clear();
    state.comments.clear();
    state.startedAt = Date.now();
    alertBox('Ответ отправлен. Спасибо.', 'ok');
    renderSurvey();
    scrollTop();
  } catch (error) {
    alertBox(error.message, 'danger');
    toast(error.message, 'danger');
  } finally {
    state.submitting = false;
    const fresh = document.querySelector('#submit-button');
    if (fresh) {
      fresh.disabled = false;
      fresh.textContent = 'Отправить';
    }
  }
}

/* ------------------------------ выбор дисциплины и темы ------------------------------ */

async function selectDiscipline(id) {
  const discipline = state.disciplines.find((d) => String(d.id) === String(id)) || null;
  if (!discipline) {
    state.discipline = null;
    state.topics = [];
    state.topic = null;
    return;
  }
  const data = await api.get(`/api/disciplines/${encodeURIComponent(discipline.id)}`);
  state.discipline = { ...data.discipline, teacher_name: discipline.teacher_name };
  state.topics = data.discipline.topics || [];
  state.topic = null;
  fillTopicSelect();
}

function resetAnswers() {
  state.scores.clear();
  state.comments.clear();
  state.startedAt = null;
}

async function onDisciplineChange() {
  alertBox('');
  resetAnswers();
  try {
    await selectDiscipline(disciplineSelect.value);
  } catch (error) {
    alertBox(error.message, 'danger');
    return;
  }
  setParams({ discipline: disciplineSelect.value || null, topic: null });
  renderSurvey();
}

function onTopicChange() {
  alertBox('');
  resetAnswers();
  const id = Number(topicSelect.value);
  state.topic = state.topics.find((t) => t.id === id) || null;
  setParams({ topic: state.topic ? state.topic.id : null });
  renderSurvey();
}

/* ------------------------------ запуск ------------------------------ */

async function init() {
  disciplineSelect.addEventListener('change', onDisciplineChange);
  topicSelect.addEventListener('change', onTopicChange);

  // Тип анкеты задаётся URL (?form=lesson|final). Без него — 404 отдаём, чтобы
  // студент не залип на пустой форме.
  const requested = qsParam('form');
  if (requested !== 'lesson' && requested !== 'final') {
    alertBox('Выберите тип анкеты на главной странице.', 'warn');
    return;
  }
  state.formType = requested;

  try {
    const data = await api.get('/api/disciplines');
    state.disciplines = data.disciplines || [];
  } catch (error) {
    alertBox(error.message, 'danger');
    return;
  }

  if (state.disciplines.length === 0) {
    alertBox('Анкетирование пока не открыто.', 'warn');
    disciplineSelect.disabled = true;
    return;
  }

  fillDisciplineSelect();

  try {
    state.form = await api.get(`/api/forms/${encodeURIComponent(state.formType)}`);
  } catch (error) {
    alertBox(error.message, 'danger');
    return;
  }

  const disciplineParam = qsParam('discipline');
  if (disciplineParam) {
    disciplineSelect.value = String(disciplineParam);
    if (disciplineSelect.value === String(disciplineParam)) {
      try {
        await selectDiscipline(disciplineParam);
      } catch (error) {
        alertBox(error.message, 'danger');
      }
    }
  }

  const topicParam = qsParam('topic');
  if (topicParam && state.formType === 'lesson') {
    const topicId = Number(topicParam);
    state.topic = state.topics.find((t) => t.id === topicId) || null;
    fillTopicSelect();
  }

  renderSurvey();
}

init();
