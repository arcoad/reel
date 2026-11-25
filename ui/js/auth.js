// Reel UI — auth.js
function showLogin(error = "") {
  stopLoginPoll();
  el("login").classList.remove("hidden");
  el("shell").classList.add("hidden");
  el("login-error").textContent = error;
}

function stopLoginPoll() {
  if (state.loginPoll) {
    clearInterval(state.loginPoll);
    state.loginPoll = null;
  }
  state.loginBusy = false;
}

async function finishLogin(info) {
  stopLoginPoll();
  state.token = info;
  state.user = info && info.user_id ? { id: info.user_id } : null;
  el("login-error").textContent = "";
  await refreshCacheIndex();
  await afterLogin();
}

async function loginWithCookies() {
  let p = el("cookie-p").value.trim();
  let remixsid = el("cookie-sid").value.trim();
  const joined = `${p};${remixsid}`;
  if (!remixsid) {
    const m = joined.match(/remixsid=([^;\s]+)/);
    if (m) remixsid = m[1];
  }
  if (p.includes("=")) {
    const m = p.match(/(?:^|;\s*)p=([^;]*)/);
    if (m) p = m[1];
  }
  p = p.replace(/^p=/, "").trim();
  remixsid = remixsid.replace(/^remixsid=/, "").trim();
  if (!p || !remixsid) {
    el("login-error").textContent = "Нужны оба cookie: p и remixsid. Можно вставить всю строку Cookie в первое поле.";
    return;
  }
  el("login-error").textContent = "Получаю токен по cookies…";
  try {
    const info = await invoke("web_token_from_cookies", { p, remixsid });
    await finishLogin(info);
  } catch (e) {
    el("login-error").textContent = String(e);
  }
}

async function startLoginPoll() {
  stopLoginPoll();
  el("login-error").textContent = "Ожидаю вход… Если QR обновляется — войди по номеру/паролю.";
  try {
    await invoke("vk_login_window");
  } catch (e) {
    el("login-error").textContent = `Не удалось открыть окно входа: ${e}`;
    return;
  }
  const startedAt = Date.now();
  state.loginPoll = setInterval(async () => {
    if (state.loginBusy) return;
    if (Date.now() - startedAt > 300000) {
      stopLoginPoll();
      el("login-error").textContent = "Время ожидания истекло. Попробуй снова.";
      return;
    }
    state.loginBusy = true;
    try {
      const info = await invoke("vk_capture_cookies");
      if (!state.loginPoll) return;
      if (info && info.access_token) {
        await finishLogin(info);
        return;
      }
    } catch (e) {
      const msg = String(e);
      if (/web_token|unauthorized|flood|too many|\[9\]/i.test(msg)) {
        stopLoginPoll();
        el("login-error").textContent = "Сервис ограничил попытки входа (error 9 / Flood control). Подожди 15–30 минут и зайди снова — лучше через cookie p+remixsid.";
      } else {
        el("login-error").textContent = `Ожидаю вход… (${msg})`;
      }
    } finally {
      state.loginBusy = false;
    }
  }, 8000);
}

function renderUserName() {
  const u = state.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.domain || (u.id ? String(u.id) : "");
  const nameNode = el("user-name");
  if (nameNode) nameNode.textContent = name || "Не выполнен вход";
  const initials = [u.first_name, u.last_name]
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  const avatarNode = el("user-avatar");
  if (avatarNode) avatarNode.textContent = initials || (u.domain ? u.domain.slice(0, 2).toUpperCase() : "?");
  const top = el("top-avatar");
  if (top) top.textContent = initials || "R";
  const accountName = el("account-name");
  if (accountName) accountName.textContent = name || "Reel";
  const accountLogin = el("account-login");
  if (accountLogin) accountLogin.textContent = u.domain ? `@${u.domain}` : "аккаунт";
}

function cachedProfile() {
  try {
    const raw = state.settings && state.settings.profile_cache;
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && (u.first_name || u.last_name || u.photo_200) ? u : null;
  } catch {
    return null;
  }
}

async function loadAccount() {
  // Имя и аватар уже показываем из кэша, чтобы вместо имени не мелькал id.
  const cached = cachedProfile();
  if (cached) {
    state.user = { ...(state.user || {}), ...cached };
    renderUserName();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const users = await invoke("account_info");
      const u = Array.isArray(users) ? users[0] : null;
      if (u && u.id) {
        state.user = { ...(state.user || {}), ...u };
        renderUserName();
        setSetting("profile_cache", JSON.stringify(u)).catch(() => {});
        return;
      }
    } catch (e) {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  renderUserName();
}

function supportKey() {
  const id = state.user && state.user.id ? state.user.id : "local";
  return `support_seen_${id}`;
}

function showSupport() {
  el("support").classList.remove("hidden");
  el("support-continue").focus({ preventScroll: true });
}

async function dismissSupport() {
  el("support").classList.add("hidden");
  try {
    await setSetting(supportKey(), "1");
  } catch (e) {
    console.warn("support setting failed", e);
  }
}

function maybeShowSupport() {
  if (state.settings[supportKey()] === "1") return;
  showSupport();
}

async function afterLogin() {
  el("login").classList.add("hidden");
  el("shell").classList.remove("hidden");
  const tokenUserId = state.token ? state.token.user_id : null;
  if (tokenUserId && (!state.user || !state.user.id)) state.user = { ...(state.user || {}), id: tokenUserId };
  renderUserName();
  restorePlayback().catch((e) => console.warn("playback restore failed", e));
  state.accountReady = loadAccount();
  await openView("home");
  maybeShowSupport();
}

function showUpdatePrompt() {
  const u = state.update;
  if (!u || !u.available) return;
  el("update-title").textContent = `Обновление ${u.version}`;
  const when = u.date ? ` · ${new Date(u.date).toLocaleString("ru-RU")}` : "";
  el("update-sub").textContent = `Сейчас ${u.current}${when}`;
  el("update-notes").textContent = u.notes || "Список изменений не указан.";
  const modal = el("update-modal");
  if (!modal.open) modal.showModal();
}

let lastUpdateCheck = 0;

async function checkUpdates(manual = false) {
  if (state.settings.update_notifications === "0") return;
  const st = el("update-status");
  lastUpdateCheck = Date.now();
  if (st) st.textContent = "Проверяю…";
  try {
    const r = await invoke("update_check");
    state.update = r;
    const ver = el("app-version");
    if (ver) ver.textContent = r.current;
    const btn = el("update-install");
    if (btn) btn.classList.toggle("hidden", !r.available);
    if (st) st.textContent = r.available ? `Доступно ${r.version} (сейчас ${r.current})` : `Обновлений нет (${r.current})`;
    if (r.available && (manual || state.settings.skipped_update !== r.version)) showUpdatePrompt();
  } catch (e) {
    if (st) st.textContent = `Ошибка проверки: ${e}`;
    if (manual) alert(`Не удалось проверить обновления: ${e}`);
  }
}

async function installUpdate() {
  const st = el("update-status");
  const notes = el("update-notes");
  if (st) st.textContent = "Загрузка обновления…";
  if (notes) notes.textContent = "Загрузка и установка… Приложение перезапустится.";
  const btn = el("update-now");
  if (btn) btn.disabled = true;
  try {
    await invoke("update_install");
    if (st) st.textContent = "Установщик запущен";
  } catch (e) {
    if (st) st.textContent = `Ошибка установки: ${e}`;
    if (notes) notes.textContent = `Ошибка установки: ${e}`;
    if (btn) btn.disabled = false;
    alert(`Ошибка обновления: ${e}`);
  }
}
