/**
 * Общий модуль управления дисциплинами и темами.
 *
 * Используется и в админ-панели, и в кабинете преподавателя: один и тот же
 * набор модалок + список, чтобы не разъезжался UX.
 *
 * Зависит от:
 *   api.js     — HTTP-обёртка, modal, el, mount, toast, scoreClass, fmtNum
 *   api.js     — confirmDialog для опасных действий
 */

import { api, el, mount, toast, scoreClass, fmtNum, modal, confirmDialog, plural } from './api.js';

/**
 * Список дисциплин с кнопками «Темы», «Изменить», «Включить/Выключить», «Удалить».
 *
 * @param {Object}   options
 * @param {Array}    options.disciplines      — массив с полями id, title, code, teacher_name, topics_count, responses, avg, is_active
 * @param {Function} options.reload           — async () => void, перезагрузить список и state
 * @param {Object}   options.teacherById      — Map<id, {full_name, login}>
 * @param {Object}   options.actions          — { onNew, canEditTeacher }
 * @param {Function} [options.onNew]          — () => void, открыть модалку «Новая дисциплина»
 * @param {boolean}  [options.canEditTeacher] — если true, в модалке показывается поле «Преподаватель»
 */
export function renderDisciplineTable({ disciplines, reload, teacherById, actions = {} }) {
  const rows = disciplines.map((discipline) => {
    const teacher = teacherById.get(discipline.teacher_id);
    const teacherName = discipline.teacher_name || (teacher ? teacher.full_name : null);

    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [el('strong', { text: discipline.title })]),
        el('div', { class: 'tiny muted' }, [
          discipline.code || 'без кода',
          ' · ',
          `${discipline.topics_count} ${plural(discipline.topics_count, 'тема', 'темы', 'тем')}`,
        ]),
      ]),
      el('td', { text: teacherName || 'не назначен' }),
      el('td', {}, [
        discipline.is_active
          ? el('span', { class: 'badge badge-ok', text: 'открыта' })
          : el('span', { class: 'badge badge-warn', text: 'выключена' }),
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
            on: { click: () => topicsModal({ discipline, reload }) },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Изменить',
            attrs: { type: 'button' },
            on: { click: () => disciplineFormModal({ discipline, teacherById, canEditTeacher: !!actions.canEditTeacher, onSaved: reload }) },
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: discipline.is_active ? 'Выключить' : 'Включить',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                try {
                  await api.patch(`/api/${actions.scope || 'admin'}/disciplines/${discipline.id}`, { is_active: !discipline.is_active });
                  toast('Статус обновлён', 'ok');
                  await reload();
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
                  title: `Удалить «${discipline.title}»?`,
                  message:
                    discipline.responses > 0
                      ? `Вместе с дисциплиной будут удалены ${discipline.responses} анкет. Если отзывы нужны — выключите дисциплину вместо удаления.`
                      : 'Действие необратимо.',
                  confirmLabel: 'Удалить',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api.del(`/api/${actions.scope || 'admin'}/disciplines/${discipline.id}?force=1`);
                  toast('Дисциплина удалена', 'ok');
                  await reload();
                } catch (error) {
                  toast(error.message, 'danger');
                }
              },
            },
          }),
        ]),
      ]),
    ]);
  });

  return el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Дисциплина' }),
        el('th', { text: 'Преподаватель' }),
        el('th', { text: 'Статус' }),
        el('th', { class: 'num', text: 'Анкет' }),
        el('th', { class: 'num', text: 'Средний балл' }),
        el('th', { class: 'num', text: '' }),
      ]),
    ]),
    el('tbody', {}, rows),
  ]);
}

/**
 * Модалка «Новая дисциплина» / «Изменить дисциплину».
 *
 * @param {Object} options
 * @param {Object|null} options.discipline   — null для создания
 * @param {Map}    options.teacherById       — список преподавателей (id → {full_name, login})
 * @param {boolean} [options.canEditTeacher] — показывать ли поле «Преподаватель»
 * @param {string} [options.scope]           — 'admin' (по умолчанию) или 'teacher'
 * @param {Function} [options.onSaved]       — async () => void
 */
export function disciplineFormModal({ discipline = null, teacherById, canEditTeacher = true, scope = 'admin', onSaved }) {
  const titleInput = el('input', { class: 'input', attrs: { value: discipline ? discipline.title : '', placeholder: 'Дискретная математика' } });
  const codeInput = el('input', { class: 'input', attrs: { value: discipline?.code || '', placeholder: 'DM-201' } });

  const teacherSelect = el(
    'select',
    { class: 'select' },
    [
      el('option', { text: '— не назначен —', attrs: { value: '' } }),
      ...Array.from(teacherById.values())
        .filter((t) => t.role === 'teacher')
        .map((t) => el('option', { text: `${t.full_name} (${t.login})`, attrs: { value: String(t.id) } })),
    ]
  );
  if (discipline?.teacher_id) teacherSelect.value = String(discipline.teacher_id);

  const activeSelect = el('select', { class: 'select' }, [
    el('option', { text: 'Открыта для анкетирования', attrs: { value: '1' } }),
    el('option', { text: 'Выключена (студенты не видят)', attrs: { value: '0' } }),
  ]);
  activeSelect.value = discipline && !discipline.is_active ? '0' : '1';

  const statusNode = el('div');
  const fields = [];

  fields.push(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Название' }), titleInput]));
  fields.push(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Код дисциплины (необязательно)' }), codeInput]));
  if (canEditTeacher) {
    fields.push(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Преподаватель' }), teacherSelect]));
  }
  fields.push(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Статус' }), activeSelect]));
  fields.push(statusNode);

  const content = el('div', {}, fields);

  let instance;
  const save = async () => {
    if (!titleInput.value.trim()) {
      mount(statusNode, el('div', { class: 'alert alert-warn', text: 'Введите название дисциплины' }));
      return;
    }
    const payload = {
      title: titleInput.value.trim(),
      code: codeInput.value.trim() || null,
      is_active: activeSelect.value === '1',
    };
    if (canEditTeacher) {
      payload.teacher_id = teacherSelect.value ? Number(teacherSelect.value) : null;
    }
    try {
      if (discipline) await api.patch(`/api/${scope}/disciplines/${discipline.id}`, payload);
      else await api.post(`/api/${scope}/disciplines`, payload);
      instance.close();
      toast(discipline ? 'Дисциплина обновлена' : 'Дисциплина создана', 'ok');
      await onSaved?.();
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

/**
 * Модалка «Темы дисциплины»: список + добавление одной / пачкой.
 *
 * @param {Object} options
 * @param {Object} options.discipline — {id, title}
 * @param {string} [options.scope]    — 'admin' (по умолчанию) или 'teacher'
 * @param {Function} [options.onSaved] — async () => void
 */
export async function topicsModal({ discipline, scope = 'admin', onSaved }) {
  const listNode = el('div', {}, [el('div', { class: 'skeleton' })]);
  const bulkArea = el('textarea', {
    class: 'textarea',
    attrs: {
      placeholder: 'По одной теме в строке. Можно указать дату через «|»: Введение | 2026-09-05',
      rows: '4',
    },
  });
  const newTitle = el('input', { class: 'input', attrs: { placeholder: 'Название темы' } });
  const newDate = el('input', { class: 'input', attrs: { type: 'date' } });
  const statusNode = el('div');

  let instance;

  const load = async () => {
    try {
      const data = await api.get(`/api/${scope}/disciplines/${discipline.id}/topics`);
      const topics = data.topics || [];
      if (topics.length === 0) {
        mount(listNode, el('div', { class: 'empty', text: 'Тем пока нет — добавьте хотя бы одну, иначе студенты не увидят дисциплину.' }));
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
                    modal({
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
                              await api.patch(`/api/${scope}/topics/${topic.id}`, {
                                title: title.value.trim(),
                                lesson_date: date.value || null,
                              });
                              toast('Тема обновлена', 'ok');
                              await load();
                              await onSaved?.();
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
                      await api.patch(`/api/${scope}/topics/${topic.id}`, { is_active: !topic.is_active });
                      await load();
                      await onSaved?.();
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
                      await api.del(`/api/${scope}/topics/${topic.id}?force=1`);
                      await load();
                      await onSaved?.();
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
              await api.post(`/api/${scope}/topics`, {
                discipline_id: discipline.id,
                title: newTitle.value.trim(),
                lesson_date: newDate.value || null,
              });
              newTitle.value = '';
              newDate.value = '';
              toast('Тема добавлена', 'ok');
              await load();
              await onSaved?.();
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
      ]),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Загрузить список',
        attrs: { type: 'button' },
        on: {
          click: async () => {
            const lines = bulkArea.value.split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines.length === 0) return toast('Введите хотя бы одну тему', 'danger');
            const topics = lines.map((line) => {
              const [title, date] = line.split('|').map((part) => part.trim());
              return { title, lesson_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
            });
            try {
              const result = await api.post(`/api/${scope}/disciplines/${discipline.id}/topics/bulk`, { topics });
              toast(`Добавлено тем: ${result.created}`, 'ok');
              bulkArea.value = '';
              await load();
              await onSaved?.();
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
