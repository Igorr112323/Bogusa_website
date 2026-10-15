/**
 * Портал преподавателя: обзор, отчёты по дисциплинам и занятиям,
 * комментарии студентов, выгрузка CSV, смена пароля.
 */

import {
  api,
  el,
  mount,
  clear,
  toast,
  setLoading,
  fmtDate,
  fmtDateTime,
  fmtNum,
  plural,
  scoreClass,
  qsParam,
  setParams,
  copyText,
  loadToken,
  clearToken,
  loadStudentBase,
  studentUrl,
} from './api.js';
import { distributionBars, timelineChart, positiveBar } from './charts.js';

const state = {
  user: null,
  view: 'overview',
  disciplines: [],
  filters: { disciplineId: null, topicId: null, formType: null, from: '', to: '' },
};

const root = document.querySelector('#view-root');
const alertsNode = document.querySelector('#view-alerts');
const sideNav = document.querySelector('#side-nav');
const topTabs = document.querySelector('#top-tabs');
const userBadge = document.querySelector('#user-badge');
const sidebarNote = document.querySelector('#sidebar-note');

const VIEWS = [
  { key: 'overview', label: 'Обзор' },
  { key: 'report', label: 'Отчёт по дисциплине' },
  { key: 'comments', label: 'Отзывы студентов' },
  { key: 'password', label: 'Пароль' },
];

/* ------------------------------ каркас ------------------------------ */

function setAlert(message, kind = 'info') {
  if (!message) {
    clear(alertsNode);
    return;
  }
  mount(alertsNode, el('div', { class: `alert alert-${kind}`, attrs: { role: 'alert' }, text: message }));
}

function renderNav() {
  const make = (view) =>
    el(
      'button',
      {
        attrs: { type: 'button', 'aria-current': state.view === view.key ? 'true' : 'false' },
        on: { click: () => go(view.key) },
      },
      view.label
    );

  mount(sideNav, VIEWS.map(make));
  mount(topTabs, VIEWS.map(make));
}

function go(view, params = {}) {
  state.view = view;
  renderNav();
  setParams({ view, ...params });
  if (view === 'overview') return renderOverview();
  if (view === 'report') return renderReport();
  if (view === 'comments') return renderComments();
  return renderPassword();
}

function pageHead(title, subtitle, actions = []) {
  return el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: title }), subtitle ? el('div', { class: 'sub', text: subtitle }) : null]),
    actions.length > 0 ? el('div', { class: 'btn-row' }, actions) : null,
  ]);
}

const exportUrl = (base, filters) => {
  const params = new URLSearchParams();
  if (filters.disciplineId) params.set('discipline_id', filters.disciplineId);
  if (filters.topicId) params.set('topic_id', filters.topicId);
  if (filters.formType) params.set('form_type', filters.formType);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const query = params.toString();
  return `${base}${query ? `?${query}` : ''}`;
};

function statCard(label, value, sub) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

function scoreCell(value, count) {
  return el('td', { class: 'num' }, [
    el('span', { class: scoreClass(value), text: value === null ? '—' : fmtNum(value, 2) }),
    count !== undefined ? el('span', { class: 'tiny muted', text: ` из 5 · n=${count}` }) : null,
  ]);
}

/* ------------------------------ Обзор ------------------------------ */

async function renderOverview() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    const data = await api.get('/api/teacher/overview');
    const { totals } = data;

    const disciplineRows = data.disciplines.map((discipline) =>
      el('tr', {}, [
        el('td', {}, [
          el('div', { text: discipline.title }),
          el('div', { class: 'tiny muted' }, [
            discipline.code ? `${discipline.code} · ` : '',
            `${discipline.topics_count} ${plural(discipline.topics_count, 'тема', 'темы', 'тем')}`,
            discipline.is_active ? '' : ' · выключена',
          ]),
        ]),
        el('td', { class: 'num', text: String(discipline.responses || 0) }),
        el('td', { class: 'num' }, [
          el('span', { class: scoreClass(discipline.avg), text: discipline.avg === null ? '—' : fmtNum(discipline.avg, 2) }),
        ]),
        el('td', { class: 'num' }, [
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Отчёт',
            attrs: { type: 'button' },
            on: {
              click: () => {
                state.filters.disciplineId = discipline.id;
                go('report', { discipline: discipline.id });
              },
            },
          }),
        ]),
      ])
    );

    const topicRows = (data.topics || []).slice(0, 12).map((topic) =>
      el('tr', {}, [
        el('td', {}, [
          el('div', { text: topic.title }),
          el('div', { class: 'tiny muted', text: topic.discipline_title }),
        ]),
        el('td', { class: 'num', text: topic.lesson_date || '—' }),
        el('td', { class: 'num' }, [
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Отчёт по занятию',
            attrs: { type: 'button' },
            on: {
              click: () => {
                state.filters.topicId = topic.id;
                go('report', { topic: topic.id, discipline: topic.discipline_id });
              },
            },
          }),
        ]),
      ])
    );

    mount(root, [
      pageHead('Обзор', state.user.role === 'admin' ? 'Все преподаватели и дисциплины' : 'Ваши дисциплины и ответы студентов', [
        el('a', {
          class: 'btn btn-sm btn-ghost',
          attrs: { href: exportUrl('/api/teacher/export.csv', {}) },
          text: 'Выгрузить всё в CSV',
        }),
      ]),
      el('div', { class: 'stats' }, [
        statCard('Всего анкет', String(totals.responses ?? 0), `за 30 дней: ${data.timeline?.slice(-30).reduce((acc, p) => acc + p.responses, 0) ?? 0}`),
        statCard('Средний балл', totals.overall_avg === null ? '—' : fmtNum(totals.overall_avg, 2), 'по всем пунктам шкалы'),
        statCard('По занятиям', String(totals.lesson ?? 0), 'анкет «по занятию»'),
        statCard('Итоговых', String(totals.final ?? 0), 'анкет по дисциплине'),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [
          el('h2', { text: 'Динамика ответов и среднего балла' }),
          el('span', { class: 'tiny muted', text: totals.last_response_at ? `последний ответ: ${fmtDateTime(totals.last_response_at)}` : '' }),
        ]),
        el('div', { class: 'card' }, [timelineChart(data.timeline || [])]),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [el('h2', { text: 'Мои дисциплины' })]),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Дисциплина' }),
                el('th', { class: 'num', text: 'Анкет' }),
                el('th', { class: 'num', text: 'Средний балл' }),
                el('th', { class: 'num', text: '' }),
              ]),
            ]),
            el('tbody', {}, disciplineRows),
          ]),
        ]),
        data.disciplines.length === 0
          ? el('div', { class: 'card empty', text: 'Дисциплины ещё не закреплены за вами. Обратитесь к администратору.' })
          : null,
      ]),
      topicRows.length > 0
        ? el('section', { class: 'section' }, [
            el('div', { class: 'section-title' }, [el('h2', { text: 'Последние занятия' })]),
            el('div', { class: 'table-wrap' }, [
              el('table', { class: 'table' }, [
                el('thead', {}, [
                  el('tr', {}, [
                    el('th', { text: 'Тема' }),
                    el('th', { class: 'num', text: 'Дата' }),
                    el('th', { class: 'num', text: '' }),
                  ]),
                ]),
                el('tbody', {}, topicRows),
              ]),
            ]),
          ])
        : null,
      el('section', { class: 'section' }, [
        el('div', { class: 'card card-tight' }, [
          el('h3', { text: 'Как читать отчёт' }),
          el('ul', { class: 'privacy-list small' }, [
            el('li', { text: 'Средний балл считается по всем ответам выбранного типа анкеты.' }),
            el('li', { text: 'Комментарии показываются без имён и групп — их невозможно связать с автором.' }),
            el('li', { text: 'Если ответов мало, результаты скрываются, чтобы нельзя было вычислить автора.' }),
          ]),
        ]),
      ]),
    ]);

    if (state.user.role === 'admin') {
      mount(sidebarNote, [
        el('p', { class: 'small muted', text: 'Вы вошли как администратор: доступны все дисциплины и преподаватели.' }),
        el('a', { class: 'btn btn-sm btn-ghost btn-block', attrs: { href: '/admin/' }, text: 'В админ-панель' }),
      ]);
    } else {
      mount(sidebarNote, [
        el('p', { class: 'small muted', text: 'Нужна ссылка или QR-код для студентов? Смотрите раздел «Отчёт по дисциплине».' }),
      ]);
    }
  } catch (error) {
    setAlert(error.message, 'danger');
    if (error.status === 401) {
      window.location.replace('/login?next=/portal/');
      return;
    }
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить данные. Обновите страницу.' }));
  }
}

/* ------------------------------ Отчёт ------------------------------ */

function filterBar({ onChange, disciplines, formType, from, to, topicId }) {
  const disciplineSelect = el('select', {
    class: 'select',
    attrs: { id: 'filter-discipline' },
    on: {
      change: (event) => {
        const value = event.target.value ? Number(event.target.value) : null;
        state.filters = { ...state.filters, disciplineId: value, topicId: null };
        onChange();
      },
    },
  });
  disciplineSelect.append(el('option', { text: 'Все мои дисциплины', attrs: { value: '' } }));
  for (const discipline of disciplines) {
    disciplineSelect.append(el('option', { text: discipline.title, attrs: { value: String(discipline.id) } }));
  }
  if (state.filters.disciplineId) disciplineSelect.value = String(state.filters.disciplineId);

  const formSelect = el('select', {
    class: 'select',
    on: {
      change: (event) => {
        state.filters = { ...state.filters, formType: event.target.value || null };
        onChange();
      },
    },
  });
  formSelect.append(el('option', { text: 'Оба типа анкет', attrs: { value: '' } }));
  formSelect.append(el('option', { text: 'Анкета по занятию', attrs: { value: 'lesson' } }));
  formSelect.append(el('option', { text: 'Итоговая по дисциплине', attrs: { value: 'final' } }));
  if (state.filters.formType) formSelect.value = state.filters.formType;

  const fromInput = el('input', {
    class: 'input',
    attrs: { type: 'date', value: state.filters.from || '' },
    on: {
      change: (event) => {
        state.filters = { ...state.filters, from: event.target.value };
        onChange();
      },
    },
  });
  const toInput = el('input', {
    class: 'input',
    attrs: { type: 'date', value: state.filters.to || '' },
    on: {
      change: (event) => {
        state.filters = { ...state.filters, to: event.target.value };
        onChange();
      },
    },
  });

  const bar = el('div', { class: 'filter-bar' }, [
    el('div', { class: 'field' }, [
      el('label', { text: 'Дисциплина', attrs: { for: 'filter-discipline' } }),
      disciplineSelect,
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Тип анкеты' }), formSelect]),
    el('div', { class: 'field' }, [el('label', { text: 'С даты' }), fromInput]),
    el('div', { class: 'field' }, [el('label', { text: 'По дату' }), toInput]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Сбросить',
        attrs: { type: 'button' },
        on: {
          click: () => {
            state.filters = { disciplineId: null, topicId: null, formType: null, from: '', to: '' };
            onChange();
          },
        },
      }),
      el('a', {
        class: 'btn btn-sm btn-primary',
        text: 'Скачать CSV',
        attrs: { href: exportUrl('/api/teacher/export.csv', state.filters) },
      }),
    ]),
  ]);
  if (topicId) bar.append(el('div', { class: 'field' }, [el('label', { text: 'Занятие' }), el('div', { class: 'badge badge-brand', text: `тема #${topicId}` })]));
  return bar;
}

async function renderReport() {
  if (!state.filters.disciplineId && !state.filters.topicId) {
    state.filters.disciplineId = state.disciplines[0]?.id ?? null;
  }

  const rerender = () => {
    setParams({
      discipline: state.filters.disciplineId,
      topic: state.filters.topicId,
      form: state.filters.formType,
      from: state.filters.from || null,
      to: state.filters.to || null,
    });
    renderReport();
  };

  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  try {
    const base = state.filters.topicId
      ? `/api/teacher/topics/${state.filters.topicId}/report`
      : `/api/teacher/disciplines/${state.filters.disciplineId}/report`;

    const query = new URLSearchParams();
    if (state.filters.formType) query.set('form_type', state.filters.formType);
    if (state.filters.from) query.set('from', state.filters.from);
    if (state.filters.to) query.set('to', state.filters.to);
    const report = await api.get(`${base}${query.toString() ? `?${query}` : ''}`);

    const title = report.topic
      ? `Отчёт по занятию: ${report.topic.title}`
      : report.discipline
        ? `Отчёт: ${report.discipline.title}`
        : 'Отчёт';

    const subtitle = [
      report.topic?.discipline_title,
      report.topic?.lesson_date ? `дата занятия: ${report.topic.lesson_date}` : null,
      `собрано анкет: ${report.total_responses}`,
    ]
      .filter(Boolean)
      .join(' · ');

    const formBlocks = report.forms.map((form) => {
      const rows = form.questions.map((question) =>
        el('div', { class: 'question-row' }, [
          el('div', {}, [
            el('div', { class: 'q-label', text: question.label }),
            question.hint ? el('div', { class: 'tiny muted', text: question.hint }) : null,
            el('div', { style: { 'margin-top': '8px' } }, [positiveBar(question.positive_ratio)]),
          ]),
          distributionBars(question.distribution, question.count),
          el('div', { class: 'center' }, [
            el('div', { class: scoreClass(question.avg), text: question.avg === null ? '—' : fmtNum(question.avg, 2) }),
            el('div', { class: 'tiny muted', text: `ответов: ${question.count}` }),
          ]),
        ])
      );

      const commentGroups = [...form.comments, ...(form.archived_comments || [])].map((group) =>
        el('div', { class: 'comment-group card' }, [
          el('h3', {}, [
            el('span', { text: group.label }),
            group.legacy ? el('span', { class: 'badge', text: 'вопрос снят с анкеты' }) : null,
            el('span', { class: 'badge badge-brand', text: String(group.items.length) }),
          ]),
          ...group.items.map((item) =>
            el('div', { class: 'comment' }, [
              el('div', { class: 'comment-body', text: item.body }),
              el('div', { class: 'comment-meta' }, [
                el('span', { text: `отправлено: ${fmtDate(item.created_date)}` }),
                item.topic_title ? el('span', { text: item.topic_title }) : null,
                item.discipline_title && !report.topic ? el('span', { text: item.discipline_title }) : null,
              ]),
            ])
          ),
        ])
      );

      return el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [
          el('h2', { text: form.title }),
          el('span', { class: 'badge', text: `анкет: ${form.responses}` }),
          form.avg_of_items !== null
            ? el('span', { class: `badge ${form.avg_of_items >= 4 ? 'badge-ok' : 'badge-brand'}`, text: `средний балл: ${fmtNum(form.avg_of_items, 2)}` })
            : null,
        ]),
        el('div', { class: 'card card-tight' }, rows),
        commentGroups.length > 0
          ? el('div', { class: 'section' }, [
              el('div', { class: 'section-title' }, [el('h2', { text: 'Комментарии студентов' })]),
              el('div', { class: 'comments-grid' }, commentGroups),
            ])
          : el('div', { class: 'card empty', text: 'Текстовых комментариев по этой анкете пока нет.' }),
      ]);
    });

    const lessonsBlock =
      report.lessons && report.lessons.length > 0 && !report.topic
        ? el('section', { class: 'section' }, [
            el('div', { class: 'section-title' }, [
              el('h2', { text: 'Разбивка по занятиям' }),
              el('span', { class: 'tiny muted', text: 'нажмите на занятие, чтобы открыть его отчёт' }),
            ]),
            el('div', { class: 'table-wrap' }, [
              el('table', { class: 'table' }, [
                el('thead', {}, [
                  el('tr', {}, [
                    el('th', { text: 'Тема занятия' }),
                    el('th', { class: 'num', text: 'Дата' }),
                    el('th', { class: 'num', text: 'Анкет' }),
                    el('th', { class: 'num', text: 'Средний балл' }),
                    el('th', { class: 'num', text: '' }),
                  ]),
                ]),
                el(
                  'tbody',
                  {},
                  report.lessons.map((lesson) =>
                    el('tr', {}, [
                      el('td', { text: lesson.topic_title || '—' }),
                      el('td', { class: 'num', text: lesson.lesson_date || '—' }),
                      el('td', { class: 'num', text: String(lesson.responses) }),
                      el('td', { class: 'num' }, [
                        el('span', { class: scoreClass(lesson.avg), text: lesson.avg === null ? '—' : fmtNum(lesson.avg, 2) }),
                      ]),
                      el('td', { class: 'num' }, [
                        el('button', {
                          class: 'btn btn-sm btn-ghost',
                          text: 'Открыть',
                          attrs: { type: 'button' },
                          on: {
                            click: () => {
                              state.filters.topicId = lesson.topic_id;
                              state.filters.disciplineId = lesson.discipline_id;
                              rerender();
                            },
                          },
                        }),
                      ]),
                    ])
                  )
                ),
              ]),
            ]),
          ])
        : null;

    mount(root, [
      pageHead(title, subtitle, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Печать / PDF',
          attrs: { type: 'button' },
          on: { click: () => window.print() },
        }),
        el('a', {
          class: 'btn btn-sm btn-primary',
          text: 'Скачать CSV',
          attrs: { href: exportUrl('/api/teacher/export.csv', state.filters) },
        }),
      ]),
      report.total_responses === 0
        ? el('div', { class: 'alert alert-warn', text: 'По выбранным фильтрам пока нет ни одной анкеты.' })
        : null,
      report.hidden
        ? el('div', { class: 'alert alert-warn', text: report.min_answers_label || 'Результаты скрыты из-за малого числа ответов.' })
        : null,
      filterBar({
        onChange: rerender,
        disciplines: state.disciplines,
        topicId: state.filters.topicId,
      }),
      el('div', { class: 'card card-tight' }, [
        el('div', { class: 'stats' }, [
          statCard('Всего анкет', String(report.total_responses ?? 0)),
          statCard('Средний балл', report.overall_avg === null ? '—' : fmtNum(report.overall_avg, 2)),
          statCard('По занятиям', String(report.by_form?.lesson ?? 0)),
          statCard('Итоговых', String(report.by_form?.final ?? 0)),
        ]),
      ]),
      el('section', { class: 'section' }, [
        el('h2', { text: 'Динамика' }),
        el('div', { class: 'card' }, [timelineChart(report.timeline || [])]),
      ]),
      ...formBlocks,
      lessonsBlock,
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [el('h2', { text: 'Ссылка и QR-код для студентов' })]),
        linksCard(),
      ]),
    ].map((node) => node || null));
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось построить отчёт.' }));
  }
}

/** Карточка со ссылкой на анкету и QR-кодом (удобно показать группе с экрана). */
function linksCard() {
  const url = studentUrl('/form.html', {
    discipline: state.filters.disciplineId,
    topic: state.filters.topicId,
    form: state.filters.formType,
  });

  const input = el('input', { class: 'input', attrs: { value: url, readonly: true, 'aria-label': 'Ссылка на анкету' } });
  return el('div', { class: 'card' }, [
    el('p', { class: 'small soft', text: 'Отправьте студентам ссылку или покажите QR-код — регистрация не нужна.' }),
    el('div', { class: 'copy-row' }, [
      input,
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Скопировать',
        attrs: { type: 'button' },
        on: {
          click: async (event) => {
            const ok = await copyText(url);
            toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'danger');
            event.target.blur();
          },
        },
      }),
      el('a', { class: 'btn btn-sm btn-ghost', attrs: { href: url, target: '_blank', rel: 'noopener' }, text: 'Открыть' }),
    ]),
  ]);
}

/* ------------------------------ Отзывы ------------------------------ */

async function renderComments() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  const searchInput = el('input', {
    class: 'input',
    attrs: { type: 'search', placeholder: 'Поиск по тексту отзыва' },
  });
  const formSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Оба типа анкет', attrs: { value: '' } }),
    el('option', { text: 'По занятию', attrs: { value: 'lesson' } }),
    el('option', { text: 'Итоговая', attrs: { value: 'final' } }),
  ]);
  const listNode = el('div', { class: 'comments-grid' });

  const load = async () => {
    mount(listNode, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
    try {
      const params = new URLSearchParams();
      if (state.filters.disciplineId) params.set('discipline_id', state.filters.disciplineId);
      if (formSelect.value) params.set('form_type', formSelect.value);
      if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
      const data = await api.get(`/api/teacher/comments?${params}`);
      if (data.comments.length === 0) {
        mount(listNode, [
          el('div', { class: 'card empty' }, [
            el('p', { text: 'Комментариев пока нет. Студенты чаще пишут их в конце семестра.' }),
          ]),
        ]);
        return;
      }
      // группируем по вопросу
      const groups = new Map();
      for (const comment of data.comments) {
        if (!groups.has(comment.question_key)) groups.set(comment.question_key, []);
        groups.get(comment.question_key).push(comment);
      }
      mount(
        listNode,
        [...groups.entries()].map(([key, items]) =>
          el('div', { class: 'comment-group card' }, [
            el('h3', {}, [el('span', { text: items[0].question_label || key }), el('span', { class: 'badge badge-brand', text: String(items.length) })]),
            ...items.map((item) =>
              el('div', { class: 'comment' }, [
                el('div', { class: 'comment-body', text: item.body }),
                el('div', { class: 'comment-meta' }, [
                  el('span', { text: fmtDate(item.created_date) }),
                  item.discipline_title ? el('span', { text: item.discipline_title }) : null,
                  item.topic_title ? el('span', { text: item.topic_title }) : null,
                  el('span', { class: 'badge', text: item.form_type === 'lesson' ? 'по занятию' : 'итоговая' }),
                ]),
              ])
            ),
          ])
        )
      );
    } catch (error) {
      setAlert(error.message, 'danger');
      mount(listNode, null);
    }
  };

  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
  formSelect.addEventListener('change', load);

  mount(root, [
    pageHead('Отзывы студентов', 'Все текстовые ответы по вашим дисциплинам — без имён и групп'),
    el('div', { class: 'filter-bar' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Поиск' }), searchInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Тип анкеты' }), formSelect]),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Обновить',
          attrs: { type: 'button' },
          on: { click: load },
        }),
      ]),
    ]),
    listNode,
  ]);
  await load();
}

/* ------------------------------ Пароль ------------------------------ */

function renderPassword() {
  const current = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'current-password' } });
  const next = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'new-password' } });
  const repeat = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'new-password' } });

  const submit = el('button', {
    class: 'btn btn-primary',
    text: 'Сменить пароль',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        if (next.value.length < 10) return toast('Пароль должен быть не короче 10 символов', 'danger');
        if (next.value !== repeat.value) return toast('Пароли не совпадают', 'danger');
        setLoading(submit, true, 'Сохраняем…');
        try {
          await api.post('/api/auth/password', {
            current_password: current.value,
            new_password: next.value,
          });
          toast('Пароль изменён. Другие сессии завершены.', 'ok');
          current.value = '';
          next.value = '';
          repeat.value = '';
        } catch (error) {
          toast(error.message, 'danger');
        } finally {
          setLoading(submit, false);
        }
      },
    },
  });

  mount(root, [
    pageHead('Смена пароля', 'После смены пароля все другие устройства будут разлогинены'),
    el('div', { class: 'card' }, [
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Текущий пароль' }), current]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'Новый пароль' }),
        next,
        el('span', { class: 'hint', text: 'Минимум 10 символов, хотя бы два вида символов (буквы, цифры, знаки).' }),
      ]),
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Повторите новый пароль' }), repeat]),
      submit,
    ]),
  ]);
}

/* ------------------------------ Старт ------------------------------ */

document.querySelector('#logout-button').addEventListener('click', async () => {
  clearToken();
  try {
    await api.post('/api/auth/logout', {});
  } finally {
    window.location.replace('/login');
  }
});

(async function boot() {
  loadToken();
  // Ссылка на студенческий сайт ведёт на студенческий порт, а не на адрес панели.
  loadStudentBase().then(() => {
    const studentsLink = document.querySelector('#students-link');
    if (studentsLink) studentsLink.href = studentUrl('/');
  });
  try {
    const { user } = await api.get('/api/auth/me');
    if (!user) throw new Error('not authenticated');
    state.user = user;
    userBadge.textContent = `${user.full_name} · ${user.role === 'admin' ? 'администратор' : 'преподаватель'}`;
  } catch {
    window.location.replace('/login?next=/portal/');
    return;
  }

  if (state.user.must_change_password) {
    mount(root, el('div', { class: 'card' }, [
      el('h1', { text: 'Смените временный пароль' }),
      el('p', { class: 'soft', text: 'Пока пароль не изменён, отчёты недоступны.' }),
      el('a', { class: 'btn btn-primary', attrs: { href: '/login' }, text: 'Перейти к смене пароля' }),
    ]));
    return;
  }

  try {
    const data = await api.get('/api/teacher/disciplines');
    state.disciplines = data.disciplines || [];
  } catch (error) {
    setAlert(error.message, 'danger');
  }

  const viewParam = qsParam('view');
  state.view = VIEWS.some((v) => v.key === viewParam) ? viewParam : 'overview';
  if (qsParam('discipline')) state.filters.disciplineId = Number(qsParam('discipline'));
  if (qsParam('topic')) state.filters.topicId = Number(qsParam('topic'));
  if (qsParam('form')) state.filters.formType = qsParam('form');
  if (qsParam('from')) state.filters.from = qsParam('from');
  if (qsParam('to')) state.filters.to = qsParam('to');

  renderNav();
  go(state.view);
})();
