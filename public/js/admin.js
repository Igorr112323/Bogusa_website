/**
 * Админ-панель: преподаватели, дисциплины и темы, сквозные отчёты, QR-коды, журнал.
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
  modal,
  copyText,
  confirmDialog,
  loadToken,
  clearToken,
  loadStudentBase,
  studentUrl,
} from './api.js';
import { timelineChart, distributionBars, positiveBar } from './charts.js';

const state = {
  user: null,
  view: 'overview',
  teachers: [],
  disciplines: [],
  filters: { teacherId: null, disciplineId: null, formType: null, from: '', to: '' },
};

const root = document.querySelector('#view-root');
const alertsNode = document.querySelector('#view-alerts');
const sideNav = document.querySelector('#side-nav');
const userBadge = document.querySelector('#user-badge');

const VIEWS = [
  { key: 'overview', label: 'Сводка' },
  { key: 'teachers', label: 'Преподаватели', desc: 'аккаунты, доступы, сброс паролей' },
  { key: 'disciplines', label: 'Дисциплины и темы', desc: 'дисциплины, темы занятий, ссылки и QR-коды' },
  { key: 'reports', label: 'Отчёты', desc: 'сквозная агрегация по всем преподавателям' },
  { key: 'qr', label: 'QR и ссылки', desc: 'материалы, которые отправляют группам' },
  { key: 'audit', label: 'Журнал действий', desc: 'кто и что менял в системе' },
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
}

function go(view, params = {}) {
  state.view = view;
  renderNav();
  setParams({ view, ...params });
  if (view === 'overview') return renderOverview();
  if (view === 'teachers') return renderTeachers();
  if (view === 'disciplines') return renderDisciplines();
  if (view === 'reports') return renderReports();
  if (view === 'qr') return renderQr();
  return renderAudit();
}

function pageHead(title, subtitle, actions = []) {
  const buttons = [...actions];
  if (state.view !== 'overview') {
    buttons.unshift(
      el('button', {
        class: 'btn btn-sm btn-ghost',
        attrs: { type: 'button' },
        text: 'Ко всем разделам',
        on: { click: () => go('overview') },
      })
    );
  }
  return el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: title }), subtitle ? el('div', { class: 'sub', text: subtitle }) : null]),
    buttons.length > 0 ? el('div', { class: 'btn-row' }, buttons) : null,
  ]);
}

/** Двери разделов вместо вкладок: вход в каждый раздел крупной плиткой. */
function doorsSection() {
  const list = VIEWS.filter((view) => view.key !== 'overview');
  if (list.length === 0) return null;
  return el(
    'div',
    { class: 'doors doors-dashboard' },
    list.map((view, index) =>
      el(
        'button',
        {
          class: `door${index === 0 ? ' door-primary' : ''}`,
          attrs: { type: 'button' },
          on: { click: () => go(view.key) },
        },
        [
          el('span', { class: 'door-title', text: view.label }),
          view.desc ? el('span', { class: 'door-note', text: view.desc }) : null,
        ]
      )
    )
  );
}

const statCard = (label, value, sub) =>
  el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: String(value) }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { class: h.num ? 'num' : '', text: h.label })))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

async function reloadStructure() {
  const [teachers, disciplines] = await Promise.all([
    api.get('/api/admin/teachers'),
    api.get('/api/admin/disciplines'),
  ]);
  state.teachers = teachers.teachers || [];
  state.disciplines = disciplines.disciplines || [];
}

/* ------------------------------ Сводка ------------------------------ */

async function renderOverview() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    const data = await api.get('/api/admin/overview');
    const { counts } = data;

    mount(root, [
      pageHead('Сводка', 'Что происходит с обратной связью прямо сейчас', [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Обновить',
          attrs: { type: 'button' },
          on: { click: renderOverview },
        }),
      ]),
      doorsSection(),
      el('div', { class: 'stats' }, [
        statCard('Всего анкет', counts.responses, `сегодня: ${data.recent.day} · за 7 дней: ${data.recent.week}`),
        statCard('Средний балл', data.avg_overall === null ? '-' : fmtNum(data.avg_overall, 2), 'по всем дисциплинам'),
        statCard('Преподавателей', counts.teachers, `дисциплин: ${counts.disciplines}`),
        statCard('Комментариев', counts.comments, `тем занятий: ${counts.topics}`),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [
          el('h2', { text: 'Динамика ответов' }),
          el('span', { class: 'tiny muted', text: `по занятию: ${counts.lesson} · итоговых: ${counts.final}` }),
        ]),
        el('div', { class: 'card' }, [timelineChart(data.timeline || [])]),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [el('h2', { text: 'Дисциплины по числу ответов' })]),
        table(
          [{ label: 'Дисциплина' }, { label: 'Преподаватель' }, { label: 'Анкет', num: true }, { label: 'Средний балл', num: true }],
          data.top_disciplines.map((discipline) =>
            el('tr', {}, [
              el('td', {}, [
                el('div', { text: discipline.title }),
                discipline.is_active ? null : el('span', { class: 'badge badge-warn', text: 'выключена' }),
              ]),
              el('td', { text: discipline.teacher_name || '-' }),
              el('td', { class: 'num', text: String(discipline.responses || 0) }),
              el('td', { class: 'num' }, [
                el('span', { class: scoreClass(discipline.avg), text: discipline.avg === null ? '-' : fmtNum(discipline.avg, 2) }),
              ]),
            ])
          )
        ),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [el('h2', { text: 'Преподаватели' })]),
        table(
          [{ label: 'ФИО' }, { label: 'Логин' }, { label: 'Дисциплин', num: true }, { label: 'Анкет', num: true }, { label: 'Последний вход' }],
          data.teachers.map((teacher) =>
            el('tr', {}, [
              el('td', { text: teacher.full_name }),
              el('td', { class: 'mono small', text: teacher.login }),
              el('td', { class: 'num', text: String(teacher.disciplines) }),
              el('td', { class: 'num', text: String(teacher.responses || 0) }),
              el('td', { text: teacher.last_login_at ? fmtDateTime(teacher.last_login_at) : 'не входил' }),
            ])
          )
        ),
      ]),
      el('div', { class: 'card card-tight' }, [
        el('p', { class: 'small muted', text: data.min_answers_label || '' }),
      ]),
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login?next=/admin/');
      return;
    }
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить данные.' }));
  }
}

/* ------------------------------ Преподаватели ------------------------------ */

function teacherFormModal({ teacher = null, onSaved }) {
  const loginInput = el('input', {
    class: 'input',
    attrs: { value: teacher ? teacher.login : '', placeholder: 'например, ivanova', autocapitalize: 'none', spellcheck: 'false' },
  });
  const nameInput = el('input', {
    class: 'input',
    attrs: { value: teacher ? teacher.full_name : '', placeholder: 'Иванова Мария Петровна' },
  });
  const roleSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Преподаватель', attrs: { value: 'teacher' } }),
    el('option', { text: 'Администратор', attrs: { value: 'admin' } }),
  ]);
  if (teacher) roleSelect.value = teacher.role;

  const passwordInput = el('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: 'оставьте пустым - сгенерируем надёжный пароль' },
  });

  const statusNode = el('div');

  const content = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Логин' }), loginInput, el('span', { class: 'hint', text: 'Латинские буквы, цифры, точка, дефис, подчёркивание. 3-32 символа.' })]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'ФИО' }), nameInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Роль' }), roleSelect]),
    !teacher ? el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Пароль' }), passwordInput]) : null,
    statusNode,
  ]);

  let instance;
  const save = async () => {
    if (!loginInput.value.trim() || !nameInput.value.trim()) {
      mount(statusNode, el('div', { class: 'alert alert-warn', text: 'Заполните логин и ФИО' }));
      return;
    }
    try {
      if (teacher) {
        await api.patch(`/api/admin/teachers/${teacher.id}`, {
          login: loginInput.value.trim(),
          full_name: nameInput.value.trim(),
          role: roleSelect.value,
        });
        toast('Данные обновлены', 'ok');
        instance.close();
      } else {
        const payload = {
          login: loginInput.value.trim(),
          full_name: nameInput.value.trim(),
          role: roleSelect.value,
        };
        if (passwordInput.value.trim()) payload.password = passwordInput.value.trim();
        const data = await api.post('/api/admin/teachers', payload);
        instance.close();
        showPasswordOnce({
          title: `Аккаунт "${payload.login}" создан`,
          password: data.password,
          note: 'Передайте пароль преподавателю надёжным способом. Второй раз он не показывается.',
          onCopy: 'Пароль скопирован',
        });
      }
      await reloadStructure();
      onSaved?.();
    } catch (error) {
      mount(statusNode, el('div', { class: 'alert alert-danger', text: error.message }));
    }
  };

  instance = modal({
    title: teacher ? 'Изменить пользователя' : 'Новый преподаватель',
    content,
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      { label: teacher ? 'Сохранить' : 'Создать', class: 'btn-primary', closeAfter: false, onClick: save },
    ],
  });
}

/** Показ пароля один раз, с кнопкой "скопировать". */
function showPasswordOnce({ title, password, note, onCopy }) {
  const box = el('div', {}, [
    el('div', { class: 'password-box' }, [
      el('span', { text: password }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Скопировать',
        attrs: { type: 'button' },
        on: {
          click: async () => {
            const ok = await copyText(password);
            toast(ok ? onCopy || 'Скопировано' : 'Скопируйте вручную', ok ? 'ok' : 'danger');
          },
        },
      }),
    ]),
    el('p', { class: 'small soft', text: note }),
    el('p', { class: 'tiny muted', text: 'При первом входе система попросит придумать собственный пароль.' }),
  ]);
  modal({
    title,
    content: box,
    actions: [{ label: 'Понятно', class: 'btn-primary' }],
  });
}

async function renderTeachers() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    await reloadStructure();
    const refresh = () => renderTeachers();

    const rows = state.teachers.map((teacher) =>
      el('tr', {}, [
        el('td', {}, [
          el('div', {}, [
            el('strong', { text: teacher.full_name }),
            teacher.role === 'admin' ? el('span', { class: 'badge badge-brand', text: 'админ' }) : null,
          ]),
          el('div', { class: 'tiny muted mono', text: teacher.login }),
        ]),
        el('td', {}, [
          teacher.is_active ? el('span', { class: 'badge badge-ok', text: 'активен' }) : el('span', { class: 'badge badge-danger', text: 'заблокирован' }),
          teacher.must_change_password ? el('span', { class: 'badge badge-warn', text: 'временный пароль' }) : null,
        ]),
        el('td', { class: 'num', text: String(teacher.disciplines_count) }),
        el('td', { class: 'num', text: String(teacher.responses || 0) }),
        el('td', { text: teacher.last_login_at ? fmtDateTime(teacher.last_login_at) : '-' }),
        el('td', { class: 'num' }, [
          el('div', { class: 'row-actions' }, [
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: 'Изменить',
              attrs: { type: 'button' },
              on: { click: () => teacherFormModal({ teacher, onSaved: refresh }) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: 'Новый пароль',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  if (!(await confirmDialog({
                    title: 'Сбросить пароль?',
                    message: `Для "${teacher.full_name}" будет создан новый временный пароль, текущая сессия завершится.`,
                    confirmLabel: 'Сбросить',
                  }))) return;
                  try {
                    const data = await api.post(`/api/admin/teachers/${teacher.id}/reset-password`, {});
                    showPasswordOnce({
                      title: 'Новый пароль',
                      password: data.password,
                      note: 'Передайте пароль преподавателю. Все его активные сессии завершены.',
                    });
                    refresh();
                  } catch (error) {
                    toast(error.message, 'danger');
                  }
                },
              },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: teacher.is_active ? 'Заблокировать' : 'Разблокировать',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  try {
                    await api.patch(`/api/admin/teachers/${teacher.id}`, { is_active: !teacher.is_active });
                    toast(teacher.is_active ? 'Доступ закрыт' : 'Доступ открыт', 'ok');
                    refresh();
                  } catch (error) {
                    toast(error.message, 'danger');
                  }
                },
              },
            }),
            el('button', {
              class: 'btn btn-sm btn-danger',
              text: 'Удалить',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  const others = state.teachers.filter((t) => t.id !== teacher.id);
                  const select = el('select', { class: 'select' }, [
                    el('option', { text: 'оставить дисциплины без преподавателя', attrs: { value: '' } }),
                    ...others.map((t) => el('option', { text: t.full_name, attrs: { value: String(t.id) } })),
                  ]);
                  modal({
                    title: `Удалить "${teacher.full_name}"?`,
                    content: el('div', {}, [
                      el('p', { class: 'soft', text: 'Действие необратимо. Аккаунт и доступ будут удалены.' }),
                      el('div', { class: 'field' }, [
                        el('label', { class: 'label', text: 'Что делать с дисциплинами?' }),
                        select,
                        el('span', { class: 'hint', text: 'Лучше передать другому преподавателю, чтобы отзывы не остались без ответственного.' }),
                      ]),
                    ]),
                    actions: [
                      { label: 'Отмена', class: 'btn-ghost' },
                      {
                        label: 'Удалить',
                        class: 'btn-danger',
                        closeAfter: false,
                        onClick: async ({ close }) => {
                          try {
                            const query = select.value ? `?reassign_to=${select.value}` : '?force=1';
                            await api.del(`/api/admin/teachers/${teacher.id}${query}`);
                            toast('Пользователь удалён', 'ok');
                            close();
                            refresh();
                          } catch (error) {
                            toast(error.message, 'danger');
                          }
                        },
                      },
                    ],
                  });
                },
              },
            }),
          ]),
        ]),
      ])
    );

    mount(root, [
      pageHead('Преподаватели и доступы', `Всего аккаунтов: ${state.teachers.length}`, [
        el('button', {
          class: 'btn btn-sm btn-primary',
          text: '+ Новый преподаватель',
          attrs: { type: 'button' },
          on: { click: () => teacherFormModal({ onSaved: refresh }) },
        }),
      ]),
      el('div', { class: 'alert' }, [
        el('strong', { text: 'Как выдать доступ: ' }),
        'нажмите "Новый преподаватель", укажите логин и ФИО. Пароль сгенерируется и будет показан один раз - передайте его преподавателю. При первом входе он обязан сменить пароль.',
      ]),
      table(
        [
          { label: 'Преподаватель' },
          { label: 'Статус' },
          { label: 'Дисциплин', num: true },
          { label: 'Анкет', num: true },
          { label: 'Последний вход' },
          { label: '', num: true },
        ],
        rows
      ),
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить список.' }));
  }
}

/* ------------------------------ Дисциплины ------------------------------ */

function disciplineFormModal({ discipline = null, onSaved }) {
  const titleInput = el('input', { class: 'input', attrs: { value: discipline ? discipline.title : '', placeholder: 'Дискретная математика' } });
  const codeInput = el('input', { class: 'input', attrs: { value: discipline?.code || '', placeholder: 'DM-201' } });

  const teacherSelect = el('select', { class: 'select' }, [
    el('option', { text: 'не назначен', attrs: { value: '' } }),
    ...state.teachers
      .filter((t) => t.role === 'teacher')
      .map((t) => el('option', { text: `${t.full_name} (${t.login})`, attrs: { value: String(t.id) } })),
  ]);
  if (discipline?.teacher_id) teacherSelect.value = String(discipline.teacher_id);

  const activeSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Открыта для анкетирования', attrs: { value: '1' } }),
    el('option', { text: 'Выключена (студенты не видят)', attrs: { value: '0' } }),
  ]);
  activeSelect.value = discipline && !discipline.is_active ? '0' : '1';

  const statusNode = el('div');
  const content = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Название' }), titleInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Код дисциплины (необязательно)' }), codeInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Преподаватель' }), teacherSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Статус' }), activeSelect]),
    statusNode,
  ]);

  let instance;
  const save = async () => {
    if (!titleInput.value.trim()) {
      mount(statusNode, el('div', { class: 'alert alert-warn', text: 'Введите название дисциплины' }));
      return;
    }
    const payload = {
      title: titleInput.value.trim(),
      code: codeInput.value.trim() || null,
      teacher_id: teacherSelect.value ? Number(teacherSelect.value) : null,
      is_active: activeSelect.value === '1',
    };
    try {
      if (discipline) await api.patch(`/api/admin/disciplines/${discipline.id}`, payload);
      else await api.post('/api/admin/disciplines', payload);
      instance.close();
      toast(discipline ? 'Дисциплина обновлена' : 'Дисциплина создана', 'ok');
      await reloadStructure();
      onSaved?.();
    } catch (error) {
      mount(statusNode, el('div', { class: 'alert alert-danger', text: error.message }));
    }
  };

  instance = modal({
    title: discipline ? 'Изменить дисциплину' : 'Новая дисциплина',
    content,
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      { label: 'Сохранить', class: 'btn-primary', closeAfter: false, onClick: save },
    ],
  });
}

async function renderDisciplines() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    await reloadStructure();
    const refresh = () => renderDisciplines();

    const teacherById = new Map(state.teachers.map((t) => [t.id, t]));

    const rows = state.disciplines.map((discipline) =>
      el('tr', {}, [
        el('td', {}, [
          el('div', {}, [el('strong', { text: discipline.title })]),
          el('div', { class: 'tiny muted' }, [
            discipline.code || 'без кода',
            ' · ',
            `${discipline.topics_count} ${plural(discipline.topics_count, 'тема', 'темы', 'тем')}`,
          ]),
        ]),
        el('td', { text: discipline.teacher_name || (discipline.teacher_id ? '-' : 'не назначен') }),
        el('td', {}, [
          discipline.is_active ? el('span', { class: 'badge badge-ok', text: 'открыта' }) : el('span', { class: 'badge badge-warn', text: 'выключена' }),
        ]),
        el('td', { class: 'num', text: String(discipline.responses || 0) }),
        el('td', { class: 'num' }, [
          el('span', { class: scoreClass(discipline.avg), text: discipline.avg === null ? '-' : fmtNum(discipline.avg, 2) }),
        ]),
        el('td', { class: 'num' }, [
          el('div', { class: 'row-actions' }, [
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: 'Темы',
              attrs: { type: 'button' },
              on: { click: () => topicsModal({ discipline, onSaved: refresh }) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: 'Ссылка/QR',
              attrs: { type: 'button' },
              on: { click: () => qrModal({ discipline }) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: 'Изменить',
              attrs: { type: 'button' },
              on: { click: () => disciplineFormModal({ discipline, onSaved: refresh }) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: discipline.is_active ? 'Выключить' : 'Включить',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  try {
                    await api.patch(`/api/admin/disciplines/${discipline.id}`, { is_active: !discipline.is_active });
                    toast('Статус обновлён', 'ok');
                    refresh();
                  } catch (error) {
                    toast(error.message, 'danger');
                  }
                },
              },
            }),
            el('button', {
              class: 'btn btn-sm btn-danger',
              text: 'Удалить',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  const ok = await confirmDialog({
                    title: `Удалить "${discipline.title}"?`,
                    message:
                      discipline.responses > 0
                        ? `Вместе с дисциплиной будут удалены ${discipline.responses} анкет. Если отзывы нужны - выключите дисциплину вместо удаления.`
                        : 'Действие необратимо.',
                    confirmLabel: 'Удалить',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await api.del(`/api/admin/disciplines/${discipline.id}?force=1`);
                    toast('Дисциплина удалена', 'ok');
                    refresh();
                  } catch (error) {
                    toast(error.message, 'danger');
                  }
                },
              },
            }),
          ]),
        ]),
      ])
    );

    mount(root, [
      pageHead('Дисциплины и темы', `Открыто для студентов: ${state.disciplines.filter((d) => d.is_active).length} из ${state.disciplines.length}`, [
        el('button', {
          class: 'btn btn-sm btn-primary',
          text: '+ Новая дисциплина',
          attrs: { type: 'button' },
          on: { click: () => disciplineFormModal({ onSaved: refresh }) },
        }),
      ]),
      el('div', { class: 'alert' }, [
        el('strong', { text: 'Важно: ' }),
        'студенты видят только дисциплины с хотя бы одной активной темой. Для анкеты по занятию темы обязательны.',
      ]),
      state.disciplines.length === 0
        ? el('div', { class: 'card empty', text: 'Дисциплин пока нет. Начните с создания дисциплины и назначения преподавателя.' })
        : table(
            [
              { label: 'Дисциплина' },
              { label: 'Преподаватель' },
              { label: 'Статус' },
              { label: 'Анкет', num: true },
              { label: 'Средний балл', num: true },
              { label: '', num: true },
            ],
            rows
          ),
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить дисциплины.' }));
  }
}

/* ------------------------------ Темы дисциплины ------------------------------ */

async function topicsModal({ discipline, onSaved }) {
  const listNode = el('div', {}, [el('div', { class: 'skeleton' })]);
  const bulkArea = el('textarea', {
    class: 'textarea',
    attrs: {
      placeholder: 'По одной теме в строке. Можно указать дату через "|": Введение | 2026-09-05',
      rows: '4',
    },
  });

  const newTitle = el('input', { class: 'input', attrs: { placeholder: 'Название темы' } });
  const newDate = el('input', { class: 'input', attrs: { type: 'date' } });
  const statusNode = el('div');

  let instance;

  const load = async () => {
    try {
      const data = await api.get(`/api/admin/disciplines/${discipline.id}/topics`);
      const topics = data.topics || [];
      if (topics.length === 0) {
        mount(listNode, el('div', { class: 'empty', text: 'Тем пока нет - добавьте хотя бы одну, иначе студенты не увидят дисциплину.' }));
        return;
      }
      mount(
        listNode,
        el(
          'ul',
          { class: 'topic-list' },
          topics.map((topic) =>
            el('li', { class: `topic-item${topic.is_active ? '' : ' inactive'}` }, [
              el('div', { class: 'grow' }, [
                el('div', { text: topic.title }),
                el('div', { class: 'tiny muted' }, [
                  topic.lesson_date ? `дата: ${topic.lesson_date}` : 'без даты',
                  ` · анкет: ${topic.responses}`,
                  topic.avg ? ` · средний балл: ${fmtNum(topic.avg, 2)}` : '',
                ]),
              ]),
              el('button', {
                class: 'btn btn-sm btn-ghost',
                text: 'Изменить',
                attrs: { type: 'button' },
                on: {
                  click: () => {
                    const title = el('input', { class: 'input', attrs: { value: topic.title } });
                    const date = el('input', { class: 'input', attrs: { type: 'date', value: topic.lesson_date || '' } });
                    const errorNode = el('div');
                    const inner = modal({
                      title: 'Изменить тему',
                      content: el('div', {}, [
                        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Название' }), title]),
                        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Дата занятия' }), date]),
                        errorNode,
                      ]),
                      actions: [
                        { label: 'Отмена', class: 'btn-ghost' },
                        {
                          label: 'Сохранить',
                          class: 'btn-primary',
                          closeAfter: false,
                          onClick: async () => {
                            try {
                              await api.patch(`/api/admin/topics/${topic.id}`, {
                                title: title.value.trim(),
                                lesson_date: date.value || null,
                              });
                              inner.close();
                              toast('Тема обновлена', 'ok');
                              await load();
                              onSaved?.();
                            } catch (error) {
                              mount(errorNode, el('div', { class: 'alert alert-danger', text: error.message }));
                            }
                          },
                        },
                      ],
                    });
                  },
                },
              }),
              el('button', {
                class: 'btn btn-sm btn-ghost',
                text: topic.is_active ? 'Выключить' : 'Включить',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    try {
                      await api.patch(`/api/admin/topics/${topic.id}`, { is_active: !topic.is_active });
                      await load();
                      onSaved?.();
                    } catch (error) {
                      toast(error.message, 'danger');
                    }
                  },
                },
              }),
              el('button', {
                class: 'btn btn-sm btn-danger',
                text: 'Удалить',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const ok = await confirmDialog({
                      title: 'Удалить тему?',
                      message: topic.responses > 0 ? `По теме уже собрано анкет: ${topic.responses}. Они будут удалены.` : 'Действие необратимо.',
                      confirmLabel: 'Удалить',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.del(`/api/admin/topics/${topic.id}?force=1`);
                      await load();
                      onSaved?.();
                    } catch (error) {
                      toast(error.message, 'danger');
                    }
                  },
                },
              }),
            ])
          )
        )
      );
    } catch (error) {
      mount(listNode, el('div', { class: 'alert alert-danger', text: error.message }));
    }
  };

  const content = el('div', {}, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Добавить тему' }),
      el('div', { class: 'copy-row' }, [newTitle, newDate]),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: 'Добавить',
        attrs: { type: 'button' },
        on: {
          click: async () => {
            if (!newTitle.value.trim()) return toast('Введите название темы', 'danger');
            try {
              await api.post('/api/admin/topics', {
                discipline_id: discipline.id,
                title: newTitle.value.trim(),
                lesson_date: newDate.value || null,
              });
              newTitle.value = '';
              newDate.value = '';
              toast('Тема добавлена', 'ok');
              await load();
              onSaved?.();
            } catch (error) {
              toast(error.message, 'danger');
            }
          },
        },
      }),
    ]),
    el('hr', { style: { border: 'none', 'border-top': '1px solid var(--border)', margin: '16px 0' } }),
    listNode,
    el('details', {}, [
      el('summary', { class: 'small soft', style: { cursor: 'pointer' }, text: 'Добавить несколько тем сразу' }),
      el('div', { class: 'field', style: { 'margin-top': '10px' } }, [
        bulkArea,
        el('span', { class: 'hint', text: 'Формат: "Название | 2026-09-05" или просто "Название".' }),
      ]),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Загрузить список',
        attrs: { type: 'button' },
        on: {
          click: async () => {
            const lines = bulkArea.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            if (lines.length === 0) return toast('Введите хотя бы одну тему', 'danger');
            const topics = lines.map((line) => {
              const [title, date] = line.split('|').map((part) => part.trim());
              return { title, lesson_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
            });
            try {
              const result = await api.post(`/api/admin/disciplines/${discipline.id}/topics/bulk`, { topics });
              toast(`Добавлено тем: ${result.created}`, 'ok');
              bulkArea.value = '';
              await load();
              onSaved?.();
            } catch (error) {
              toast(error.message, 'danger');
            }
          },
        },
      }),
    ]),
    statusNode,
  ]);

  instance = modal({
    title: `Темы: ${discipline.title}`,
    content,
    wide: true,
    actions: [{ label: 'Закрыть', class: 'btn-ghost' }],
  });
  await load();
}

/* ------------------------------ QR и ссылки ------------------------------ */

function buildFormUrl({ disciplineId, topicId, formType }) {
  return studentUrl('/form.html', {
    discipline: disciplineId,
    topic: topicId,
    form: formType,
  });
}

function qrModal({ discipline = null, topic = null }) {
  const disciplineSelect = el('select', { class: 'select' }, [
    el('option', { text: 'любая дисциплина', attrs: { value: '' } }),
    ...state.disciplines.map((d) => el('option', { text: d.title, attrs: { value: String(d.id) } })),
  ]);
  if (discipline) disciplineSelect.value = String(discipline.id);
  if (topic) disciplineSelect.value = String(topic.discipline_id ?? discipline?.id ?? '');

  const formSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Студент выберет сам', attrs: { value: '' } }),
    el('option', { text: 'Анкета по занятию', attrs: { value: 'lesson' } }),
    el('option', { text: 'Итоговая по дисциплине', attrs: { value: 'final' } }),
  ]);

  const linkInput = el('input', { class: 'input', attrs: { readonly: true } });
  const image = el('img', { attrs: { alt: 'QR-код со ссылкой на анкету', width: '280', height: '280' } });

  const update = () => {
    const url = buildFormUrl({
      disciplineId: disciplineSelect.value || null,
      topicId: null,
      formType: formSelect.value || null,
    });
    linkInput.value = url;
    image.src = `/api/admin/qr.png?${new URLSearchParams({
      ...(disciplineSelect.value ? { discipline_id: disciplineSelect.value } : {}),
      ...(formSelect.value ? { form_type: formSelect.value } : {}),
      size: '512',
    })}`;
  };

  const content = el('div', {}, [
    el('div', { class: 'grid grid-2' }, [
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Дисциплина' }), disciplineSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Тип анкеты' }), formSelect]),
    ]),
    el('div', { class: 'qr-box' }, [
      image,
      el('div', { class: 'copy-row' }, [
        linkInput,
        el('button', {
          class: 'btn btn-sm',
          text: 'Скопировать',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              const ok = await copyText(linkInput.value);
              toast(ok ? 'Ссылка скопирована' : 'Скопируйте вручную', ok ? 'ok' : 'danger');
            },
          },
        }),
      ]),
      el('a', {
        class: 'btn btn-sm btn-ghost',
        text: 'Скачать PNG',
        attrs: { href: image.src, download: 'qr-feedback.png' },
      }),
    ]),
    el('p', { class: 'tiny muted', text: 'QR-код ведёт на публичную страницу анкеты. Регистрация студентам не нужна.' }),
  ]);

  disciplineSelect.addEventListener('change', update);
  formSelect.addEventListener('change', update);
  update();

  modal({
    title: 'Ссылка и QR-код для студентов',
    content,
    wide: true,
    actions: [{ label: 'Закрыть', class: 'btn-ghost' }],
  });
}

async function renderQr() {
  setAlert('');
  try {
    await reloadStructure();
  } catch (error) {
    setAlert(error.message, 'danger');
  }

  mount(root, [
    pageHead('QR-коды и ссылки', 'Распечатайте QR-код или отправьте ссылку в чат группы'),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Универсальная ссылка' }),
      el('p', { class: 'soft small', text: 'Студент сам выберет дисциплину, тему и тип анкеты.' }),
      el(
        'div',
        { class: 'copy-row' },
        (() => {
          const url = studentUrl('/form.html');
          const input = el('input', { class: 'input', attrs: { readonly: true, value: url } });
          return [
            input,
            el('button', {
              class: 'btn btn-sm',
              text: 'Скопировать',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  const ok = await copyText(url);
                  toast(ok ? 'Скопировано' : 'Скопируйте вручную', ok ? 'ok' : 'danger');
                },
              },
            }),
            el('a', { class: 'btn btn-sm btn-ghost', attrs: { href: '/api/admin/qr.png', download: 'qr-feedback.png' }, text: 'QR-код (PNG)' }),
          ];
        })()
      ),
    ]),
    el('section', { class: 'section' }, [
      el('h2', { text: 'Ссылки по дисциплинам' }),
      state.disciplines.length === 0
        ? el('div', { class: 'card empty', text: 'Сначала создайте дисциплину.' })
        : el(
            'div',
            { class: 'card-list' },
            state.disciplines.map((discipline) =>
              el('div', { class: 'card card-tight' }, [
                el('div', { class: 'tile-title', text: discipline.title }),
                el('div', { class: 'tile-meta' }, [
                  discipline.code ? el('span', { class: 'badge', text: discipline.code }) : null,
                  el('span', { text: discipline.teacher_name || 'преподаватель не назначен' }),
                  discipline.is_active ? el('span', { class: 'badge badge-ok', text: 'открыта' }) : el('span', { class: 'badge badge-warn', text: 'выключена' }),
                ]),
                el('div', { class: 'btn-row' }, [
                  el('button', {
                    class: 'btn btn-sm btn-primary',
                    text: 'Показать QR',
                    attrs: { type: 'button' },
                    on: { click: () => qrModal({ discipline }) },
                  }),
                  el('a', {
                    class: 'btn btn-sm btn-ghost',
                    attrs: { href: buildFormUrl({ disciplineId: discipline.id }), target: '_blank', rel: 'noopener' },
                    text: 'Открыть анкету',
                  }),
                ]),
              ])
            )
          ),
    ]),
  ]);
}

/* ------------------------------ Отчёты ------------------------------ */

async function renderReports() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    await reloadStructure();

    const teacherSelect = el('select', { class: 'select' }, [
      el('option', { text: 'Все преподаватели', attrs: { value: '' } }),
      ...state.teachers.map((t) => el('option', { text: t.full_name, attrs: { value: String(t.id) } })),
    ]);
    if (state.filters.teacherId) teacherSelect.value = String(state.filters.teacherId);

    const disciplineSelect = el('select', { class: 'select' }, [
      el('option', { text: 'Все дисциплины', attrs: { value: '' } }),
      ...state.disciplines.map((d) => el('option', { text: d.title, attrs: { value: String(d.id) } })),
    ]);
    if (state.filters.disciplineId) disciplineSelect.value = String(state.filters.disciplineId);

    const formSelect = el('select', { class: 'select' }, [
      el('option', { text: 'Оба типа', attrs: { value: '' } }),
      el('option', { text: 'По занятию', attrs: { value: 'lesson' } }),
      el('option', { text: 'Итоговая', attrs: { value: 'final' } }),
    ]);
    if (state.filters.formType) formSelect.value = state.filters.formType;

    const fromInput = el('input', { class: 'input', attrs: { type: 'date', value: state.filters.from || '' } });
    const toInput = el('input', { class: 'input', attrs: { type: 'date', value: state.filters.to || '' } });

    const render = async () => {
      state.filters = {
        teacherId: teacherSelect.value ? Number(teacherSelect.value) : null,
        disciplineId: disciplineSelect.value ? Number(disciplineSelect.value) : null,
        formType: formSelect.value || null,
        from: fromInput.value,
        to: toInput.value,
      };
      setParams({
        teacher: state.filters.teacherId,
        discipline: state.filters.disciplineId,
        form: state.filters.formType,
        from: state.filters.from || null,
        to: state.filters.to || null,
      });
      await renderReports();
    };

    const params = new URLSearchParams();
    if (state.filters.teacherId) params.set('teacher_id', state.filters.teacherId);
    if (state.filters.disciplineId) params.set('discipline_id', state.filters.disciplineId);
    if (state.filters.formType) params.set('form_type', state.filters.formType);
    if (state.filters.from) params.set('from', state.filters.from);
    if (state.filters.to) params.set('to', state.filters.to);

    const report = await api.get(`/api/admin/report?${params}`);

    const formBlocks = report.forms.map((form) =>
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [
          el('h2', { text: form.title }),
          el('span', { class: 'badge', text: `анкет: ${form.responses}` }),
          form.avg_of_items !== null ? el('span', { class: 'badge badge-brand', text: `средний балл: ${fmtNum(form.avg_of_items, 2)}` }) : null,
        ]),
        el(
          'div',
          { class: 'card card-tight' },
          form.questions.map((question) =>
            el('div', { class: 'question-row' }, [
              el('div', {}, [
                el('div', { class: 'q-label', text: question.label }),
                el('div', { style: { 'margin-top': '8px' } }, [positiveBar(question.positive_ratio)]),
              ]),
              distributionBars(question.distribution, question.count),
              el('div', { class: 'center' }, [
                el('div', { class: scoreClass(question.avg), text: question.avg === null ? '-' : fmtNum(question.avg, 2) }),
                el('div', { class: 'tiny muted', text: `ответов: ${question.count}` }),
              ]),
            ])
          )
        ),
        [...form.comments, ...(form.archived_comments || [])].length > 0
          ? el('div', { class: 'comments-grid', style: { 'margin-top': '16px' } }, [
              ...[...form.comments, ...(form.archived_comments || [])].map((group) =>
                el('div', { class: 'comment-group card' }, [
                  el('h3', {}, [
                    el('span', { text: group.label }),
                    group.legacy ? el('span', { class: 'badge', text: 'вопрос снят с анкеты' }) : null,
                    el('span', { class: 'badge badge-brand', text: String(group.items.length) }),
                  ]),
                  ...group.items.slice(0, 50).map((item) =>
                    el('div', { class: 'comment' }, [
                      el('div', { class: 'comment-body', text: item.body }),
                      el('div', { class: 'comment-meta' }, [
                        el('span', { text: fmtDate(item.created_date) }),
                        item.discipline_title ? el('span', { text: item.discipline_title }) : null,
                        item.topic_title ? el('span', { text: item.topic_title }) : null,
                      ]),
                    ])
                  ),
                ])
              ),
            ])
          : null,
      ])
    );

    mount(root, [
      pageHead('Сквозные отчёты', 'Агрегация анонимных ответов по всем преподавателям и дисциплинам', [
        el('a', { class: 'btn btn-sm btn-primary', text: 'Скачать CSV', attrs: { href: `/api/admin/export.csv?${params}` } }),
        el('button', { class: 'btn btn-sm btn-ghost', text: 'Печать', attrs: { type: 'button' }, on: { click: () => window.print() } }),
      ]),
      el('div', { class: 'filter-bar' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Преподаватель' }), teacherSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Дисциплина' }), disciplineSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Тип анкеты' }), formSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'С даты' }), fromInput]),
        el('div', { class: 'field' }, [el('label', { text: 'По дату' }), toInput]),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn btn-sm btn-primary', text: 'Применить', attrs: { type: 'button' }, on: { click: render } }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Сбросить',
            attrs: { type: 'button' },
            on: {
              click: () => {
                teacherSelect.value = '';
                disciplineSelect.value = '';
                formSelect.value = '';
                fromInput.value = '';
                toInput.value = '';
                render();
              },
            },
          }),
        ]),
      ]),
      el('div', { class: 'stats' }, [
        statCard('Всего анкет', report.total_responses ?? 0),
        statCard('Средний балл', report.overall_avg === null ? '-' : fmtNum(report.overall_avg, 2)),
        statCard('По занятиям', report.by_form?.lesson ?? 0),
        statCard('Итоговых', report.by_form?.final ?? 0),
      ]),
      el('section', { class: 'section' }, [
        el('div', { class: 'section-title' }, [el('h2', { text: 'Динамика' })]),
        el('div', { class: 'card' }, [timelineChart(report.timeline || [])]),
      ]),
      report.total_responses === 0 ? el('div', { class: 'alert alert-warn', text: 'По выбранным фильтрам нет ни одной анкеты.' }) : null,
      ...formBlocks,
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось построить отчёт.' }));
  }
}

/* ------------------------------ Журнал ------------------------------ */

async function renderAudit() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');
  try {
    const data = await api.get('/api/admin/audit?limit=200');
    mount(root, [
      pageHead('Журнал действий', 'Кто и что менял в системе (пароли и тексты отзывов в журнал не попадают)'),
      data.events.length === 0
        ? el('div', { class: 'card empty', text: 'Событий пока нет.' })
        : table(
            [{ label: 'Когда' }, { label: 'Кто' }, { label: 'Роль' }, { label: 'Действие' }, { label: 'Объект' }, { label: 'Детали' }],
            data.events.map((event) =>
              el('tr', {}, [
                el('td', { class: 'small', text: fmtDateTime(event.created_at) }),
                el('td', { class: 'mono small', text: event.actor_login || 'anonymous' }),
                el('td', { class: 'small', text: event.actor_role || '' }),
                el('td', {}, [el('span', { class: 'badge', text: event.action })]),
                el('td', { class: 'small', text: event.entity ? `${event.entity} #${event.entity_id ?? ''}` : '-' }),
                el('td', { class: 'tiny muted', text: event.details || '' }),
              ])
            )
          ),
    ]);
  } catch (error) {
    setAlert(error.message, 'danger');
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить журнал.' }));
  }
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
  loadStudentBase();
  let me = null;
  try {
    me = (await api.get('/api/auth/me')).user;
  } catch {
    me = null;
  }

  if (!me) {
    window.location.replace('/login?next=/admin/');
    return;
  }

  // Роль проверяем до редиректа: иначе вход с next=/admin/ вернул бы сюда же,
  // и страница начала бы перезагрузиваться по кругу.
  if (me.role !== 'admin') {
    mount(root, el('div', { class: 'card' }, [
      el('h1', { text: 'Недостаточно прав' }),
      el('p', { class: 'soft', text: 'Это панель администратора, а вы вошли как преподаватель. Откройте кабинет - там ваши дисциплины, занятия и отчёты.' }),
      el('a', { class: 'btn btn-primary', attrs: { href: '/portal/' }, text: 'Перейти в кабинет' }),
    ]));
    return;
  }

  state.user = me;
  userBadge.textContent = `${me.full_name} · администратор`;

  if (state.user.must_change_password) {
    mount(root, el('div', { class: 'card' }, [
      el('h1', { text: 'Смените временный пароль' }),
      el('p', { class: 'soft', text: 'Пока пароль не изменён, админ-панель недоступна.' }),
      el('a', { class: 'btn btn-primary', attrs: { href: '/login' }, text: 'Перейти к смене пароля' }),
    ]));
    return;
  }

  const viewParam = qsParam('view');
  state.view = VIEWS.some((v) => v.key === viewParam) ? viewParam : 'overview';
  if (qsParam('teacher')) state.filters.teacherId = Number(qsParam('teacher'));
  if (qsParam('discipline')) state.filters.disciplineId = Number(qsParam('discipline'));
  if (qsParam('form')) state.filters.formType = qsParam('form');
  if (qsParam('from')) state.filters.from = qsParam('from');
  if (qsParam('to')) state.filters.to = qsParam('to');

  renderNav();
  go(state.view);
})();
