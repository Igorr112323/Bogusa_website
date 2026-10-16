/**
 * Кабинет преподавателя.
 *
 * Без вкладок: одна главная с четырьмя большими «дверями» в разделы,
 * и три подэкрана, куда эти двери ведут.
 *
 *   Главная (/portal/)
 *     ├─ Дисциплины и темы   — таблица, создание, QR-код
 *     ├─ Отзывы студентов     — поиск и список
 *     ├─ Сменить пароль       — форма
 *     └─ Выйти                — отдельная кнопка в шапке
 */

import {
  api,
  el,
  mount,
  clear,
  toast,
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
  studentUrl,
} from './api.js';
import { distributionBars, timelineChart, positiveBar } from './charts.js';
import { disciplineFormModal, topicsModal } from './discipline-manager.js';

const state = {
  user: null,
  view: 'home',
  disciplines: [],
  filters: { disciplineId: null, topicId: null, formType: null, from: '', to: '' },
};

const root = document.querySelector('#view-root');
const alertsNode = document.querySelector('#view-alerts');
const userBadge = document.querySelector('#user-badge');

/* ------------------------------ каркас ------------------------------ */

function setAlert(message, kind = 'info') {
  if (!message) {
    clear(alertsNode);
    return;
  }
  mount(alertsNode, el('div', { class: `alert alert-${kind}`, attrs: { role: 'alert' }, text: message }));
}

function go(view, params = {}) {
  state.view = view;
  setParams({ view, ...params });
  if (view === 'disciplines') return renderDisciplines();
  if (view === 'comments') return renderComments();
  if (view === 'password') return renderPassword();
  return renderHome();
}

function backLink() {
  return el(
    'a',
    {
      class: 'back-link',
      attrs: { href: '/portal/' },
      on: { click: (e) => { e.preventDefault(); go('home'); } },
    },
    [el('span', { text: '←' }), el('span', { text: 'На главную' })]
  );
}

function pageHead(title, subtitle, actions = []) {
  return el('div', { class: 'page-head' }, [
    backLink(),
    el('div', { class: 'page-head-row' }, [
      el('div', {}, [el('h1', { text: title }), subtitle ? el('div', { class: 'sub', text: subtitle }) : null]),
      actions.length > 0 ? el('div', { class: 'btn-row' }, actions) : null,
    ]),
  ]);
}

/* ------------------------------ Главная (4 двери) ------------------------------ */

function doorCard({ title, hint, primary, href, onClick, badge }) {
  const body = el('div', { class: 'door-body' }, [
    el('div', { class: 'door-title', text: title }),
    hint ? el('div', { class: 'door-hint', text: hint }) : null,
  ]);
  if (badge) body.append(el('span', { class: 'door-badge', text: badge }));
  const node = el('a', { class: `door${primary ? ' door-primary' : ''}`, attrs: { href: href || '#' } }, [body]);
  if (onClick) {
    node.addEventListener('click', (e) => {
      if (!href) {
        e.preventDefault();
        onClick();
      }
    });
  }
  return node;
}

async function renderHome() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  let data;
  try {
    data = await api.get('/api/teacher/overview');
  } catch (error) {
    setAlert(error.message, 'danger');
    if (error.status === 401) {
      window.location.replace('/login?next=/portal/');
      return;
    }
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить данные. Обновите страницу.' }));
    return;
  }

  const totals = data.totals || {};
  const nDisciplines = (data.disciplines || []).length;
  const nTopics = (data.disciplines || []).reduce((acc, d) => acc + (d.topics_count || 0), 0);
  const nResponses = totals.responses || 0;
  const nComments = totals.comments || 0;

  const stats = el('div', { class: 'stats stats-home' }, [
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Дисциплин' }), el('div', { class: 'stat-value', text: String(nDisciplines) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Тем' }), el('div', { class: 'stat-value', text: String(nTopics) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Ответов' }), el('div', { class: 'stat-value', text: String(nResponses) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Комментариев' }), el('div', { class: 'stat-value', text: String(nComments) })]),
  ]);

  const avg =
    totals.overall_avg === null || totals.overall_avg === undefined
      ? '—'
      : fmtNum(totals.overall_avg, 2);

  const doors = el('div', { class: 'doors' }, [
    doorCard({
      title: 'Дисциплины и темы',
      hint: 'Создайте дисциплину, добавьте темы занятий, получите ссылку и QR-код для студентов',
      primary: true,
      href: '?view=disciplines',
      badge: String(nDisciplines),
    }),
    doorCard({
      title: 'Отзывы студентов',
      hint: 'Текстовые ответы, которые студенты оставили в открытых полях',
      href: '?view=comments',
      badge: String(nComments),
    }),
    doorCard({
      title: 'Сменить пароль',
      hint: 'Задайте новый пароль для входа в кабинет',
      href: '?view=password',
    }),
  ]);

  mount(root, [
    el('div', { class: 'hello' }, [
      el('h1', { text: `Здравствуйте, ${state.user.full_name || ''}`.trim() }),
      el('p', { class: 'sub', text: 'Выберите раздел, чтобы продолжить.' }),
    ]),
    stats,
    doors,
    el('div', { class: 'card card-flat' }, [
      el('h3', { text: 'Сводка по ответам' }),
      el('div', { class: 'row' }, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Средний балл' }), el('span', { class: 'v', text: avg })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'По занятиям' }), el('span', { class: 'v', text: String(totals.lesson || 0) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Итоговых' }), el('span', { class: 'v', text: String(totals.final || 0) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Последний ответ' }), el('span', { class: 'v', text: totals.last_response_at ? fmtDateTime(totals.last_response_at) : '—' })]),
      ]),
    ]),
  ]);
}

/* ------------------------------ Дисциплины и темы ------------------------------ */

const exportUrl = (base, filters) => {
  const params = new URLSearchParams();
  if (filters.disciplineId) params.set('discipline_id', filters.disciplineId);
  if (filters.topicId) params.set('topic_id', filters.topicId);
  if (filters.formType) params.set('form_type', filters.formType);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return `${base}${params.toString() ? `?${params.toString()}` : ''}`;
};

function linksCard() {
  const url = studentUrl('/form.html', {
    discipline: state.filters.disciplineId,
    topic: state.filters.topicId,
    form: state.filters.formType,
  });
  const input = el('input', { class: 'input', attrs: { value: url, readonly: true, 'aria-label': 'Ссылка на анкету' } });
  return el('div', { class: 'qr-block' }, [
    el('div', { class: 'qr-row' }, [
      el('label', { class: 'label', text: 'Ссылка для студентов' }),
      el('div', { class: 'copy-row' }, [
        input,
        el('button', {
          class: 'btn btn-sm',
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
    ]),
    el('div', { class: 'qr-img' }, [
      el('img', {
        attrs: {
          src: `/api/admin/qr.png?discipline_id=${encodeURIComponent(state.filters.disciplineId || '')}&size=320`,
          alt: 'QR-код для студентов',
          width: '220',
          height: '220',
        },
      }),
    ]),
  ]);
}

async function renderDisciplines() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  let data;
  try {
    data = await api.get('/api/teacher/overview');
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить дисциплины.' }));
    return;
  }

  const teacherRow = state.user
    ? { id: state.user.id, full_name: state.user.full_name, login: state.user.login, role: 'teacher' }
    : null;
  const teacherById = teacherRow ? new Map([[teacherRow.id, teacherRow]]) : new Map();

  if (!state.filters.disciplineId && data.disciplines.length > 0) {
    state.filters.disciplineId = data.disciplines[0].id;
  }

  const refresh = () => renderDisciplines();
  const openTopicModal = (discipline) => topicsModal({ discipline, scope: 'teacher', onSaved: refresh });

  const disciplineRows = data.disciplines.map((discipline) => {
    const isActive = String(discipline.id) === String(state.filters.disciplineId);
    return el('tr', { class: isActive ? 'row-active' : '' }, [
      el('td', {}, [
        el('div', {}, [el('strong', { text: discipline.title })]),
        el('div', { class: 'tiny muted' }, [
          discipline.code || '',
          discipline.code ? ' · ' : '',
          `${discipline.topics_count} ${plural(discipline.topics_count, 'тема', 'темы', 'тем')}`,
          discipline.is_active ? '' : ' · выключена',
        ]),
      ]),
      el('td', { class: 'num', text: String(discipline.responses || 0) }),
      el('td', { class: 'num' }, [
        el('span', { class: scoreClass(discipline.avg), text: discipline.avg === null ? '—' : fmtNum(discipline.avg, 2) }),
      ]),
      el('td', { class: 'num' }, [
        el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Темы',
            attrs: { type: 'button' },
            on: { click: () => openTopicModal({ id: discipline.id, title: discipline.title }) },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Изменить',
            attrs: { type: 'button' },
            on: {
              click: () =>
                disciplineFormModal({
                  discipline: {
                    id: discipline.id,
                    title: discipline.title,
                    code: discipline.code,
                    is_active: discipline.is_active,
                    teacher_id: discipline.teacher_id,
                  },
                  teacherById,
                  canEditTeacher: false,
                  scope: 'teacher',
                  onSaved: refresh,
                }),
            },
          }),
          el('button', {
            class: isActive ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost',
            text: isActive ? 'Выбрана' : 'Ссылка/QR',
            attrs: { type: 'button' },
            on: {
              click: () => {
                state.filters.disciplineId = discipline.id;
                renderDisciplines();
                const qr = document.querySelector('#qr-block');
                if (qr) qr.scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            },
          }),
        ]),
      ]),
    ]);
  });

  const head = pageHead(
    'Дисциплины и темы',
    'Создавайте дисциплины, добавляйте темы занятий и публикуйте ссылку для студентов',
    [
      el('a', {
        class: 'btn btn-sm btn-ghost',
        attrs: { href: exportUrl('/api/teacher/export.csv', {}) },
        text: 'Скачать всё в CSV',
      }),
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: '+ Новая дисциплина',
        attrs: { type: 'button' },
        on: {
          click: () =>
            disciplineFormModal({
              teacherById,
              canEditTeacher: false,
              scope: 'teacher',
              onSaved: refresh,
            }),
        },
      }),
    ]
  );

  const tableCard = data.disciplines.length === 0
    ? el('div', { class: 'card empty', text: 'Дисциплин пока нет. Нажмите «+ Новая дисциплина», чтобы создать первую.' })
    : el('div', { class: 'table-wrap' }, [
        el('table', { class: 'table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Дисциплина' }),
              el('th', { class: 'num', text: 'Ответов' }),
              el('th', { class: 'num', text: 'Средний' }),
              el('th', { class: 'num', text: '' }),
            ]),
          ]),
          el('tbody', {}, disciplineRows),
        ]),
      ]);

  const qrSection = state.filters.disciplineId
    ? el('div', { class: 'card', attrs: { id: 'qr-block' } }, [
        el('h2', { text: 'Ссылка и QR-код для студентов' }),
        el('p', { class: 'sub', text: 'Откройте ссылку в браузере или покажите QR-код с экрана — регистрация не нужна.' }),
        linksCard(),
      ])
    : null;

  mount(root, [
    head,
    tableCard,
    qrSection,
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
    el('option', { text: 'Все анкеты', attrs: { value: '' } }),
    el('option', { text: 'По занятию', attrs: { value: 'lesson' } }),
    el('option', { text: 'Итоговая', attrs: { value: 'final' } }),
  ]);
  const listNode = el('div', {});

  const load = async () => {
    const params = new URLSearchParams();
    if (searchInput.value) params.set('q', searchInput.value);
    if (formSelect.value) params.set('form_type', formSelect.value);
    const query = params.toString();
    try {
      const data = await api.get(`/api/teacher/comments${query ? `?${query}` : ''}`);
      const rows = data.comments || [];
      if (rows.length === 0) {
        mount(listNode, el('div', { class: 'card empty', text: 'Отзывов пока нет.' }));
        return;
      }
      mount(
        listNode,
        el(
          'ul',
          { class: 'comment-list' },
          rows.map((c) =>
            el('li', { class: 'comment-item' }, [
              el('div', { class: 'comment-head' }, [
                el('span', { class: 'badge', text: c.form_type === 'lesson' ? 'По занятию' : 'Итоговая' }),
                el('span', { class: 'comment-meta', text: `${c.discipline_title || ''}${c.topic_title ? ' · ' + c.topic_title : ''}` }),
                el('span', { class: 'comment-date', text: c.created_date || '' }),
              ]),
              el('div', { class: 'comment-body' }, [
                el('div', { class: 'comment-q', text: c.question_label || c.question_key }),
                el('div', { class: 'comment-text', text: c.body }),
              ]),
            ])
          )
        )
      );
    } catch (error) {
      setAlert(error.message, 'danger');
    }
  };

  const head = pageHead('Отзывы студентов', 'Текстовые ответы, которые студенты оставили в открытых полях');
  const filterCard = el('div', { class: 'card filter-bar' }, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Поиск' }), searchInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Тип анкеты' }), formSelect]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-sm',
        text: 'Найти',
        attrs: { type: 'button' },
        on: { click: load },
      }),
    ]),
  ]);

  mount(root, [head, filterCard, listNode]);
  await load();
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load();
  });
}

/* ------------------------------ Пароль ------------------------------ */

async function renderPassword() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  const current = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'current-password', placeholder: 'Текущий пароль' } });
  const next1 = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль (минимум 8 символов)' } });
  const next2 = el('input', { class: 'input', attrs: { type: 'password', autocomplete: 'new-password', placeholder: 'Повторите новый пароль' } });
  const status = el('div');

  const submit = el(
    'button',
    {
      class: 'btn btn-primary btn-lg btn-submit',
      text: 'Сменить пароль',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          if (!current.value || !next1.value) {
            mount(status, el('div', { class: 'alert alert-warn', text: 'Заполните все поля.' }));
            return;
          }
          if (next1.value !== next2.value) {
            mount(status, el('div', { class: 'alert alert-warn', text: 'Новые пароли не совпадают.' }));
            return;
          }
          if (next1.value.length < 8) {
            mount(status, el('div', { class: 'alert alert-warn', text: 'Пароль должен быть не короче 8 символов.' }));
            return;
          }
          try {
            await api.post('/api/auth/password', {
              current_password: current.value,
              new_password: next1.value,
            });
            mount(status, el('div', { class: 'alert alert-ok', text: 'Пароль обновлён.' }));
            current.value = next1.value = next2.value = '';
          } catch (error) {
            mount(status, el('div', { class: 'alert alert-danger', text: error.message }));
          }
        },
      },
    }
  );

  const head = pageHead('Сменить пароль', 'Задайте новый пароль для входа в кабинет');
  const form = el('div', { class: 'card card-form' }, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Текущий пароль' }), current]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Новый пароль' }), next1]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Повторите новый пароль' }), next2]),
    status,
    submit,
  ]);

  mount(root, [head, form]);
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
  try {
    const { user } = await api.get('/api/auth/me');
    if (!user) throw new Error('not authenticated');
    state.user = user;
    userBadge.textContent = user.full_name;
  } catch {
    window.location.replace('/login?next=/portal/');
    return;
  }

  if (state.user.must_change_password) {
    mount(root, el('div', { class: 'card' }, [
      el('h1', { text: 'Смените временный пароль' }),
      el('p', { class: 'soft', text: 'Пока пароль не изменён, отчёты недоступны.' }),
      el('a', { class: 'btn btn-primary', attrs: { href: '?view=password' }, text: 'Перейти к смене пароля' }),
    ]));
    return;
  }

  const viewParam = qsParam('view');
  const allowed = ['home', 'disciplines', 'comments', 'password'];
  state.view = allowed.includes(viewParam) ? viewParam : 'home';
  go(state.view);
})();
