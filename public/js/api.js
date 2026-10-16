/**
 * Общие утилиты фронтенда.
 *
 * Безопасность: весь пользовательский контент выводится через textContent
 * (утилита el/или document.createTextNode), innerHTML нигде не используется -
 * поэтому HTML-инъекция невозможна даже без серверного экранирования.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Токен сессии. Основной механизм - httpOnly-cookie, поэтому в обычной ситуации
 * токен вообще не нужен. Он используется только как запасной вариант для панелей
 * (портал/админка), когда браузер блокирует cookie в iframe: хранится в
 * sessionStorage текущей вкладки и удаляется при выходе.
 * Студенческие страницы токен не используют и ничего не сохраняют.
 */
const TOKEN_KEY = 'bf_session_token';
let authToken = null;

export function setToken(token, { persist = false } = {}) {
  authToken = token || null;
  try {
    if (!persist) return;
    if (authToken) sessionStorage.setItem(TOKEN_KEY, authToken);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим - работаем только с cookie */
  }
}

export function loadToken() {
  try {
    authToken = sessionStorage.getItem(TOKEN_KEY) || null;
  } catch {
    authToken = null;
  }
  return authToken;
}

export function clearToken() {
  authToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
  }
}

async function request(method, url, body, options = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...(options.headers || {}) },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, ...JSON_HEADERS };
    init.body = JSON.stringify(body);
  }
  if (authToken) init.headers.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new ApiError('Нет связи с сервером. Проверьте подключение к сети.', 0, {});
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else if (options.raw) {
    payload = await response.text();
  }

  if (response.status === 401) clearToken();

  if (!response.ok) {
    const message =
      (payload && payload.error) ||
      (response.status === 429
        ? 'Слишком много запросов, попробуйте позже'
        : `Ошибка запроса (${response.status})`);
    throw new ApiError(message, response.status, payload || {});
  }

  return payload;
}

export const api = {
  get: (url, options) => request('GET', url, undefined, options),
  post: (url, body, options) => request('POST', url, body, options),
  patch: (url, body, options) => request('PATCH', url, body, options),
  del: (url, options) => request('DELETE', url, undefined, options),
};

/* --------------------- Адрес студенческого сайта --------------------- */

/**
 * Сайт студентов работает на своём порту (PORT), а панели преподавателя и
 * администратора - на STAFF_PORT. Ссылки и QR-коды для студентов всегда
 * строятся от студенческого адреса: его сообщает сервер в /api/meta.
 */
let studentBase = '';

export async function loadStudentBase() {
  try {
    const meta = await api.get('/api/meta');
    studentBase = String(meta.student_base_url || '').replace(/\/+$/, '');
  } catch {
    studentBase = '';
  }
  return studentBase;
}

export function getStudentBase() {
  return studentBase || window.location.origin;
}

export function studentUrl(path = '/', params = null) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${getStudentBase()}${path}${query ? `?${query}` : ''}`;
}

/* ------------------------------ DOM-хелперы ------------------------------ */

/**
 * Создание элемента. Текст всегда добавляется как текстовый узел.
 *
 * @param {string} tag
 * @param {object} props - class, text, html? (нет), attrs, dataset, on, style (объект CSS-свойств)
 * @param {Array|Node|string} children
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { class: className, text, attrs, dataset, on, style, ...rest } = props || {};

  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      if (value !== null && value !== undefined) node.dataset[key] = String(value);
    }
  }
  if (on) {
    for (const [event, handler] of Object.entries(on)) {
      node.addEventListener(event, handler);
    }
  }
  if (style) {
    for (const [prop, value] of Object.entries(style)) {
      node.style.setProperty(prop, value);
    }
  }
  for (const key of Object.keys(rest)) {
    if (key in node) node[key] = rest[key];
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Очистка контейнера без innerHTML. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, content) {
  clear(node);
  append(node, content);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ------------------------------ Форматирование ------------------------------ */

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
const shortDateFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function fmtDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateFormatter.format(date);
}

export function fmtShortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return shortDateFormatter.format(date);
}

export function fmtDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateTimeFormatter.format(date);
}

export const fmtNum = (value, digits = 2) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? '-'
    : Number(value).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const plural = (n, one, few, many) => {
  const value = Math.abs(Number(n));
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

export const scoreClass = (value) => {
  if (value === null || value === undefined) return 'muted';
  const rounded = Math.round(Number(value));
  return `score score-${Math.min(5, Math.max(1, rounded))}`;
};

/* ------------------------------ UI-мелочи ------------------------------ */

export function toast(message, kind = 'info', timeout = 4200) {
  let area = document.querySelector('.toast-area');
  if (!area) {
    area = el('div', { class: 'toast-area', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
    document.body.append(area);
  }
  const kindClass = kind === 'ok' ? 'toast-ok' : kind === 'danger' ? 'toast-danger' : '';
  const node = el('div', { class: `toast ${kindClass}`.trim(), text: message, attrs: { role: 'status' } });
  area.append(node);
  const remove = () => {
    node.style.setProperty('opacity', '0');
    setTimeout(() => node.remove(), 200);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
  return node;
}

export function setLoading(button, isLoading, loadingText = 'Отправляем…') {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
    button.classList.add('is-loading');
  } else {
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

export function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function qsParam(name, search = window.location.search) {
  return new URLSearchParams(search).get(name);
}

export function setParams(params, { replace = true } = {}) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState({}, '', next);
  else window.history.pushState({}, '', next);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback для браузеров без Clipboard API
    const area = el('textarea', { class: 'visually-hidden', text });
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Простая модалка на нативном <dialog>-подобном поведении (без внешних зависимостей). */
export function modal({ title, content, actions = [], wide = false }) {
  const backdrop = el('div', { class: 'modal-backdrop', attrs: { role: 'dialog', 'aria-modal': 'true' } });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const box = el('div', { class: `modal${wide ? ' modal-wide' : ''}` }, [
    title ? el('h2', { text: title }) : null,
    content,
    actions.length > 0
      ? el(
          'div',
          { class: 'modal-actions' },
          actions.map((action) =>
            el('button', {
              class: `btn ${action.class || 'btn-ghost'}`,
              text: action.label,
              attrs: { type: 'button' },
              on: {
                click: () => {
                  if (action.onClick) action.onClick({ close });
                  if (action.closeAfter !== false) close();
                },
              },
            })
          )
        )
      : null,
  ]);

  backdrop.append(box);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { close, element: box };
}

export function confirmDialog({ title, message, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    modal({
      title,
      content: el('p', { class: 'soft', text: message }),
      actions: [
        {
          label: 'Отмена',
          class: 'btn-ghost',
          onClick: () => resolve(false),
        },
        {
          label: confirmLabel,
          class: danger ? 'btn-danger' : 'btn-primary',
          onClick: () => resolve(true),
        },
      ],
    });
  });
}

export const COLORS = {
  brand: '#4550a8',
  brandDark: '#38418a',
  accent: '#d97706',
  muted: '#9b988f',
  ok: '#4a7c59',
  warn: '#a8702a',
  danger: '#a8484a',
};
