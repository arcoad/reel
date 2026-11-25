// Reel UI — settings.js
function switchRow(key, label, desc, on) {
  return `<div class="setting-row"><div><div class="setting-label">${label}</div><div class="setting-desc">${desc}</div></div><button class="switch ${on ? "on" : ""}" data-toggle="${key}" role="switch" aria-checked="${on}"><span></span></button></div>`;
}

function updateProfileDom() {
  const avatar = state.settings.gh_avatar || "https://github.com/arcoad.png";
  const name = state.settings.gh_name || "arcoad";
  const login = state.settings.gh_login || "arcoad";
  const box = el("profile-avatar");
  if (box) {
    let img = box.querySelector("img");
    if (avatar) {
      if (!img) {
        img = document.createElement("img");
        box.prepend(img);
      }
      img.src = avatar;
      img.style.display = "block";
      img.onerror = () => {
        img.style.display = "none";
        const initial = el("gh-initial");
        if (initial) initial.style.display = "block";
      };
    }
    const initial = el("gh-initial");
    if (initial) initial.style.display = avatar ? "none" : "block";
  }
  const nameNode = el("gh-name");
  if (nameNode) nameNode.textContent = name;
  const loginNode = el("gh-login");
  if (loginNode) loginNode.textContent = `@${login}`;
}

async function loadGithubProfile() {
  updateProfileDom();
  const age = Date.now() - Number(state.settings.gh_fetched_at || 0);
  if (state.settings.gh_avatar && age < 24 * 60 * 60 * 1000) return;
  try {
    const profile = await invoke("github_profile");
    if (!profile) return;
    if (profile.avatar_url) await setSetting("gh_avatar", profile.avatar_url);
    if (profile.name || profile.login) await setSetting("gh_name", profile.name || profile.login);
    if (profile.login) await setSetting("gh_login", profile.login);
    await setSetting("gh_fetched_at", String(Date.now()));
    updateProfileDom();
  } catch {
    if (!state.settings.gh_avatar) {
      await setSetting("gh_avatar", "https://github.com/arcoad.png");
      updateProfileDom();
    }
  }
}

function renderSettings() {
  const s = state.settings;
  const hotkeys = hotkeyMap();
  const enabled = (key, fallback = true) => (s[key] === undefined ? fallback : s[key] === "1");
  const userName = [state.user?.first_name, state.user?.last_name].filter(Boolean).join(" ") || state.user?.domain || (state.user?.id ? String(state.user.id) : "Не выполнен вход");
  const avatar = s.gh_avatar || "https://github.com/arcoad.png";
  const name = s.gh_name || "arcoad";
  const login = s.gh_login || "arcoad";
  el("content").innerHTML = `<div class="settings">
    <div class="page-head"><div><h1>Настройки</h1><p>Интерфейс и поведение</p></div></div>
    <div class="profile-card">
      <div class="profile-avatar" id="profile-avatar">${avatar ? `<img id="gh-avatar" src="${esc(avatar)}" alt="" />` : ""}<span id="gh-initial">${esc((name || "A").trim()[0].toUpperCase())}</span></div>
      <div class="profile-info"><div class="profile-name" id="gh-name">${esc(name)}</div><div class="profile-login" id="gh-login">@${esc(login)}</div></div>
      <div class="profile-links"><button class="ghost" data-link="https://t.me/arcoad">Telegram</button><button class="ghost" data-link="https://github.com/arcoad">GitHub</button></div>
    </div>

    <div class="section-title">Поведение</div>
    <div class="setting-list">
      ${switchRow("shuffle", "Перемешивание", "При запуске волны", state.shuffle)}
      ${switchRow("text", "Скрывать текст", "В полном плеере по умолчанию", state.settings.now_hide_text === "1")}
      ${switchRow("autostart", "Запускать с Windows", "Автозапуск при входе", false)}
      ${switchRow("start_minimized", "Стартовать свёрнутым", "Сразу в трей", enabled("start_minimized", false))}
      ${switchRow("close_to_tray", "Закрывать в трей", "Музыка продолжает играть", enabled("close_to_tray", true))}
      ${switchRow("save_position", "Продолжать с места", "Позиция и очередь сохраняются", enabled("save_position", true))}
      ${switchRow("update_notifications", "Уведомлять об обновлениях", "Окно при новой версии", enabled("update_notifications", true))}
    </div>

    <div class="section-title">Внешний вид</div>
    <div class="setting-row"><div><div class="setting-label">Тема</div><div class="setting-desc">Оформление интерфейса</div></div>
      <select id="theme-select">${themes.map((t) => `<option value="${t}" ${t === (s.theme || "dark") ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="setting-row"><div><div class="setting-label">Акцент</div><div class="setting-desc">Кнопки и выделение</div></div>
      <input id="accent-input" type="color" value="${esc(!s.accent || s.accent === "#6f9dff" ? "#b9f34a" : s.accent)}" />
    </div>

    <div class="section-title">Горячие клавиши</div>
    <div class="setting-list">
      ${HOTKEY_ACTIONS.map(
        (a) => `<div class="setting-row"><div><div class="setting-label">${a.label}</div><div class="setting-desc">${a.desc}</div></div><button class="hotkey-btn" data-hotkey="${a.key}">${esc(hotkeyLabel(hotkeys[a.key]))}</button></div>`,
      ).join("")}
    </div>
    <div class="row" style="margin-top:8px"><button class="ghost" id="hotkeys-reset">Сбросить все</button></div>

    <div class="section-title">Локальная музыка</div>
    <div class="setting-row"><div><div class="setting-label">Папка</div><div class="setting-desc">${state.local.length} треков · MP3/FLAC/M4A/OGG/WAV</div></div>
      <div class="row"><input id="folder-input" value="${esc(s.music_folder || "")}" placeholder="D:\\Music" /><button id="scan-btn" class="ghost">Сканировать</button></div>
    </div>

    <div class="section-title">Данные</div>
    <div class="setting-row"><div><div class="setting-label">Кэш</div><div class="setting-desc" id="cache-size">…</div></div>
      <div class="row"><button id="cache-cleanup" class="ghost">Почистить</button><button id="cache-drop" class="ghost">Очистить</button></div>
    </div>
    <div class="setting-row"><div><div class="setting-label">Логи</div><div class="setting-desc">Диагностика приложения</div></div>
      <button id="open-logs" class="ghost">Открыть</button>
    </div>

    <div class="section-title">Аккаунт</div>
    <div class="setting-row"><div><div class="setting-label">${esc(userName)}</div><div class="setting-desc">Аккаунт</div></div>
      <div class="row"><button id="reauth" class="ghost">Сменить</button><button id="logout2" class="ghost">Выйти</button></div>
    </div>

    <div class="section-title">Поддержка</div>
    <div class="setting-row"><div><div class="setting-label">Поддержать Reel</div><div class="setting-desc">Telegram-канал и GitHub</div></div>
      <button id="support-open" class="ghost">Открыть</button>
    </div>

    <div class="section-title">О приложении</div>
    <div class="setting-row"><div><div class="setting-label">Reel <span id="app-version">1.1.2</span></div><div class="setting-desc">Rust + Tauri · музыкальный плеер</div></div>
      <button class="ghost" data-link="https://github.com/arcoad/reel">GitHub</button>
    </div>
  </div>`;

  el("theme-select").addEventListener("change", (e) => setSetting("theme", e.target.value));
  el("accent-input").addEventListener("input", (e) => setSetting("accent", e.target.value));
  el("content").querySelectorAll("[data-hotkey]").forEach((button) => {
    button.addEventListener("click", () => beginHotkeyCapture(button.dataset.hotkey, button));
  });
  el("hotkeys-reset").addEventListener("click", async () => {
    await setSetting("hotkeys", "{}");
    renderSettings();
    toast("Горячие клавиши сброшены");
  });
  el("content").querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.dataset.toggle;
      const next = !button.classList.contains("on");
      button.classList.toggle("on", next);
      button.setAttribute("aria-checked", String(next));
      await setSetting(key, next ? "1" : "0");
      if (key === "close_to_tray") await invoke("set_close_to_tray", { enabled: next });
      if (key === "shuffle") state.shuffle = next;
      if (key === "text") {
        state.settings.now_hide_text = next ? "1" : "0";
        await setSetting("now_hide_text", state.settings.now_hide_text);
        applyNowText();
      }
      if (key === "autostart") {
        try {
          await invoke("autostart_set", { enabled: next });
        } catch (e) {
          button.classList.toggle("on", !next);
          button.setAttribute("aria-checked", String(!next));
          await setSetting(key, next ? "0" : "1");
          toast(`Автозапуск: ${e}`);
        }
      }
    });
  });
  invoke("autostart_get")
    .then((on) => {
      const button = el("content").querySelector('[data-toggle="autostart"]');
      if (button) {
        button.classList.toggle("on", !!on);
        button.setAttribute("aria-checked", String(!!on));
      }
    })
    .catch(() => {});
  el("content").querySelectorAll("[data-link]").forEach((button) => {
    button.addEventListener("click", () => invoke("open_url", { url: button.dataset.link }).catch((e) => toast(String(e))));
  });
  el("support-open").addEventListener("click", showSupport);
  el("scan-btn").addEventListener("click", async () => {
    const dir = el("folder-input").value.trim();
    if (!dir) return;
    try {
      state.local = await invoke("scan_folder", { dir });
      await setSetting("music_folder", dir);
      renderSettings();
      toast(`Добавлено треков: ${state.local.length}`);
    } catch (e) {
      toast(`Ошибка сканирования: ${e}`);
    }
  });
  invoke("cache_list")
    .then((list) => {
      const total = list.reduce((sum, entry) => sum + (entry.size || 0), 0);
      const node = el("cache-size");
      if (node) node.textContent = `${list.length} треков · ${(total / 1048576).toFixed(1)} MB`;
    })
    .catch(() => {});
  el("cache-cleanup").addEventListener("click", async () => {
    try {
      const freed = await invoke("cache_cleanup");
      await loadCacheMeta();
      renderSettings();
      toast(`Освобождено ${(freed / 1048576).toFixed(1)} MB`);
    } catch (e) {
      toast(`Ошибка: ${e}`);
    }
  });
  el("cache-drop").addEventListener("click", async () => {
    if (!confirm("Удалить весь кэш?")) return;
    await invoke("cache_clear");
    state.cacheMeta.clear();
    await refreshCacheIndex();
    renderSettings();
    toast("Кэш очищен");
  });
  el("open-logs").addEventListener("click", () => invoke("open_logs").catch((e) => toast(String(e))));
  el("reauth").addEventListener("click", () => showLogin());
  el("logout2").addEventListener("click", doLogout);
  invoke("app_version")
    .then((version) => {
      const node = el("app-version");
      if (node) node.textContent = version;
    })
    .catch(() => {});
  loadGithubProfile();
}

async function doLogout() {
  stopLoginPoll();
  await invoke("clear_token");
  state.token = null;
  state.user = null;
  state.queue = [];
  state.index = -1;
  state.resumePosition = 0;
  state.lyricsCache.clear();
  state.section = null;
  state.playlists = [];
  state.libraryKeys = new Set();
  state.accountReady = null;
  audio.pause();
  showLogin();
}
