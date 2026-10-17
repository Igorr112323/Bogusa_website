/** Вход в систему, смена временного пароля, безопасный редирект по роли. */

import { api, el, mount, clear, toast, setLoading, qsParam, setToken, clearToken } from './api.js';

const alertsNode = document.querySelector('#alerts');
const loginForm = document.querySelector('#login-form');
const passwordForm = document.querySelector('#password-form');
const loginTitle = document.querySelector('#login-title');

const setAlert = (message, kind = 'info') => {
  if (!message) {
    clear(alertsNode);
    return;
  }
  mount(alertsNode, el('div', { class: `alert alert-${kind}`, attrs: { role: 'alert' }, text: message }));
};

/** Разрешаем переходы только на внутренние адреса - защита от open redirect. */
function safeNext(fallback) {
  const next = qsParam('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return fallback;
}

function redirectFor(user) {
  const fallback = user.role === 'admin' ? '/admin/' : '/portal/';
  window.location.replace(safeNext(fallback));
}

async function afterLogin(user, token) {
  // Токен нужен только панелям (cookie как основной механизм уже выставлен сервером)
  setToken(token, { persist: true });
  if (user.must_change_password) {
    loginTitle.textContent = 'Смена временного пароля';
    loginForm.classList.add('hidden');
    passwordForm.classList.remove('hidden');
    setAlert('Придумайте новый пароль: минимум 10 символов, хотя бы два вида символов.', 'warn');
    document.querySelector('#new-password').focus();
    return;
  }
  toast('Вход выполнен', 'ok');
  redirectFor(user);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const login = document.querySelector('#login').value.trim();
  const password = document.querySelector('#password').value;
  const button = document.querySelector('#login-submit');

  if (!login || !password) {
    setAlert('Заполните логин и пароль', 'warn');
    return;
  }

  setLoading(button, true, 'Проверяем…');
  try {
    const data = await api.post('/api/auth/login', { login, password });
    await afterLogin(data.user, data.token);
  } catch (error) {
    if (error.status === 401) clearToken();
    setAlert(error.message, 'danger');
    if (error.status === 429) toast('Слишком много попыток входа. Подождите.', 'danger');
  } finally {
    setLoading(button, false);
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = document.querySelector('#new-password').value;
  const repeat = document.querySelector('#new-password-2').value;
  const button = document.querySelector('#password-submit');
  const currentPassword = document.querySelector('#password').value;

  if (next.length < 10) {
    setAlert('Пароль должен содержать не менее 10 символов', 'warn');
    return;
  }
  if (next !== repeat) {
    setAlert('Пароли не совпадают', 'warn');
    return;
  }

  setLoading(button, true, 'Сохраняем…');
  try {
    const data = await api.post('/api/auth/password', {
      current_password: currentPassword,
      new_password: next,
    });
    setToken(data.token, { persist: true });
    toast('Пароль обновлён', 'ok');
    redirectFor(data.user);
  } catch (error) {
    setAlert(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
});

/** Если пользователь уже вошёл - сразу отправляем в его панель. */
(async () => {
  try {
    const { user } = await api.get('/api/auth/me');
    if (user) redirectFor(user);
  } catch {
    /* не авторизован - показываем форму */
  }
})();
