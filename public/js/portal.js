/**
 * Портал преподавателя.
 *
 * Раздел Отчёт: сверху выбирается дисциплина, вид анкеты переключается двумя
 * крупными кнопками (как в самой анкете), для занятия ниже появляется список тем,
 * затем период, оценки по пунктам и комментарии студентов.
 * Раздел Мои темы: дисциплины и занятия, ссылка для группы.
 * Раздел Пароль: смена пароля.
 */

import {
  api,
  el,
  mount,
  clear,
  toast,
  setLoading,
  fmtDate,
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
  modal,
} from './api.js';
import { distributionBars, positiveBar } from './charts.js';

const state = {
  user: null,
  view: 'report',
  disciplines: [],
  news: { responses: 0, comments: 0 },
  filters: { disciplineId: null, topicId: null, formType: 'lesson', from: '', to: '' },
};

/** Фильтры внутри блока комментариев: работают по уже загруженным данным. */
const commentsFilter = { q: '', onlyNew: false };

const root = document.querySelector('#view-root');
const alertsNode = document.querySelector('#view-alerts');
const sideNav = document.querySelector('#side-nav');
const sideNavTop = document.querySelector('#side-nav-top');
const userBadge = document.querySelector('#user-badge');

/** Те же названия, что видит студент в анкете. */
const FORM_LABELS = {
  lesson: 'Анкета по занятию',
  final: 'Итоговая анкета по дисциплине',
};

const VIEWS = [
  { key: 'report', label: 'Отчёт', desc: 'оценки по пунктам, комментарии студентов, выгрузка CSV' },
  { key: 'catalog', label: 'Мои темы', desc: 'дисциплины, занятия и ссылка для группы' },
  { key: 'password', label: 'Пароль', desc: 'смена пароля для входа в кабинет' },
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
      [
        el('span', { text: view.label }),
        view.key === 'report' && state.news.responses > 0
          ? el('span', { class: 'nav-count', text: String(state.news.responses) })
          : null,
      ]
    );

  mount(sideNav, VIEWS.map(make));
  if (sideNavTop) mount(sideNavTop, VIEWS.map(make));
}

function go(view, params = {}) {
  state.view = view;
  renderNav();
  setParams({ view, ...params });
  if (view === 'catalog') return renderCatalog();
  if (view === 'password') return renderPassword();
  return renderReport();
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

/** Тема занятия в списках: сначала дата, потом название. */
const topicLabel = (topic) => (topic.lesson_date ? `${topic.lesson_date} · ${topic.title}` : topic.title);

const isoDay = (date) => date.toISOString().slice(0, 10);

/** Начало периода по быстрой кнопке: N дней назад или начало текущего семестра. */
function rangeStart(kind) {
  const now = new Date();
  if (kind === 'week') return isoDay(new Date(now.getTime() - 6 * 86400000));
  if (kind === 'month') return isoDay(new Date(now.getTime() - 29 * 86400000));
  const month = now.getMonth();
  if (month >= 8) return `${now.getFullYear()}-09-01`;
  if (month <= 1) return `${now.getFullYear()}-02-01`;
  return `${now.getFullYear() - 1}-09-01`;
}

async function reloadDisciplines() {
  const data = await api.get('/api/teacher/disciplines');
  state.disciplines = data.disciplines || [];
  state.news = {
    responses: data.new_responses_total ?? 0,
    comments: data.new_comments_total ?? 0,
  };
  return state.disciplines;
}

/* ------------------------------ Отчёт ------------------------------ */

/** Дисциплина в фокусе: всегда конкретная, режима все сразу здесь нет. */
function currentDiscipline() {
  return state.disciplines.find((d) => d.id === state.filters.disciplineId) || state.disciplines[0] || null;
}

function formSwitch(onPick) {
  return el(
    'div',
    { class: 'form-switch', attrs: { role: 'group', 'aria-label': 'Вид анкеты' } },
    Object.entries(FORM_LABELS).map(([key, label]) =>
      el('button', {
        class: 'btn btn-switch',
        attrs: { type: 'button', 'aria-pressed': state.filters.formType === key ? 'true' : 'false' },
        dataset: { form: key },
        text: label,
        on: { click: () => onPick(key) },
      })
    )
  );
}

function pickerCard(discipline, onChange) {
  const isLesson = state.filters.formType !== 'final';

  const pick = (patch) => {
    state.filters = { ...state.filters, ...patch };
    onChange();
  };

  const disciplineSelect = el('select', {
    class: 'select',
    attrs: { id: 'filter-discipline' },
    on: {
      change: (event) => pick({ disciplineId: Number(event.target.value), topicId: null }),
    },
  });
  for (const d of state.disciplines) {
    disciplineSelect.append(el('option', { text: d.is_active ? d.title : `${d.title} (выключена)`, attrs: { value: String(d.id) } }));
  }
  disciplineSelect.value = String(discipline.id);

  const topics = discipline.topics || [];
  const topicSelect = el('select', {
    class: 'select',
    attrs: { id: 'filter-topic' },
    on: {
      change: (event) => pick({ topicId: event.target.value ? Number(event.target.value) : null }),
    },
  });
  topicSelect.append(el('option', { text: 'Все занятия дисциплины', attrs: { value: '' } }));
  for (const t of topics) {
    topicSelect.append(el('option', { text: `${topicLabel(t)} (анкет: ${t.responses ?? 0})`, attrs: { value: String(t.id) } }));
  }
  topicSelect.value = state.filters.topicId && topics.some((t) => t.id === state.filters.topicId)
    ? String(state.filters.topicId)
    : '';
  if (topicSelect.value === '') state.filters.topicId = null;

  const dateField = (label, key) =>
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: label, attrs: { for: `filter-${key}` } }),
      el('input', {
        class: 'input',
        attrs: { type: 'date', id: `filter-${key}`, value: state.filters[key] || '' },
        on: {
          change: (event) => pick({ [key]: event.target.value }),
        },
      }),
    ]);

  const quick = (label, kind) =>
    el('button', {
      class: 'btn btn-sm btn-ghost',
      text: label,
      attrs: { type: 'button' },
      on: { click: () => pick({ from: kind ? rangeStart(kind) : '', to: '' }) },
    });

  return el('div', { class: 'card card-tight report-picker' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Дисциплина', attrs: { for: 'filter-discipline' } }),
      disciplineSelect,
    ]),
    formSwitch((key) => pick(key === 'final' ? { formType: 'final', topicId: null } : { formType: 'lesson' })),
    isLesson
      ? topics.length > 0
        ? el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Тема занятия', attrs: { for: 'filter-topic' } }),
            topicSelect,
          ])
        : el('p', { class: 'hint', text: 'Тем у дисциплины пока нет - добавьте их в разделе Мои темы, и список занятий появится здесь.' })
      : null,
    el('div', { class: 'report-dates' }, [
      dateField('С даты', 'from'),
      dateField('По дату', 'to'),
      el('div', { class: 'quick-dates' }, [quick('Неделя', 'week'), quick('Месяц', 'month'), quick('Семестр', 'term'), quick('Всё время', null)]),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Сбросить фильтры',
        attrs: { type: 'button' },
        on: {
          click: () => {
            state.filters = { disciplineId: discipline.id, topicId: null, formType: state.filters.formType, from: '', to: '' };
            onChange();
          },
        },
      }),
    ]),
  ]);
}

function periodNote() {
  const { from, to } = state.filters;
  if (from && to) return `период: с ${fmtDate(from)} по ${fmtDate(to)}`;
  if (from) return `период: с ${fmtDate(from)}`;
  if (to) return `период: до ${fmtDate(to)}`;
  return 'период: за всё время';
}

/** Оценки по пунктам шкалы - как их видит преподаватель в отчёте. */
function questionRows(form) {
  return form.questions.map((question) =>
    el('div', { class: 'question-row' }, [
      el('div', {}, [
        el('div', { class: 'q-label', text: question.label }),
        question.hint ? el('div', { class: 'tiny muted', text: question.hint }) : null,
        el('div', { class: 'q-bar' }, [positiveBar(question.positive_ratio)]),
      ]),
      distributionBars(question.distribution, question.count),
      el('div', { class: 'center' }, [
        el('div', { class: scoreClass(question.avg), text: question.avg === null ? '-' : fmtNum(question.avg, 2) }),
        el('div', { class: 'tiny muted', text: `ответов: ${question.count}` }),
      ]),
    ])
  );
}

/** Одна строка комментария: текст ответа, под ним контекст отдельными метками. */
function commentRow(item, { showDiscipline, formType }) {
  return el('div', { class: 'comment-row' }, [
    el('div', { class: 'comment-text', text: item.body }),
    el('div', { class: 'comment-tags' }, [
      item.is_new ? el('span', { class: 'tag tag-new', text: 'новое' }) : null,
      el('span', { class: 'tag tag-date', text: `ответ от ${fmtDate(item.created_date)}` }),
      item.lesson_date && item.lesson_date !== item.created_date
        ? el('span', { class: 'tag tag-date', text: `занятие ${fmtDate(item.lesson_date)}` })
        : null,
      item.topic_title ? el('span', { class: 'tag', text: item.topic_title }) : null,
      showDiscipline && item.discipline_title ? el('span', { class: 'tag tag-soft', text: item.discipline_title }) : null,
      el('span', { class: 'tag tag-soft', text: formType === 'final' ? 'итоговая анкета' : 'анкета по занятию' }),
    ]),
  ]);
}

function commentsCard(report) {
  const groups = [];
  for (const form of report.forms) {
    for (const group of [...form.comments, ...(form.archived_comments || [])]) {
      groups.push({ label: group.label, legacy: group.legacy, items: group.items, form_type: form.form_type });
    }
  }
  const total = groups.reduce((acc, g) => acc + g.items.length, 0);
  const fresh = groups.reduce((acc, g) => acc + g.items.filter((i) => i.is_new).length, 0);

  const host = el('div', { class: 'comment-list' });

  const render = () => {
    const q = commentsFilter.q.toLowerCase();
    const visible = groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            (!commentsFilter.onlyNew || item.is_new) &&
            (!q || item.body.toLowerCase().includes(q) || String(group.label).toLowerCase().includes(q))
        ),
      }))
      .filter((group) => group.items.length > 0);

    if (visible.length === 0) {
      mount(
        host,
        el('p', {
          class: 'hint',
          text: total === 0 ? 'Текстовых комментариев по этим фильтрам пока нет.' : 'Ничего не найдено - попробуйте сбросить поиск или фильтр.',
        })
      );
      return;
    }

    mount(
      host,
      visible.map((group) =>
        el('div', { class: 'comment-group' }, [
          el('h3', {}, [
            el('span', { text: group.label }),
            group.legacy ? el('span', { class: 'badge', text: 'вопрос снят с анкеты' }) : null,
            el('span', { class: 'badge badge-brand', text: String(group.items.length) }),
          ]),
          ...group.items.map((item) => commentRow(item, { showDiscipline: !report.topic, formType: group.form_type })),
        ])
      )
    );
  };

  const search = el('input', {
    class: 'input',
    attrs: { type: 'search', placeholder: 'Поиск по тексту отзыва', 'aria-label': 'Поиск по тексту отзыва' },
    on: {
      input: (event) => {
        commentsFilter.q = event.target.value.trim();
        render();
      },
    },
  });

  const onlyNew = el('input', {
    class: 'checkbox',
    attrs: { type: 'checkbox', id: 'comments-only-new' },
    on: {
      change: (event) => {
        commentsFilter.onlyNew = event.target.checked;
        render();
      },
    },
  });

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'comments-head' }, [
      el('h2', { text: 'Комментарии студентов' }),
      el('span', { class: 'badge badge-brand', text: `${total} ${plural(total, 'ответ', 'ответа', 'ответов')}` }),
      fresh > 0 ? el('span', { class: 'badge badge-warn', text: `новых: ${fresh}` }) : null,
    ]),
    el('div', { class: 'comment-tools' }, [
      search,
      el('label', { class: 'check-row', attrs: { for: 'comments-only-new' } }, [
        onlyNew,
        el('span', { text: fresh > 0 ? `только новые (${fresh})` : 'только новые' }),
      ]),
    ]),
    host,
  ]);

  render();
  return el('section', { class: 'section' }, [card]);
}

/** Разбивка по занятиям дисциплины: строка темы с переходом в её отчёт. */
function lessonsSection(report, onOpen) {
  if (report.topic || state.filters.formType !== 'lesson' || !report.lessons || report.lessons.length === 0) return null;

  return el('section', { class: 'section' }, [
    el('div', { class: 'section-title' }, [
      el('h2', { text: 'По занятиям' }),
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
              el('td', { text: lesson.topic_title || '-' }),
              el('td', { class: 'num', text: lesson.lesson_date ? fmtDate(lesson.lesson_date) : '-' }),
              el('td', { class: 'num', text: String(lesson.responses) }),
              el('td', { class: 'num' }, [
                el('span', { class: scoreClass(lesson.avg), text: lesson.avg === null ? '-' : fmtNum(lesson.avg, 2) }),
              ]),
              el('td', { class: 'num' }, [
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  text: 'Открыть',
                  attrs: { type: 'button' },
                  on: { click: () => onOpen(lesson) },
                }),
              ]),
            ])
          )
        ),
      ]),
    ]),
  ]);
}

/** Ссылка на анкету с нужными фильтрами: её можно скопировать или открыть. */
function studentLink(disciplineId, topicId, formType) {
  return studentUrl('/form.html', {
    discipline: disciplineId,
    topic: topicId,
    form: formType,
  });
}

function linkRow(disciplineId, topicId, formType) {
  const url = studentLink(disciplineId, topicId, formType);
  const input = el('input', { class: 'input', attrs: { value: url, readonly: true, 'aria-label': 'Ссылка на анкету' } });
  return el('div', { class: 'card' }, [
    el('p', { class: 'small soft', text: 'Отправьте ссылку группе или откройте анкету с экрана - регистрация студентам не нужна.' }),
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

function modalLink(disciplineId, topicId, formType) {
  modal({
    title: 'Ссылка для студентов',
    content: el('div', {}, [
      el('p', { class: 'small soft', text: 'Анкета откроется сразу с этой дисциплиной и темой, которую выбрал преподаватель.' }),
      linkRow(disciplineId, topicId, formType),
    ]),
    actions: [{ label: 'Закрыть', class: 'btn-ghost' }],
    wide: true,
  });
}

async function markSeen() {
  if (state.news.responses === 0 && state.news.comments === 0) return;
  try {
    await api.post('/api/teacher/seen', {});
    state.news = { responses: 0, comments: 0 };
    for (const d of state.disciplines) {
      d.new_responses = 0;
      d.new_comments = 0;
    }
    renderNav();
  } catch {
    /* счётчик обновится при следующем заходе в раздел */
  }
}

async function renderReport() {
  setAlert('');
  if (state.disciplines.length === 0) {
    try {
      await reloadDisciplines();
    } catch (error) {
      setAlert(error.message, 'danger');
    }
  }

  const discipline = currentDiscipline();
  state.filters.disciplineId = discipline ? discipline.id : null;

  const onChange = () => {
    setParams({
      discipline: state.filters.disciplineId,
      topic: state.filters.topicId,
      form: state.filters.formType,
      from: state.filters.from || null,
      to: state.filters.to || null,
    });
    renderReport();
  };

  if (!discipline) {
    mount(root, [
      pageHead('Отчёт', 'Здесь появятся оценки и комментарии по вашим дисциплинам'),
      el('div', { class: 'card empty' }, [
        el('p', { text: 'За вами пока не закреплено ни одной дисциплины.' }),
        el('button', {
          class: 'btn btn-primary',
          text: 'Создать дисциплину',
          attrs: { type: 'button' },
          on: { click: () => go('catalog') },
        }),
      ]),
    ]);
    return;
  }

  mount(root, [
    pageHead('Отчёт', periodNote()),
    pickerCard(discipline, onChange),
    el('div', { class: 'card' }, [el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })]),
  ]);

  try {
    const query = new URLSearchParams();
    if (state.filters.formType) query.set('form_type', state.filters.formType);
    if (state.filters.from) query.set('from', state.filters.from);
    if (state.filters.to) query.set('to', state.filters.to);

    const base = state.filters.topicId
      ? `/api/teacher/topics/${state.filters.topicId}/report`
      : `/api/teacher/disciplines/${discipline.id}/report`;

    const report = await api.get(`${base}${query.toString() ? `?${query}` : ''}`);

    const topicTitle = report.topic ? report.topic.title : null;
    const heading = topicTitle ? `Отчёт по занятию: ${topicTitle}` : `Отчёт: ${discipline.title}`;
    const subtitle = [topicTitle ? discipline.title : null, periodNote()].filter(Boolean).join(' · ');

    mount(root, [
      pageHead(heading, subtitle, [
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
      pickerCard(discipline, onChange),
      report.total_responses === 0
        ? el('div', { class: 'alert alert-warn', text: 'По выбранным фильтрам пока нет ни одной анкеты.' })
        : null,
      report.hidden
        ? el('div', { class: 'alert alert-warn', text: report.min_answers_label || 'Результаты скрыты из-за малого числа ответов.' })
        : null,
      el('div', { class: 'card card-tight' }, [
        el('div', { class: 'stats stats-2' }, [
          statCard(
            'Всего анкет',
            String(report.total_responses ?? 0),
            report.new_responses > 0 ? `новых с прошлого просмотра: ${report.new_responses}` : 'с прошлого просмотра новых нет'
          ),
          statCard('Средний балл', report.overall_avg === null ? '-' : fmtNum(report.overall_avg, 2), 'по всем пунктам шкалы'),
        ]),
      ]),
      ...report.forms.map((form) =>
        el('section', { class: 'section' }, [
          el('div', { class: 'section-title' }, [
            el('h2', { text: form.title }),
            el('span', { class: 'badge', text: `анкет: ${form.responses}` }),
            form.avg_of_items !== null
              ? el('span', {
                  class: `badge ${form.avg_of_items >= 4 ? 'badge-ok' : 'badge-brand'}`,
                  text: `средний балл: ${fmtNum(form.avg_of_items, 2)}`,
                })
              : null,
          ]),
          el('div', { class: 'card card-tight' }, questionRows(form)),
        ])
      ),
      commentsCard(report),
      lessonsSection(report, (lesson) => {
        state.filters.topicId = lesson.topic_id;
        state.filters.disciplineId = lesson.discipline_id;
        state.filters.formType = 'lesson';
        onChange();
      }),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [
          el('h2', { text: 'Ссылка для студентов' }),
          el('span', { class: 'tiny muted', text: 'ведёт на анкету с уже выбранными дисциплиной и темой' }),
        ]),
        linkRow(state.filters.disciplineId, state.filters.topicId, state.filters.formType),
      ]),
    ]);

    markSeen();
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, [
      pageHead('Отчёт', periodNote()),
      pickerCard(discipline, onChange),
      el('div', { class: 'card empty', text: 'Не удалось построить отчёт.' }),
    ]);
  }
}

/* ------------------------------ Мои темы ------------------------------ */

const MAX_TITLE = 200;

/** Подпись поля: label с for, когда у поля есть id, иначе обычная подпись. */
function fieldRow(label, node, forId = null) {
  const caption = label
    ? el(forId ? 'label' : 'span', { class: 'label', text: label, attrs: forId ? { for: forId } : null })
    : null;
  return el('div', { class: 'field' }, [caption, node]);
}

/** Карточка создания дисциплины: за преподавателем она закрепляется сразу. */
function createDisciplineCard() {
  const title = el('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: 'Например: Базы данных', maxlength: String(MAX_TITLE), 'aria-label': 'Название дисциплины' },
  });
  const code = el('input', { class: 'input', attrs: { type: 'text', placeholder: 'Необязательно', maxlength: '40', 'aria-label': 'Код дисциплины' } });
  const submit = el('button', {
    class: 'btn btn-primary',
    text: 'Создать дисциплину',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        const value = title.value.trim();
        if (value.length < 2) return toast('Название дисциплины: минимум 2 символа', 'danger');
        setLoading(submit, true, 'Создаём…');
        try {
          await api.post('/api/teacher/disciplines', { title: value, code: code.value.trim() || null });
          toast('Дисциплина создана', 'ok');
          title.value = '';
          code.value = '';
          await afterCatalogChange();
        } catch (error) {
          toast(error.message, 'danger');
        } finally {
          setLoading(submit, false);
        }
      },
    },
  });

  return el('div', { class: 'card card-tight' }, [
    el('div', { class: 'catalog-add' }, [
      fieldRow('Новая дисциплина', title),
      fieldRow('Код', code),
      fieldRow(null, submit),
    ]),
    el('p', {
      class: 'hint',
      text: state.user.role === 'admin'
        ? 'Дисциплина закрепляется за вами; назначить другого преподавателя можно в админ-панели.'
        : 'Дисциплина сразу закрепляется за вами. Отключить или удалить её может только администратор.',
    }),
  ]);
}

async function afterCatalogChange() {
  try {
    await reloadDisciplines();
  } catch (error) {
    setAlert(error.message, 'danger');
  }
  renderCatalog();
}

function renameDiscipline(discipline) {
  const title = el('input', { class: 'input', attrs: { type: 'text', value: discipline.title, maxlength: String(MAX_TITLE) } });
  const code = el('input', { class: 'input', attrs: { type: 'text', value: discipline.code || '', maxlength: '40' } });
  modal({
    title: 'Дисциплина',
    content: el('div', {}, [fieldRow('Название', title), fieldRow('Код', code)]),
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      {
        label: 'Сохранить',
        class: 'btn-primary',
        onClick: async () => {
          try {
            await api.patch(`/api/teacher/disciplines/${discipline.id}`, {
              title: title.value.trim(),
              code: code.value.trim() || null,
            });
            toast('Дисциплина обновлена', 'ok');
            await afterCatalogChange();
          } catch (error) {
            toast(error.message, 'danger');
          }
        },
      },
    ],
  });
}

async function toggleDiscipline(discipline) {
  try {
    await api.patch(`/api/teacher/disciplines/${discipline.id}`, { is_active: !discipline.is_active });
    toast(discipline.is_active ? 'Дисциплина выключена: анкеты по ней больше не принимаются' : 'Дисциплина включена', 'ok');
    await afterCatalogChange();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

function editTopic(topic) {
  const title = el('input', { class: 'input', attrs: { type: 'text', value: topic.title, maxlength: String(MAX_TITLE) } });
  const date = el('input', { class: 'input', attrs: { type: 'date', value: topic.lesson_date || '' } });
  modal({
    title: 'Тема занятия',
    content: el('div', {}, [fieldRow('Название', title), fieldRow('Дата занятия', date)]),
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      {
        label: 'Сохранить',
        class: 'btn-primary',
        onClick: async () => {
          try {
            await api.patch(`/api/teacher/topics/${topic.id}`, {
              title: title.value.trim(),
              lesson_date: date.value || null,
            });
            toast('Тема обновлена', 'ok');
            await afterCatalogChange();
          } catch (error) {
            toast(error.message, 'danger');
          }
        },
      },
    ],
  });
}

async function toggleTopic(topic) {
  try {
    await api.patch(`/api/teacher/topics/${topic.id}`, { is_active: !topic.is_active });
    await afterCatalogChange();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

/** Список занятий сразу: одна тема в строке, дата через вертикальную черту. */
function bulkTopicsModal(discipline) {
  const area = el('textarea', {
    class: 'textarea',
    attrs: { rows: '8', placeholder: '2026-09-02 | Введение и правила оценки\n2026-09-09 | Запросы на языке SQL\nПроектирование схемы', 'aria-label': 'Список тем' },
  });
  modal({
    title: 'Добавить список занятий',
    content: el('div', {}, [
      el('p', { class: 'small soft', text: 'Одна тема в строке. Дату можно поставить перед названием через вертикальную черту - или оставить строку без даты.' }),
      area,
    ]),
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      {
        label: 'Добавить',
        class: 'btn-primary',
        onClick: async () => {
          const items = area.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 100)
            .map((line) => {
              const [left, ...rest] = line.split('|');
              const date = /^\d{4}-\d{2}-\d{2}$/.test(left.trim()) ? left.trim() : null;
              const title = (date ? rest.join('|').trim() : line).trim();
              return { title, lesson_date: date };
            })
            .filter((item) => item.title.length >= 2);
          if (items.length === 0) {
            toast('Список пуст: у каждой темы должно быть название', 'danger');
            return;
          }
          try {
            const result = await api.post(`/api/teacher/disciplines/${discipline.id}/topics/bulk`, { topics: items });
            toast(`Добавлено тем: ${result.created}`, 'ok');
            await afterCatalogChange();
          } catch (error) {
            toast(error.message, 'danger');
          }
        },
      },
    ],
    wide: true,
  });
}

function addTopicForm(discipline) {
  const title = el('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: 'Название занятия', maxlength: String(MAX_TITLE), 'aria-label': 'Название темы' },
  });
  const date = el('input', { class: 'input', attrs: { type: 'date', 'aria-label': 'Дата занятия' } });
  const submit = el('button', {
    class: 'btn btn-primary btn-sm',
    text: 'Добавить занятие',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        const value = title.value.trim();
        if (value.length < 2) return toast('Название темы: минимум 2 символа', 'danger');
        setLoading(submit, true, 'Добавляем…');
        try {
          await api.post('/api/teacher/topics', {
            discipline_id: discipline.id,
            title: value,
            lesson_date: date.value || null,
          });
          title.value = '';
          date.value = '';
          toast('Тема добавлена', 'ok');
          await afterCatalogChange();
        } catch (error) {
          toast(error.message, 'danger');
        } finally {
          setLoading(submit, false);
        }
      },
    },
  });

  return el('div', { class: 'catalog-add' }, [
    fieldRow(null, title),
    fieldRow(null, date),
    fieldRow(null, submit),
    fieldRow(null, el('button', {
      class: 'btn btn-sm btn-ghost',
      text: 'Списком',
      attrs: { type: 'button' },
      on: { click: () => bulkTopicsModal(discipline) },
    })),
  ]);
}

function topicsTable(discipline) {
  const topics = discipline.topics || [];
  if (topics.length === 0) {
    return el('p', { class: 'hint', text: 'Занятий ещё нет. Добавьте тему - и по ней можно будет принимать анкеты по занятию.' });
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Тема занятия' }),
          el('th', { class: 'num', text: 'Дата' }),
          el('th', { class: 'num', text: 'Анкет' }),
          el('th', { class: 'num', text: '' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        topics.map((topic) =>
          el('tr', { class: topic.is_active ? '' : 'row-off' }, [
            el('td', {}, [
              el('div', { text: topic.title }),
              topic.is_active ? null : el('div', { class: 'tiny muted', text: 'выключена' }),
            ]),
            el('td', { class: 'num', text: topic.lesson_date ? fmtDate(topic.lesson_date) : '-' }),
            el('td', { class: 'num', text: String(topic.responses ?? 0) }),
            el('td', { class: 'num' }, [
              el('div', { class: 'row-actions' }, [
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  text: 'Отчёт',
                  attrs: { type: 'button' },
                  on: {
                    click: () => {
                      state.filters = {
                        disciplineId: discipline.id,
                        topicId: topic.id,
                        formType: 'lesson',
                        from: '',
                        to: '',
                      };
                      go('report', { discipline: discipline.id, topic: topic.id, form: 'lesson' });
                    },
                  },
                }),
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  text: 'Ссылка',
                  attrs: { type: 'button' },
                  on: { click: () => modalLink(discipline.id, topic.id, 'lesson') },
                }),
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  text: 'Править',
                  attrs: { type: 'button' },
                  on: { click: () => editTopic(topic) },
                }),
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  text: topic.is_active ? 'Выключить' : 'Включить',
                  attrs: { type: 'button' },
                  on: { click: () => toggleTopic(topic) },
                }),
              ]),
            ]),
          ])
        )
      ),
    ]),
  ]);
}

function disciplineCard(discipline) {
  const topics = discipline.topics || [];
  const activeTopics = topics.filter((t) => t.is_active).length;
  const answered = topics.reduce((acc, t) => acc + (t.responses ?? 0), 0);

  return el('section', { class: 'section' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'catalog-head' }, [
        el('div', {}, [
          el('h2', { text: discipline.title }),
          el('div', { class: 'catalog-meta' }, [
            discipline.code ? el('span', { text: `код: ${discipline.code}` }) : null,
            el('span', { text: `${topics.length} ${plural(topics.length, 'тема', 'темы', 'тем')}${activeTopics !== topics.length ? ` · активных: ${activeTopics}` : ''}` }),
            el('span', { text: `анкет по темам: ${answered}` }),
            discipline.new_responses > 0
              ? el('span', { class: 'tag tag-new', text: `новых анкет: ${discipline.new_responses}` })
              : null,
            discipline.new_comments > 0
              ? el('span', { class: 'tag tag-new', text: `новых отзывов: ${discipline.new_comments}` })
              : null,
            discipline.is_active ? null : el('span', { class: 'tag tag-soft', text: 'дисциплина выключена' }),
          ]),
        ]),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn btn-sm btn-primary',
            text: 'Отчёт по дисциплине',
            attrs: { type: 'button' },
            on: {
              click: () => {
                state.filters = { disciplineId: discipline.id, topicId: null, formType: 'final', from: '', to: '' };
                go('report', { discipline: discipline.id, form: 'final' });
              },
            },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Ссылка',
            attrs: { type: 'button' },
            on: { click: () => modalLink(discipline.id, null, 'final') },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Править',
            attrs: { type: 'button' },
            on: { click: () => renameDiscipline(discipline) },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: discipline.is_active ? 'Выключить' : 'Включить',
            attrs: { type: 'button' },
            on: { click: () => toggleDiscipline(discipline) },
          }),
        ]),
      ]),
      topicsTable(discipline),
      addTopicForm(discipline),
    ]),
  ]);
}

async function renderCatalog() {
  setAlert('');
  mount(root, [
    pageHead('Мои темы', 'Дисциплины и занятия: по ссылкам из этого раздела студенты приходят на анкеты'),
    el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]),
  ]);

  try {
    if (state.disciplines.length === 0) await reloadDisciplines();
    mount(root, [
      pageHead('Мои темы', `дисциплин: ${state.disciplines.length}`, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Обновить',
          attrs: { type: 'button' },
          on: { click: afterCatalogChange },
        }),
      ]),
      createDisciplineCard(),
      ...state.disciplines.map(disciplineCard),
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, [pageHead('Мои темы', null), el('div', { class: 'card empty', text: 'Не удалось загрузить дисциплины.' })]);
  }
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
  // Нужна, чтобы ссылки на анкету в отчёте вели на студенческий порт.
  loadStudentBase();
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
    await reloadDisciplines();
  } catch (error) {
    setAlert(error.message, 'danger');
  }

  // Старые ссылки на Обзор и Отзывы ведут в Отчёт: эти разделы объединены в один.
  const requested = qsParam('view');
  state.view = ['report', 'catalog', 'password'].includes(requested) ? requested : 'report';
  if (qsParam('discipline')) state.filters.disciplineId = Number(qsParam('discipline'));
  if (qsParam('topic')) state.filters.topicId = Number(qsParam('topic'));
  if (qsParam('form')) state.filters.formType = qsParam('form') === 'final' ? 'final' : 'lesson';
  if (qsParam('from')) state.filters.from = qsParam('from');
  if (qsParam('to')) state.filters.to = qsParam('to');

  renderNav();
  if (state.view === 'catalog') await renderCatalog();
  else if (state.view === 'password') renderPassword();
  else await renderReport();
})();
