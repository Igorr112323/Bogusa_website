/**
 * Заполнение анкеты студентом (мобильная версия).
 *
 * Приватность: в localStorage/sessionStorage ничего не пишем, cookie не используем,
 * никаких данных о студенте не отправляем. Единственная «метка» — время начала
 * заполнения, оно живёт в памяти вкладки и служит анти-бот проверкой.
 */

import { api, el, mount, clear, setParams, qsParam, toast } from './api.js';

const MAX_TEXT = 2000;

const state = {
  step: 'discipline', // discipline | form | questions | done
  disciplines: [],
  discipline: null,
  topics: [],
  formTypes: [],
  formType: null,
  topic: null,
  form: null, // структура анкеты с сервера
  scores: new Map(),
  comments: new Map(),
  startedAt: null,
  submitting: false,
};

const stepsNode = document.querySelector('#steps');
const contentNode = document.querySelector('#step-content');
const actionsNode = document.querySelector('#actions');
const alertsNode = document.querySelector('#alerts');
const subtitleNode = document.querySelector('#header-subtitle');

/* ------------------------------ вспомогательное ------------------------------ */

function alertBox(message, kind = 'info') {
  if (!message) {
    clear(alertsNode);
    return;
  }
  mount(alertsNode, el('div', { class: `alert alert-${kind}`, attrs: { role: 'alert' }, text: message }));
}

function renderSteps() {
  const order = ['discipline', 'form', 'questions'];
  const labels = { discipline: 'Дисциплина', form: 'Анкета', questions: 'Вопросы' };
  const currentIndex = order.indexOf(state.step === 'done' ? 'questions' : state.step);

  mount(
    stepsNode,
    order.map((key, index) =>
      el(
        'span',
        {
          class: `step ${index === currentIndex ? 'active' : ''} ${index < currentIndex ? 'done' : ''}`,
        },
        [
          el('span', { class: 'step-dot', text: index < currentIndex ? '✓' : String(index + 1) }),
          el('span', { text: labels[key] }),
        ]
      )
    )
  );
}

function setActions(children) {
  mount(actionsNode, children);
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadDisciplines() {
  const data = await api.get('/api/disciplines');
  state.disciplines = data.disciplines || [];
  return state.disciplines;
}

async function loadFormStructure(formType) {
  return api.get(`/api/forms/${encodeURIComponent(formType)}`);
}

async function loadDiscipline(id) {
  const data = await api.get(`/api/disciplines/${encodeURIComponent(id)}`);
  state.discipline = data.discipline;
  state.topics = data.discipline.topics || [];
  return state.discipline;
}

/* ------------------------------ Шаг 1: дисциплина ------------------------------ */

function renderDisciplineStep() {
  state.step = 'discipline';
  renderSteps();
  alertBox('');
  subtitleNode.textContent = 'шаг 1 из 3 · выбор дисциплины';

  const select = el('select', {
    class: 'select',
    attrs: { id: 'discipline-select', required: true },
    on: {
      change: (event) => {
        const id = Number(event.target.value);
        state.discipline = state.disciplines.find((d) => d.id === id) || null;
      },
    },
  });

  select.append(el('option', { text: '— выберите дисциплину —', attrs: { value: '' } }));
  for (const discipline of state.disciplines) {
    const label = discipline.code ? `${discipline.title} (${discipline.code})` : discipline.title;
    select.append(el('option', { text: label, attrs: { value: String(discipline.id) } }));
  }
  if (state.discipline) select.value = String(state.discipline.id);

  const statusNode = el('div');

  const card = el('div', { class: 'card' }, [
    el('h1', { text: 'Выберите дисциплину' }),
    el('p', {
      class: 'soft small',
      text: 'Анкета анонимная: мы не спрашиваем ФИО, номер группы и не сохраняем IP-адрес в базе.',
    }),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Дисциплина', attrs: { for: 'discipline-select' } }),
      select,
      el('span', {
        class: 'hint',
        text: 'Если нужной дисциплины нет в списке, значит она ещё не открыта для анкетирования.',
      }),
    ]),
    statusNode,
  ]);

  mount(contentNode, card);

  setActions([
    el('button', {
      class: 'btn btn-primary btn-lg',
      text: 'Продолжить',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          const id = Number(select.value);
          if (!id) {
            statusNode.replaceChildren(el('div', { class: 'alert alert-warn', text: 'Выберите дисциплину из списка' }));
            select.classList.add('invalid');
            return;
          }
          select.classList.remove('invalid');
          statusNode.replaceChildren();
          try {
            await loadDiscipline(id);
            setParams({ discipline: id });
            state.step = 'form';
            renderFormStep();
            scrollTop();
          } catch (error) {
            statusNode.replaceChildren(el('div', { class: 'alert alert-danger', text: error.message }));
          }
        },
      },
    }),
  ]);
}

/* ------------------------------ Шаг 2: тема и тип анкеты ------------------------------ */

function renderFormStep() {
  state.step = 'form';
  renderSteps();
  alertBox('');
  subtitleNode.textContent = 'шаг 2 из 3 · выбор анкеты';

  if (state.topics.length === 0) {
    mount(contentNode, [
      el('div', { class: 'card' }, [
        el('h1', { text: 'Анкетирование пока не открыто' }),
        el('p', {
          class: 'soft',
          text: 'Для этой дисциплины ещё не добавлены темы занятий. Сообщите об этом преподавателю.',
        }),
        el('a', { class: 'btn btn-ghost', attrs: { href: '/' }, text: '← Вернуться к списку дисциплин' }),
      ]),
    ]);
    setActions([]);
    return;
  }

  // Тип анкеты
  const typeCards = [
    {
      key: 'lesson',
      title: 'Анкета по занятию',
      text: 'Оценка конкретного проведённого занятия: цели, логика, наглядность, атмосфера, темп, организация.',
    },
    {
      key: 'final',
      title: 'Итоговая по дисциплине',
      text: 'Оценка курса в целом и работы ведущего преподавателя: материалы, нагрузка, оценивание, обратная связь.',
    },
  ].map((item) => {
    const button = el(
      'button',
      {
        class: 'tile',
        attrs: { type: 'button', 'aria-pressed': state.formType === item.key ? 'true' : 'false' },
      },
      [
        el('span', { class: 'tile-title', text: item.title }),
        el('span', { class: 'tile-meta' }, [el('span', { text: item.text })]),
      ]
    );
    if (state.formType === item.key) button.classList.add('tile-active');
    button.addEventListener('click', async () => {
      state.formType = item.key;
      state.form = await loadFormStructure(item.key);
      setParams({ form: item.key });
      renderFormStep();
    });
    return button;
  });

  // Темы (только для анкеты по занятию)
  const topicSelect = el('select', {
    class: 'select',
    attrs: { id: 'topic-select' },
    on: {
      change: (event) => {
        const id = Number(event.target.value);
        state.topic = state.topics.find((t) => t.id === id) || null;
      },
    },
  });
  topicSelect.append(el('option', { text: '— выберите тему занятия —', attrs: { value: '' } }));
  for (const topic of state.topics) {
    const label = topic.lesson_date ? `${topic.lesson_date} · ${topic.title}` : topic.title;
    topicSelect.append(el('option', { text: label, attrs: { value: String(topic.id) } }));
  }
  if (state.topic) topicSelect.value = String(state.topic.id);

  const topicBlock = el('div', { class: 'field' }, [
    el('label', { class: 'label', text: 'Тема занятия', attrs: { for: 'topic-select' } }),
    topicSelect,
    el('span', { class: 'hint', text: 'Для итоговой анкеты тема не требуется — оценивается вся дисциплина.' }),
  ]);

  const statusNode = el('div');
  const needsTopic = state.formType === 'lesson';
  if (topicBlock) topicBlock.classList.toggle('hidden', !needsTopic);

  mount(contentNode, [
    el('div', { class: 'card' }, [
      el('h1', { text: 'Что оцениваем?' }),
      el('p', { class: 'soft small' }, [
        `Дисциплина: ${state.discipline.title}`,
        state.discipline.teacher_name ? ` · Преподаватель: ${state.discipline.teacher_name}` : '',
      ]),
      el('div', { class: 'card-list' }, typeCards),
    ]),
    el('div', { class: 'card' }, [
      state.form
        ? el('div', {}, [
            el('h2', { text: state.form.title }),
            el('p', { class: 'soft small', text: state.form.intro }),
            el('p', { class: 'tiny muted', text: `${state.form.scale_count} пунктов по шкале 1–5 и ${state.form.text_count} открытых вопроса. Открытые можно пропустить.` }),
          ])
        : el('p', { class: 'muted', text: 'Выберите тип анкеты, чтобы увидеть состав вопросов.' }),
      needsTopic ? topicBlock : null,
      statusNode,
    ]),
  ]);

  setActions([
    el('button', {
      class: 'btn btn-ghost',
      text: '← Назад',
      attrs: { type: 'button' },
      on: {
        click: () => {
          setParams({ discipline: state.discipline ? state.discipline.id : null, form: null, topic: null });
          renderDisciplineStep();
          scrollTop();
        },
      },
    }),
    el('button', {
      class: 'btn btn-primary btn-lg',
      text: 'Перейти к вопросам',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (!state.formType || !state.form) {
            statusNode.replaceChildren(el('div', { class: 'alert alert-warn', text: 'Сначала выберите тип анкеты' }));
            return;
          }
          if (state.formType === 'lesson' && !topicSelect.value) {
            topicSelect.classList.add('invalid');
            statusNode.replaceChildren(el('div', { class: 'alert alert-warn', text: 'Выберите тему занятия' }));
            return;
          }
          topicSelect.classList.remove('invalid');
          if (state.formType === 'lesson') {
            const id = Number(topicSelect.value);
            state.topic = state.topics.find((t) => t.id === id) || null;
            setParams({ topic: id });
          } else {
            state.topic = null;
            setParams({ topic: null });
          }
          state.startedAt = Date.now();
          renderQuestionsStep();
          scrollTop();
        },
      },
    }),
  ]);
}

/* ------------------------------ Шаг 3: вопросы ------------------------------ */

function scaleQuestion(question, index, total) {
  const groupName = `q_${question.key}`;
  const wrapper = el('div', { class: 'question', dataset: { key: question.key } });

  wrapper.append(
    el('div', { class: 'question-label' }, [
      el('span', { class: 'muted mono tiny', text: `${index + 1}/${total} ` }),
      question.label,
    ])
  );
  if (question.hint) wrapper.append(el('div', { class: 'question-hint', text: question.hint }));

  const scale = el('div', {
    class: 'scale',
    attrs: { role: 'radiogroup', 'aria-label': question.label },
  });

  for (let score = 1; score <= 5; score += 1) {
    const inputId = `${groupName}_${score}`;
    const input = el('input', {
      attrs: {
        type: 'radio',
        name: groupName,
        id: inputId,
        value: String(score),
      },
      on: {
        change: () => {
          state.scores.set(question.key, score);
          wrapper.classList.remove('invalid');
          const errorNode = wrapper.querySelector('.error-text');
          if (errorNode) errorNode.textContent = '';
          updateProgress();
        },
      },
    });
    if (state.scores.get(question.key) === score) input.checked = true;

    const label = el('label', { attrs: { for: inputId } }, [
      el('span', { text: String(score) }),
      el('span', { class: 'scale-word', text: state.form.scale_words?.[score] || '' }),
    ]);

    scale.append(input, label);
  }

  wrapper.append(scale);
  wrapper.append(el('div', { class: 'error-text', attrs: { role: 'alert' } }));
  return wrapper;
}

function textQuestion(question) {
  const wrapper = el('div', { class: 'question', dataset: { key: question.key } });
  const textareaId = `text_${question.key}`;

  wrapper.append(
    el('label', { class: 'question-label', text: question.label, attrs: { for: textareaId } })
  );

  const counter = el('div', { class: 'counter', text: `0 / ${MAX_TEXT}` });
  const textarea = el('textarea', {
    class: 'textarea',
    attrs: {
      id: textareaId,
      maxlength: String(MAX_TEXT),
      placeholder: question.placeholder || 'Ваш ответ (необязательно)',
      rows: '3',
    },
    on: {
      input: (event) => {
        const value = event.target.value;
        state.comments.set(question.key, value);
        counter.textContent = `${value.length} / ${MAX_TEXT}`;
      },
    },
  });
  const existing = state.comments.get(question.key);
  if (existing) {
    textarea.value = existing;
    counter.textContent = `${existing.length} / ${MAX_TEXT}`;
  }

  wrapper.append(
    textarea,
    el('div', { class: 'counter-row' }, [counter]),
    el('span', { class: 'hint', text: 'Необязательный вопрос — можно оставить пустым.' })
  );
  return wrapper;
}

function allScaleQuestions() {
  return state.form.sections.flatMap((section) => section.questions).filter((q) => q.kind === 'scale');
}

function updateProgress() {
  const total = allScaleQuestions().length;
  const answered = allScaleQuestions().filter((q) => state.scores.has(q.key)).length;
  const fill = document.querySelector('#progress-fill');
  const label = document.querySelector('#progress-label');
  if (fill) fill.style.setProperty('width', `${total ? Math.round((answered / total) * 100) : 0}%`);
  if (label) label.textContent = `Заполнено ${answered} из ${total}`;
}

function renderQuestionsStep() {
  state.step = 'questions';
  renderSteps();
  alertBox('');
  subtitleNode.textContent = state.formType === 'lesson' ? 'анкета по занятию' : 'итоговая анкета';

  const sections = state.form.sections.map((section) => {
    const scaleQuestions = section.questions.filter((q) => q.kind === 'scale');
    const textQuestions = section.questions.filter((q) => q.kind === 'text');
    const nodes = [];
    scaleQuestions.forEach((question, index) => nodes.push(scaleQuestion(question, index, scaleQuestions.length)));
    textQuestions.forEach((question) => nodes.push(textQuestion(question)));
    return el('section', { class: 'card' }, [el('h2', { text: section.title }), ...nodes]);
  });

  const contextLine = [
    state.discipline ? state.discipline.title : '',
    state.topic ? `· ${state.topic.title}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  mount(contentNode, [
    el('div', { class: 'card card-tight' }, [
      el('div', { class: 'small soft', text: contextLine }),
      el('div', { class: 'tiny muted', text: 'Все пункты шкалы обязательны, открытые вопросы — по желанию.' }),
      el('div', { class: 'progress' }, [el('div', { class: 'progress-fill', attrs: { id: 'progress-fill' } })]),
      el('div', { class: 'tiny muted', attrs: { id: 'progress-label' }, text: 'Заполнено 0 из 0' }),
    ]),
    ...sections,
    el('div', { class: 'card card-tight' }, [
      el('p', { class: 'tiny muted', text: 'Отправляя анкету, вы подтверждаете, что она заполнена добровольно и анонимно.' }),
    ]),
  ]);

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
  contentNode.append(honeypot);

  updateProgress();

  setActions([
    el('button', {
      class: 'btn btn-ghost',
      text: '← Изменить выбор',
      attrs: { type: 'button' },
      on: {
        click: () => {
          renderFormStep();
          scrollTop();
        },
      },
    }),
    el('button', {
      class: 'btn btn-primary btn-lg',
      text: 'Отправить анонимно',
      attrs: { type: 'button', id: 'submit-button' },
      on: { click: submit },
    }),
  ]);
}

/* ------------------------------ Отправка ------------------------------ */

async function submit() {
  if (state.submitting) return;
  const button = document.querySelector('#submit-button');

  const unanswered = allScaleQuestions().filter((q) => !state.scores.has(q.key));
  if (unanswered.length > 0) {
    for (const question of unanswered) {
      const node = contentNode.querySelector(`[data-key="${question.key}"]`);
      if (node) {
        node.classList.add('invalid');
        const errorNode = node.querySelector('.error-text');
        if (errorNode) errorNode.textContent = 'Выберите оценку от 1 до 5';
      }
    }
    const first = contentNode.querySelector(`[data-key="${unanswered[0].key}"]`);
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    alertBox(`Не заполнено пунктов: ${unanswered.length}. Отметьте оценку в каждом пункте шкалы.`, 'warn');
    toast('Часть пунктов осталась без оценки', 'danger');
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
    button.textContent = 'Отправляем…';
  }
  alertBox('');

  try {
    await api.post('/api/responses', payload);
    renderSuccess();
  } catch (error) {
    alertBox(error.message, 'danger');
    toast(error.message, 'danger');
    if (button) {
      button.disabled = false;
      button.textContent = 'Отправить анонимно';
    }
  } finally {
    state.submitting = false;
  }
}

function renderSuccess() {
  state.step = 'done';
  renderSteps();
  setActions([]);
  subtitleNode.textContent = 'ответ отправлен';
  clear(alertsNode);

  const again = el('button', {
    class: 'btn btn-primary',
    text: 'Заполнить ещё одну анкету',
    attrs: { type: 'button' },
    on: {
      click: () => {
        state.scores.clear();
        state.comments.clear();
        state.formType = null;
        state.form = null;
        state.topic = null;
        state.startedAt = null;
        setParams({ discipline: null, topic: null, form: null });
        renderDisciplineStep();
        scrollTop();
      },
    },
  });

  mount(contentNode, [
    el('div', { class: 'card center' }, [
      el('div', { class: 'empty-mark', text: '✓', attrs: { 'aria-hidden': 'true' } }),
      el('h1', { text: 'Спасибо! Анкета отправлена анонимно' }),
      el('p', {
        class: 'soft',
        text: 'Преподаватель увидит только обобщённые оценки и текст комментариев. Связь ответа с вами установить невозможно.',
      }),
      el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, [
        again,
        el('a', { class: 'btn btn-ghost', attrs: { href: '/' }, text: 'На главную' }),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Что дальше?' }),
      el('ul', { class: 'privacy-list' }, [
        el('li', { text: 'Ответ сразу попал в обезличенную статистику дисциплины.' }),
        el('li', { text: 'Комментарии преподаватель читает без имён и групп.' }),
        el('li', { text: 'Если нужно оценить другое занятие — нажмите «Заполнить ещё одну анкету».' }),
      ]),
    ]),
  ]);
}

/* ------------------------------ Инициализация ------------------------------ */

async function init() {
  renderSteps();
  try {
    state.formTypes = (await api.get('/api/meta')).forms || [];
  } catch {
    state.formTypes = [];
  }

  const disciplineParam = qsParam('discipline');
  const topicParam = qsParam('topic');
  const formParam = qsParam('form');

  try {
    await loadDisciplines();
  } catch (error) {
    alertBox(error.message, 'danger');
    return;
  }

  if (state.disciplines.length === 0) {
    mount(contentNode, [
      el('div', { class: 'card empty' }, [
        el('div', { class: 'empty-mark', text: '📋', attrs: { 'aria-hidden': 'true' } }),
        el('h1', { text: 'Анкетирование пока закрыто' }),
        el('p', { text: 'Администратор ещё не открыл ни одной дисциплины. Загляните позже.' }),
        el('a', { class: 'btn btn-ghost', attrs: { href: '/' }, text: 'На главную' }),
      ]),
    ]);
    setActions([]);
    return;
  }

  if (disciplineParam) {
    const found = state.disciplines.find((d) => String(d.id) === String(disciplineParam));
    if (found) {
      try {
        await loadDiscipline(found.id);
        state.discipline = { ...state.discipline, teacher_name: found.teacher_name };

        if (formParam === 'lesson' || formParam === 'final') {
          state.formType = formParam;
          state.form = await loadFormStructure(formParam);
          if (formParam === 'lesson' && topicParam) {
            state.topic = state.topics.find((t) => String(t.id) === String(topicParam)) || null;
          }
          // Прямая ссылка из QR: сразу к вопросам (тема для итоговой анкеты не нужна)
          if (formParam === 'final' || state.topic) {
            state.startedAt = Date.now();
            renderQuestionsStep();
            return;
          }
          renderFormStep();
          return;
        }
        state.step = 'form';
        renderFormStep();
        return;
      } catch (error) {
        alertBox(`${error.message}. Выберите дисциплину вручную.`, 'warn');
      }
    }
  }

  renderDisciplineStep();
}

init();
