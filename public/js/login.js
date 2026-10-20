/** Вход в систему, смена временного пароля, безопасный редирект по роли.
 *
 * После нескольких неверных попыток вход приостанавливается на фиксированное время.
 * Экран показывает обратный отсчёт, чтобы не дёргать форму вслепую.
 */

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

const loginButton = () => document.querySelector('#login-submit');
let cooldownTimer = null;

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  const button = loginButton();
  if (!button) return;
  button.disabled = false;
  if (button.dataset.originalText) button.textContent = button.dataset.originalText;
}

/** Обратный отсчёт: секунды берутся у сервера, поэтому они всегда одинаковые. */
function startCooldown(seconds) {
  stopCooldown();
  let left = Math.max(1, Math.ceil(seconds));
  const button = loginButton();
  if (!button) return;
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.disabled = true;
  const render = () => {
    button.textContent = `Подождите ${left} с`;
    setAlert(`Слишком много неверных попыток. Войти можно будет через ${left} с.`, 'warn');
  };
  render();
  cooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      stopCooldown();
      clear(alertsNode);
      return;
    }
    render();
  }, 1000);
}

function redirectFor(user) {
  const fallback = user.role === 'admin' ? '/admin/' : '/portal/';
  const target = safeNext(fallback);
  // Параметр next может вести в панель, которая пользователю недоступна.
  // Отправлять туда нельзя: получится цикл /admin/ -> /login?next=/admin/ -> /admin/.
  if (target.startsWith('/admin') && user.role !== 'admin') {
    window.location.replace(fallback);
    return;
  }
  window.location.replace(target);
}

async function afterLogin(user, token) {
  // Ключ сессии нужен только панелям
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
  let pausedFor = 0;
  try {
    const data = await api.post('/api/auth/login', { login, password });
    await afterLogin(data.user, data.token);
  } catch (error) {
    if (error.status === 401) clearToken();
    if (error.status === 429 && error.payload && error.payload.code === 'LOGIN_COOLDOWN') {
      pausedFor = Number(error.payload.retryAfterSeconds) || 10;
      document.querySelector('#password').value = '';
    } else {
      setAlert(error.message, 'danger');
    }
  } finally {
    setLoading(button, false);
    if (pausedFor) startCooldown(pausedFor);
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
