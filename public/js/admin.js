/**
 * Админ-панель.
 *
 * Без вкладок: одна главная с шестью «дверями» в разделы
 * (Сводка / Преподаватели / Дисциплины и темы / Отчёты / QR и ссылки /
 * Журнал действий), и шесть подэкранов.
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
  studentUrl,
} from './api.js';
import { timelineChart, distributionBars, positiveBar } from './charts.js';
import { renderDisciplineTable, disciplineFormModal, topicsModal } from './discipline-manager.js';

const state = {
  user: null,
  view: 'home',
  teachers: [],
  disciplines: [],
  filters: { teacherId: null, disciplineId: null, formType: null, from: '', to: '' },
};

const root = document.querySelector('#view-root');
const alertsNode = document.querySelector('#view-alerts');
const userBadge = document.querySelector('#user-badge');

const VIEWS = {
  home: { label: 'Сводка', render: renderHome },
  teachers: { label: 'Преподаватели', render: renderTeachers },
  disciplines: { label: 'Дисциплины и темы', render: renderDisciplines },
  reports: { label: 'Отчёты', render: renderReports },
  qr: { label: 'QR и ссылки', render: renderQr },
  audit: { label: 'Журнал действий', render: renderAudit },
};

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
  const v = VIEWS[view] || VIEWS.home;
  return v.render();
}

function backLink() {
  return el(
    'a',
    {
      class: 'back-link',
      attrs: { href: '/admin/' },
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

const exportUrl = (base, filters) => {
  const params = new URLSearchParams();
  if (filters.teacherId) params.set('teacher_id', filters.teacherId);
  if (filters.disciplineId) params.set('discipline_id', filters.disciplineId);
  if (filters.topicId) params.set('topic_id', filters.topicId);
  if (filters.formType) params.set('form_type', filters.formType);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const q = params.toString();
  return `${base}${q ? `?${q}` : ''}`;
};

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

async function reloadStructure() {
  const [teachers, disciplines] = await Promise.all([
    api.get('/api/admin/teachers').then((d) => d.teachers || []),
    api.get('/api/admin/disciplines').then((d) => d.disciplines || []),
  ]);
  state.teachers = teachers;
  state.disciplines = disciplines;
}

/* ------------------------------ Главная ------------------------------ */

async function renderHome() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  let data;
  try {
    data = await api.get('/api/admin/overview');
  } catch (error) {
    setAlert(error.message, 'danger');
    if (error.status === 401) {
      window.location.replace('/login?next=/admin/');
      return;
    }
    mount(root, el('div', { class: 'card empty', text: 'Не удалось загрузить данные. Обновите страницу.' }));
    return;
  }

  const c = data.counts || {};
  const teachers = data.teachers || [];
  const doors = el('div', { class: 'doors' }, [
    doorCard({
      title: 'Преподаватели',
      hint: 'Создание и удаление учётных записей, сброс паролей',
      href: '?view=teachers',
      badge: String(teachers.length || 0),
    }),
    doorCard({
      title: 'Дисциплины и темы',
      hint: 'Создание дисциплин, тем занятий, назначение преподавателей',
      primary: true,
      href: '?view=disciplines',
      badge: String(c.disciplines || 0),
    }),
    doorCard({
      title: 'Отчёты',
      hint: 'Сквозные отчёты по всем преподавателям, выгрузка в CSV',
      href: '?view=reports',
    }),
    doorCard({
      title: 'QR и ссылки',
      hint: 'Универсальная ссылка и QR-код для размещения в LMS/чате',
      href: '?view=qr',
    }),
    doorCard({
      title: 'Журнал действий',
      hint: 'Кто, когда и что менял в системе',
      href: '?view=audit',
    }),
  ]);

  const stats = el('div', { class: 'stats stats-home' }, [
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Преподавателей' }), el('div', { class: 'stat-value', text: String(teachers.length || 0) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Дисциплин' }), el('div', { class: 'stat-value', text: String(c.disciplines || 0) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Тем' }), el('div', { class: 'stat-value', text: String(c.topics || 0) })]),
    el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Ответов' }), el('div', { class: 'stat-value', text: String(c.responses || 0) })]),
  ]);

  const recentList = el('div', { class: 'card card-flat' }, [
    el('h3', { text: 'Сводка по ответам' }),
    el('div', { class: 'row' }, [
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Средний балл' }), el('span', { class: 'v', text: data.avg_overall === null ? '—' : fmtNum(data.avg_overall, 2) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'За день' }), el('span', { class: 'v', text: String((data.recent || {}).day || 0) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'За неделю' }), el('span', { class: 'v', text: String((data.recent || {}).week || 0) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'За месяц' }), el('span', { class: 'v', text: String((data.recent || {}).month || 0) })]),
    ]),
  ]);

  mount(root, [
    el('div', { class: 'hello' }, [
      el('h1', { text: `Здравствуйте, ${state.user.full_name || ''}`.trim() }),
      el('p', { class: 'sub', text: 'Выберите раздел, чтобы продолжить.' }),
    ]),
    stats,
    doors,
    recentList,
  ]);
}

/* ------------------------------ Преподаватели ------------------------------ */

function teacherFormModal({ teacher = null, onSaved }) {
  const loginInput = el('input', { class: 'input', attrs: { value: teacher ? teacher.login : '', placeholder: 'логин латиницей' } });
  const nameInput = el('input', { class: 'input', attrs: { value: teacher ? teacher.full_name : '', placeholder: 'Иванов Иван Иванович' } });
  const passwordInput = el('input', { class: 'input', attrs: { type: 'password', placeholder: 'пароль (опционально, ≥8 символов)' } });
  const roleSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Преподаватель', attrs: { value: 'teacher' } }),
    el('option', { text: 'Администратор', attrs: { value: 'admin' } }),
  ]);
  if (teacher) roleSelect.value = teacher.role;
  const activeSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Активен', attrs: { value: '1' } }),
    el('option', { text: 'Заблокирован', attrs: { value: '0' } }),
  ]);
  if (teacher) activeSelect.value = String(teacher.is_active ? 1 : 0);
  const status = el('div');
  const fields = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Логин' }), loginInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'ФИО' }), nameInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Роль' }), roleSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Статус' }), activeSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: teacher ? 'Новый пароль (опционально)' : 'Пароль (опционально)' }), passwordInput]),
    status,
  ]);
  let instance;
  const save = async () => {
    if (!loginInput.value.trim() || !nameInput.value.trim()) {
      mount(status, el('div', { class: 'alert alert-warn', text: 'Заполните логин и ФИО.' }));
      return;
    }
    const payload = {
      login: loginInput.value.trim(),
      full_name: nameInput.value.trim(),
      role: roleSelect.value,
      is_active: activeSelect.value === '1',
    };
    if (passwordInput.value) payload.password = passwordInput.value;
    try {
      if (teacher) await api.patch(`/api/admin/teachers/${teacher.id}`, payload);
      else await api.post('/api/admin/teachers', payload);
      instance.close();
      toast(teacher ? 'Преподаватель обновлён' : 'Преподаватель создан', 'ok');
      onSaved?.();
    } catch (error) {
      mount(status, el('div', { class: 'alert alert-danger', text: error.message }));
    }
  };
  instance = modal({
    title: teacher ? 'Изменить преподавателя' : 'Новый преподаватель',
    content: fields,
    actions: [
      { label: 'Отмена', class: 'btn-ghost' },
      { label: 'Сохранить', class: 'btn-primary', closeAfter: false, onClick: save },
    ],
  });
}

async function renderTeachers() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  let teachers = [];
  try {
    const data = await api.get('/api/admin/teachers');
    teachers = data.teachers || [];
  } catch (error) {
    setAlert(error.message, 'danger');
    return;
  }

  const refresh = () => renderTeachers();

  const rows = teachers.map((t) =>
    el('tr', {}, [
      el('td', {}, [el('div', { text: t.full_name }), el('div', { class: 'tiny muted', text: t.login })]),
      el('td', { text: t.role === 'admin' ? 'Администратор' : 'Преподаватель' }),
      el('td', { text: t.is_active ? 'Активен' : 'Заблокирован' }),
      el('td', { class: 'num', text: String(t.responses || 0) }),
      el('td', { class: 'num' }, [el('span', { class: scoreClass(t.avg), text: t.avg === null ? '—' : fmtNum(t.avg, 2) })]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-sm btn-ghost', text: 'Изменить', attrs: { type: 'button' }, on: { click: () => teacherFormModal({ teacher: t, onSaved: refresh }) } }),
        el('button', {
          class: 'btn btn-sm btn-danger',
          text: 'Удалить',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              const ok = await confirmDialog({ title: `Удалить «${t.full_name}»?`, message: 'Действие необратимо.', confirmLabel: 'Удалить', danger: true });
              if (!ok) return;
              try {
                await api.del(`/api/admin/teachers/${t.id}`);
                toast('Удалён', 'ok');
                refresh();
              } catch (e) { toast(e.message, 'danger'); }
            },
          },
        }),
      ])]),
    ])
  );

  mount(root, [
    pageHead('Преподаватели', 'Учётные записи, роли и статусы', [
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: '+ Новый преподаватель',
        attrs: { type: 'button' },
        on: { click: () => teacherFormModal({ onSaved: refresh }) },
      }),
    ]),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Преподаватель' }),
            el('th', { text: 'Роль' }),
            el('th', { text: 'Статус' }),
            el('th', { class: 'num', text: 'Ответов' }),
            el('th', { class: 'num', text: 'Средний' }),
            el('th', { text: '' }),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]);
}

/* ------------------------------ Дисциплины и темы ------------------------------ */

async function renderDisciplines() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  try {
    await reloadStructure();
  } catch (error) {
    setAlert(error.message, 'danger');
    return;
  }

  const refresh = () => renderDisciplines();
  const teacherById = new Map(state.teachers.map((t) => [t.id, t]));

  mount(root, [
    pageHead('Дисциплины и темы', `Открыто для студентов: ${state.disciplines.filter((d) => d.is_active).length} из ${state.disciplines.length}`, [
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: '+ Новая дисциплина',
        attrs: { type: 'button' },
        on: { click: () => disciplineFormModal({ teacherById, canEditTeacher: true, scope: 'admin', onSaved: refresh }) },
      }),
    ]),
    state.disciplines.length === 0
      ? el('div', { class: 'card empty', text: 'Дисциплин пока нет. Создайте первую.' })
      : renderDisciplineTable({
          disciplines: state.disciplines,
          reload: refresh,
          teacherById,
          actions: { canEditTeacher: true, scope: 'admin' },
        }),
  ]);
}

/* ------------------------------ Отчёты ------------------------------ */

async function renderReports() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  try {
    await reloadStructure();
  } catch (error) {
    setAlert(error.message, 'danger');
    return;
  }

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

  const reportRoot = el('div', {});

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
      from: state.filters.from,
      to: state.filters.to,
    });
    try {
      const report = await api.get('/api/admin/report?' + new URLSearchParams({
        ...(state.filters.teacherId ? { teacher_id: state.filters.teacherId } : {}),
        ...(state.filters.disciplineId ? { discipline_id: state.filters.disciplineId } : {}),
        ...(state.filters.formType ? { form_type: state.filters.formType } : {}),
        ...(state.filters.from ? { from: state.filters.from } : {}),
        ...(state.filters.to ? { to: state.filters.to } : {}),
      }).toString());
      mount(reportRoot, [
        el('div', { class: 'stats' }, [
          el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Всего' }), el('div', { class: 'stat-value', text: String(report.total_responses || 0) })]),
          el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Средний' }), el('div', { class: 'stat-value', text: report.overall_avg === null ? '—' : fmtNum(report.overall_avg, 2) })]),
          el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'По занятиям' }), el('div', { class: 'stat-value', text: String((report.by_form || {}).lesson || 0) })]),
          el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: 'Итоговых' }), el('div', { class: 'stat-value', text: String((report.by_form || {}).final || 0) })]),
        ]),
        el('div', { class: 'card' }, [timelineChart(report.timeline || [])]),
      ]);
    } catch (error) {
      setAlert(error.message, 'danger');
    }
  };

  const filterCard = el('div', { class: 'card filter-bar' }, [
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Преподаватель' }), teacherSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Дисциплина' }), disciplineSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Тип анкеты' }), formSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'С даты' }), fromInput]),
    el('div', { class: 'field' }, [el('label', { class: 'label', text: 'По дату' }), toInput]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-sm', text: 'Показать', attrs: { type: 'button' }, on: { click: render } }),
      el('a', { class: 'btn btn-sm btn-primary', text: 'Скачать CSV', attrs: { href: exportUrl('/api/admin/export.csv', state.filters) } }),
    ]),
  ]);

  mount(root, [pageHead('Отчёты', 'Сквозные отчёты и выгрузка в CSV'), filterCard, reportRoot]);
  await render();
}

/* ------------------------------ QR ------------------------------ */

function buildFormUrl({ disciplineId, topicId, formType }) {
  return studentUrl('/form.html', { discipline: disciplineId, topic: topicId, form: formType });
}

function qrModal({ discipline = null, topic = null }) {
  const disciplineSelect = el('select', { class: 'select' }, [
    el('option', { text: '— любая дисциплина —', attrs: { value: '' } }),
    ...state.disciplines.map((d) => el('option', { text: d.title, attrs: { value: String(d.id) } })),
  ]);
  if (discipline) disciplineSelect.value = String(discipline.id);

  const formSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Обе анкеты (по выбору студента)', attrs: { value: '' } }),
    el('option', { text: 'Только по занятию', attrs: { value: 'lesson' } }),
    el('option', { text: 'Только итоговая', attrs: { value: 'final' } }),
  ]);

  const topicSelect = el('select', { class: 'select' }, [
    el('option', { text: '— все темы —', attrs: { value: '' } }),
  ]);
  const refreshTopics = async () => {
    if (!disciplineSelect.value) {
      mount(topicSelect, [el('option', { text: '— все темы —', attrs: { value: '' } })]);
      return;
    }
    try {
      const data = await api.get(`/api/admin/disciplines/${disciplineSelect.value}/topics`);
      mount(topicSelect, [
        el('option', { text: '— все темы —', attrs: { value: '' } }),
        ...(data.topics || []).map((t) => el('option', { text: t.title, attrs: { value: String(t.id) } })),
      ]);
      if (topic) topicSelect.value = String(topic.id);
    } catch (error) {
      mount(topicSelect, [el('option', { text: '— все темы —', attrs: { value: '' } })]);
    }
  };
  disciplineSelect.addEventListener('change', refreshTopics);

  const linkInput = el('input', { class: 'input', attrs: { readonly: true } });
  const qrImage = el('img', { attrs: { alt: 'QR-код', width: '220', height: '220' } });

  const update = () => {
    const params = new URLSearchParams();
    if (disciplineSelect.value) params.set('discipline_id', disciplineSelect.value);
    if (topicSelect.value) params.set('topic_id', topicSelect.value);
    if (formSelect.value) params.set('form_type', formSelect.value);
    const url = buildFormUrl({
      disciplineId: disciplineSelect.value ? Number(disciplineSelect.value) : null,
      topicId: topicSelect.value ? Number(topicSelect.value) : null,
      formType: formSelect.value || null,
    });
    linkInput.value = url;
    qrImage.src = `/api/admin/qr.png?${params.toString()}&size=320`;
  };

  const content = el('div', { class: 'qr-block' }, [
    el('div', {}, [
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Дисциплина' }), disciplineSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Тема' }), topicSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Тип анкеты' }), formSelect]),
      el('div', { class: 'qr-row' }, [
        el('label', { class: 'label', text: 'Ссылка' }),
        el('div', { class: 'copy-row' }, [
          linkInput,
          el('button', {
            class: 'btn btn-sm',
            text: 'Скопировать',
            attrs: { type: 'button' },
            on: { click: async () => { const ok = await copyText(linkInput.value); toast(ok ? 'Скопировано' : 'Не удалось', ok ? 'ok' : 'danger'); } },
          }),
        ]),
      ]),
    ]),
    el('div', { class: 'qr-img' }, [qrImage]),
  ]);

  disciplineSelect.addEventListener('change', update);
  topicSelect.addEventListener('change', update);
  formSelect.addEventListener('change', update);
  refreshTopics().then(update);

  modal({ title: 'QR и ссылка', content, wide: true, actions: [{ label: 'Закрыть', class: 'btn-ghost' }] });
}

async function renderQr() {
  setAlert('');
  try {
    await reloadStructure();
  } catch (error) {
    setAlert(error.message, 'danger');
    return;
  }

  const universalUrl = studentUrl('/form.html');
  const universalInput = el('input', { class: 'input', attrs: { readonly: true, value: universalUrl } });

  mount(root, [
    pageHead('QR и ссылки', 'Универсальная ссылка и QR-код по каждой дисциплине'),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Универсальная ссылка' }),
      el('p', { class: 'sub', text: 'Студент сам выберет дисциплину, тему и тип анкеты.' }),
      el('div', { class: 'copy-row' }, [
        universalInput,
        el('button', {
          class: 'btn btn-sm',
          text: 'Скопировать',
          attrs: { type: 'button' },
          on: { click: async () => { const ok = await copyText(universalUrl); toast(ok ? 'Скопировано' : 'Не удалось', ok ? 'ok' : 'danger'); } },
        }),
        el('a', { class: 'btn btn-sm btn-ghost', attrs: { href: '/api/admin/qr.png', download: 'qr-feedback.png' }, text: 'QR (PNG)' }),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'По дисциплинам' }),
      state.disciplines.length === 0
        ? el('div', { class: 'empty', text: 'Сначала создайте дисциплину.' })
        : el('div', { class: 'doors' }, state.disciplines.map((d) =>
            doorCard({
              title: d.title,
              hint: `${d.topics_count || 0} ${plural(d.topics_count || 0, 'тема', 'темы', 'тем')}`,
              href: '#',
              onClick: () => qrModal({ discipline: d }),
            })
          )),
    ]),
  ]);
}

/* ------------------------------ Журнал действий ------------------------------ */

async function renderAudit() {
  mount(root, el('div', { class: 'card' }, [el('div', { class: 'skeleton' })]));
  setAlert('');

  let rows = [];
  try {
    const data = await api.get('/api/admin/audit?limit=200');
    rows = data.events || [];
  } catch (error) {
    setAlert(error.message, 'danger');
    return;
  }

  const list = rows.length === 0
    ? el('div', { class: 'card empty', text: 'Журнал пуст.' })
    : el('ul', { class: 'comment-list' }, rows.map((e) =>
        el('li', { class: 'comment-item' }, [
          el('div', { class: 'comment-head' }, [
            el('span', { class: 'badge', text: e.action }),
            el('span', { class: 'comment-meta', text: e.entity ? `${e.entity} #${e.entityId || ''}` : '' }),
            el('span', { class: 'comment-date', text: e.created_at || '' }),
          ]),
          el('pre', { class: 'comment-text', text: JSON.stringify(e.details || {}, null, 2) }),
        ])
      ));

  mount(root, [pageHead('Журнал действий', 'Последние 200 событий'), list]);
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
    window.location.replace('/login?next=/admin/');
    return;
  }
  const viewParam = qsParam('view');
  state.view = VIEWS[viewParam] ? viewParam : 'home';
  go(state.view);
})();
