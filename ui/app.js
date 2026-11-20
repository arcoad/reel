const { invoke } = window.__TAURI__.core;

const audio = document.getElementById("audio");
const el = (id) => document.getElementById(id);

const state = {
  token: null,
  user: null,
  view: "library",
  tracks: [],
  local: [],
  queue: [],
  index: -1,
  repeat: "off",
  shuffle: false,
  cache: new Map(),
  settings: {},
  hls: null,
  loading: false,
  section: null,
  playlists: [],
  libraryKeys: new Set(),
  loginPoll: null,
  loginBusy: false,
  update: null,
};

const CACHE_META = "vkx_cache_meta";
const themes = ["dark", "light", "amoled", "nord", "gruvbox"];

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function coverOf(t) {
  const album = t.album || {};
  const albumThumb = album.thumb || {};
  const thumb = t.thumb || {};
  return albumThumb.photo_600 || albumThumb.photo_300 || thumb.photo_600 || thumb.photo_300 || album.photo_600 || "";
}

function normTrack(t) {
  let hls = "";
  const streams = t.audio_streams || [];
  for (const s of streams) {
    if ((s.type || "").includes("hls") && s.url) hls = s.url;
  }
  const url = t.url || "";
  if (!hls && url.includes(".m3u8")) hls = url;
  return {
    id: Number(t.id),
    owner_id: Number(t.owner_id),
    title: t.title || "Без названия",
    artist: t.artist || "",
    duration: Number(t.duration || 0),
    url,
    hls,
    lyrics_id: t.lyrics_id || null,
    access_key: t.access_key || "",
    explicit: !!t.is_explicit,
    cover: coverOf(t),
  };
}

function trackKey(t) {
  return `${t.id}_${t.owner_id}`;
}

function mediaUrl(key) {
  return `http://vkxcache.localhost/${key}`;
}

function cacheMeta() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_META) || "{}");
  } catch {
    return {};
  }
}

function saveCacheMeta(meta) {
  localStorage.setItem(CACHE_META, JSON.stringify(meta));
}

async function api(method, params = {}) {
  return invoke("vk_method", { method, params });
}

async function loadSettings() {
  const rows = await invoke("settings_all");
  const s = {};
  for (const [k, v] of rows) s[k] = v;
  state.settings = s;
  applyTheme();
}

function applyTheme() {
  const theme = state.settings.theme || "dark";
  document.documentElement.dataset.theme = themes.includes(theme) ? theme : "dark";
  const accent = state.settings.accent;
  if (accent) document.documentElement.style.setProperty("--accent", accent);
  else document.documentElement.style.removeProperty("--accent");
}

async function setSetting(key, value) {
  state.settings[key] = value;
  await invoke("settings_set", { key, value: String(value) });
  applyTheme();
}

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
  el("login-error").textContent = "Ожидаю вход в VK… Если QR обновляется — войди по номеру/паролю.";
  try {
    await invoke("vk_login_window");
  } catch (e) {
    el("login-error").textContent = `Не удалось открыть окно VK: ${e}`;
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
        el("login-error").textContent = "VK ограничил попытки входа (error 9 / Flood control). Подожди 15–30 минут и зайди снова — лучше через cookie p+remixsid, это один запрос.";
      } else {
        el("login-error").textContent = `Ожидаю вход в VK… (${msg})`;
      }
    } finally {
      state.loginBusy = false;
    }
  }, 8000);
}

function renderUserName() {
  const u = state.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.domain || (u.id ? String(u.id) : "");
  el("user-name").textContent = name || "Не выполнен вход";
  const initials = [u.first_name, u.last_name]
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  el("user-avatar").textContent = initials || (u.domain ? u.domain.slice(0, 2).toUpperCase() : "VK");
}

async function loadAccount() {
  try {
    const users = await invoke("account_info");
    const u = Array.isArray(users) ? users[0] : null;
    if (u && u.id) {
      state.user = { ...(state.user || {}), ...u };
      renderUserName();
    }
  } catch (e) {
    renderUserName();
  }
}

async function afterLogin() {
  el("login").classList.add("hidden");
  el("shell").classList.remove("hidden");
  const tokenUserId = state.token ? state.token.user_id : null;
  if (tokenUserId && (!state.user || !state.user.id)) state.user = { ...(state.user || {}), id: tokenUserId };
  renderUserName();
  restoreQueue().catch((e) => console.warn("queue restore failed", e));
  await openView("library");
  loadAccount();
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

async function boot() {
  await loadSettings();
  state.token = await invoke("get_token");
  if (state.token) await afterLogin();
  else showLogin();
  await refreshCacheIndex();
  checkUpdates().catch(() => {});
  window.addEventListener("focus", () => {
    if (document.hidden) return;
    if (Date.now() - lastUpdateCheck < 10 * 60 * 1000) return;
    const modal = el("update-modal");
    if (modal && modal.open) return;
    checkUpdates(false);
  });
}

async function refreshCacheIndex() {
  try {
    const list = await invoke("cache_list");
    state.cache = new Map(list.map((e) => [e.key, e]));
  } catch {
    state.cache = new Map();
  }
}

function setViewChrome(view) {
  state.view = view;
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  el("search-box").classList.toggle("hidden", view !== "search");
  el("refresh").classList.toggle("hidden", view === "settings" || view === "search");
  const titles = { library: "Библиотека", search: "Поиск", playlists: "Плейлисты", cache: "Кэш", settings: "Настройки" };
  el("view-title").textContent = titles[view] || view;
}

async function openView(view) {
  setViewChrome(view);
  const content = el("content");
  content.classList.remove("view-in");
  void content.offsetWidth;
  content.classList.add("view-in");
  if (view === "library") return loadLibrary();
  if (view === "search") return renderSearchStub();
  if (view === "playlists") return loadPlaylists();
  if (view === "cache") return renderCache();
  if (view === "settings") return renderSettings();
}

function coverBox(src, name, cls) {
  const letter = esc(((name || "?").trim()[0] || "?").toUpperCase());
  const img = src ? `<img class="cover-img" src="${esc(src)}" alt="" data-name="${esc(name)}" />` : "";
  return `<div class="${cls} ${src ? "" : "cover-missing"}" data-letter="${letter}" data-name="${esc(name)}">${img}</div>`;
}

function trackRow(t, i, list) {
  const isActive = state.queue[state.index] && trackKey(state.queue[state.index]) === trackKey(t);
  const cached = state.cache.has(trackKey(t));
  const inLib = state.libraryKeys.has(trackKey(t));
  return `<div class="track has-cover ${isActive ? "active" : ""}" data-idx="${i}">
    <div class="idx">${i + 1}</div>
    ${coverBox(t.cover, t.title, "tcover")}
    <div>
      <div class="title">${esc(t.title)}${t.explicit ? ' <span class="pill">E</span>' : ""}</div>
      <div class="sub">${esc(t.artist)}${cached ? ' • <span style="color:var(--accent-2)">кэш</span>' : ""}</div>
    </div>
    <div class="time">${fmtTime(t.duration)}</div>
    <div class="actions">
      <button class="ghost" data-act="copy">Ссылка</button>
      <button class="ghost" data-act="cache">Кэш</button>
      <button class="ghost" data-act="like">${inLib ? "Убрать" : "В библиотеку"}</button>
    </div>
  </div>`;
}

function bindTracks(container, list) {
  container.querySelectorAll(".track[data-idx]").forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.addEventListener("dblclick", () => playList(list, idx));
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      playList(list, idx);
    });
    row.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const t = list[idx];
        if (btn.dataset.act === "copy") await copyTrack(t);
        if (btn.dataset.act === "cache") await cacheTrack(t);
        if (btn.dataset.act === "like") await likeTrack(t);
      });
    });
  });
}

function localToTrack(l) {
  return { id: -l.id, owner_id: 0, title: l.title, artist: l.artist, duration: l.duration, url: "", hls: "", local_id: l.id, cover: "" };
}

function localRow(l, i) {
  const active = state.queue[state.index] && state.queue[state.index].local_id === l.id;
  return `<div class="track ${active ? "active" : ""}" data-li="${i}">
    <div class="idx">${String(i + 1).padStart(2, "0")}</div>
    <div><div class="title">${esc(l.title)}</div><div class="sub">${esc(l.artist)}</div></div>
    <div class="time">${l.duration ? fmtTime(l.duration) : ""}</div>
    <div class="actions"><button class="ghost" data-lrm="${i}">Убрать</button></div>
  </div>`;
}

function vkHint(err) {
  const s = String(err);
  let code = null;
  let msg = "";
  try {
    const j = JSON.parse(s);
    code = j.error_code ?? null;
    msg = j.error_msg || "";
  } catch {
    msg = s;
  }
  if (code === 9 || /Flood control/i.test(msg)) return "VK временно ограничил запросы. Подожди 15–30 минут.";
  if (code === 5) return "Токен недействителен или отозван. Войди заново через окно VK.";
  if (code === 3 || /Unknown method/i.test(msg)) return "Этот токен не подходит для VK Audio. Войди через окно VK.";
  return msg || "Не удалось получить данные VK.";
}

async function loadLocalTracks() {
  try {
    state.local = await invoke("local_tracks");
  } catch {
    state.local = [];
  }
}

function ownPlaylists(list, userId) {
  const id = Number(userId);
  return (list || []).filter((p) => {
    const owner = Number(p.owner_id);
    const pid = Number(p.id);
    return Number.isFinite(id) && owner === id && pid > 0 && p.type !== "generated" && !p.followed;
  });
}

function librarySection(sections) {
  return (
    (sections || []).find((s) => /section=all/.test(String(s.url || ""))) ||
    (sections || []).find((s) => /моя музыка|my music/i.test(String(s.title || ""))) ||
    null
  );
}

async function loadMyMusic(sectionId) {
  const seen = new Set();
  const tracks = [];
  let start = null;
  for (let page = 0; page < 50; page++) {
    const res = await invoke("catalog_get_section", { sectionId, startFrom: start });
    const section = res.section || {};
    const block = (section.blocks || []).find((b) => (b.audios_ids || []).length);
    const pageTracks = orderedByBlocks((res.audios || []).map(normTrack), section.blocks || []);
    for (const t of pageTracks) {
      const key = trackKey(t);
      if (!seen.has(key)) {
        seen.add(key);
        tracks.push(t);
      }
    }
    const next = section.next_from || (block && block.next_from) || null;
    if (!next || next === start || !pageTracks.length) break;
    start = next;
  }
  return tracks;
}

async function loadLibrary() {
  state.loading = true;
  state.section = null;
  el("content").innerHTML = `<div class="empty">Загрузка…</div>`;
  await loadLocalTracks();
  let vkList = [];
  let sections = [];
  let playlists = [];
  let vkError = "";
  try {
    const res = await invoke("catalog_get_audio", { ownerId: state.user?.id ?? null });
    sections = (res.catalog && res.catalog.sections) || [];
    playlists = ownPlaylists(res.playlists, state.user?.id);
    const lib = librarySection(sections);
    vkList = lib
      ? await loadMyMusic(lib.id).catch(() => (res.audios || []).map(normTrack))
      : (res.audios || []).map(normTrack);
  } catch (e) {
    vkError = vkHint(e);
  }
  state.tracks = vkList;
  state.libraryKeys = new Set(vkList.map(trackKey));
  state.playlists = playlists;
  let html = "";
  if (vkError) html += `<div class="notice"><div class="notice-title">VK недоступен</div><div class="notice-text">${esc(vkError)}</div></div>`;
  if (sections.length)
    html +=
      `<div class="section-title">Разделы</div><div class="row" style="flex-wrap:wrap">` +
      sections.map((s) => `<button class="ghost" data-section="${esc(s.id)}">${esc(s.title || s.id)}</button>`).join("") +
      `</div>`;
  if (playlists.length) html += `<div class="section-title">Плейлисты • ${playlists.length}</div>` + playlistGrid(playlists);
  if (vkList.length) html += `<div class="section-title">Мои треки • ${vkList.length}</div>` + vkList.map((t, i) => trackRow(t, i, vkList)).join("");
  if (state.local.length) html += `<div class="section-title">Локальные файлы • ${state.local.length}</div>` + state.local.map((l, i) => localRow(l, i)).join("");
  if (!html) html = `<div class="empty">Пусто. Добавь папку с музыкой в Настройках.</div>`;
  el("content").innerHTML = html;
  bindTracks(el("content"), vkList);
  bindPlaylists(el("content"), playlists);
  el("content").querySelectorAll("[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => loadSection(btn.dataset.section, btn.textContent));
  });
  el("content").querySelectorAll("[data-li]").forEach((row) => {
    const i = Number(row.dataset.li);
    row.addEventListener("dblclick", () => playLocal(i));
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      playLocal(i);
    });
    const rm = row.querySelector("[data-lrm]");
    if (rm)
      rm.addEventListener("click", async (e) => {
        e.stopPropagation();
        await invoke("local_remove", { id: state.local[i].id });
        await loadLibrary();
      });
  });
  state.loading = false;
}

function orderedByBlocks(list, blocks) {
  const ids = [];
  for (const b of blocks || []) for (const id of (b && b.audios_ids) || []) ids.push(String(id));
  if (!ids.length) return list;
  const byKey = new Map();
  for (const t of list) {
    byKey.set(`${t.id}_${t.owner_id}`, t);
    byKey.set(`${t.owner_id}_${t.id}`, t);
  }
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const t = byKey.get(id);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of list) if (!seen.has(t)) out.push(t);
  return out;
}

function renderSection(sectionId, title, res, append) {
  const section = res.section || {};
  const page = orderedByBlocks((res.audios || []).map(normTrack), section.blocks || []);
  const prev = append && state.section && state.section.id === sectionId ? state.section.tracks : [];
  const seen = new Set(prev.map(trackKey));
  const tracks = prev.concat(page.filter((t) => !seen.has(trackKey(t))));
  const nextFrom = section.next_from || null;
  const name = title || section.title || sectionId;
  state.section = { id: sectionId, title: name, tracks, nextFrom };
  state.tracks = tracks;
  el("content").innerHTML =
    `<div class="row" style="align-items:center"><button class="ghost" id="back-lib">← Библиотека</button><div class="section-title" style="margin:0">${esc(name)} • ${tracks.length}</div></div>` +
    (tracks.length ? tracks.map((t, i) => trackRow(t, i, tracks)).join("") : `<div class="empty">В разделе нет треков</div>`) +
    (nextFrom ? `<div class="row" style="margin-top:12px"><button class="ghost" id="more-btn">Ещё</button></div>` : "");
  bindTracks(el("content"), tracks);
  el("back-lib").addEventListener("click", () => openView("library"));
  const more = el("more-btn");
  if (more)
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = "Загрузка…";
      try {
        const next = await invoke("catalog_get_section", { sectionId, startFrom: state.section.nextFrom });
        renderSection(sectionId, state.section.title, next, true);
      } catch (e) {
        more.disabled = false;
        more.textContent = `Ошибка: ${e}`;
      }
    });
}

async function loadSection(sectionId, title = "") {
  el("content").innerHTML = `<div class="empty">Загрузка раздела…</div>`;
  try {
    const res = await invoke("catalog_get_section", { sectionId, startFrom: null });
    renderSection(sectionId, title || "", res, false);
  } catch (e) {
    el("content").innerHTML = `<div class="empty" style="text-align:left;padding:0 0 12px">Ошибка раздела: ${esc(String(e))}</div><div class="row"><button class="ghost" id="back-lib">← Библиотека</button></div>`;
    el("back-lib").addEventListener("click", () => openView("library"));
  }
}

function playLocal(i) {
  state.queue = state.local.map(localToTrack);
  state.index = i;
  playCurrent();
}

function searchHistory() {
  try {
    const list = JSON.parse(state.settings.search_history || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberSearch(q) {
  const list = [q, ...searchHistory().filter((x) => x !== q)].slice(0, 8);
  state.settings.search_history = JSON.stringify(list);
  invoke("settings_set", { key: "search_history", value: state.settings.search_history }).catch(() => {});
}

function toast(message) {
  const box = el("toasts");
  if (!box) return;
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  box.appendChild(item);
  setTimeout(() => item.remove(), 2600);
}

async function copyTrack(t) {
  const url = `https://vk.com/audio${t.owner_id}_${t.id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Ссылка скопирована");
    return;
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = url;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("Ссылка скопирована");
  } catch {
    toast("Не удалось скопировать ссылку");
  }
}

function renderSearchStub() {
  const history = searchHistory();
  el("content").innerHTML = history.length
    ? `<div class="section-title">Недавние запросы</div><div class="hist-chips">` +
      history.map((q, i) => `<button class="ghost hist-chip" data-hist="${i}">${esc(q)}</button>`).join("") +
      `</div><p class="hint" style="margin-top:16px">Введи запрос, чтобы найти треки, плейлисты и исполнителей.</p>`
    : `<div class="empty">Введи запрос и нажми «Найти».</div>`;
  el("content").querySelectorAll("[data-hist]").forEach((btn) => {
    btn.addEventListener("click", () => {
      el("search-input").value = history[Number(btn.dataset.hist)];
      doSearch();
    });
  });
}

async function doSearch() {
  const q = el("search-input").value.trim();
  if (!q) return;
  el("content").innerHTML = `<div class="empty">Поиск…</div>`;
  try {
    const res = await invoke("audio_search2", { q, count: 100, offset: 0 });
    const list = (res.items || []).map(normTrack);
    state.tracks = list;
    const total = res.count ?? list.length;
    el("content").innerHTML = `<div class="section-title">Найдено: ${esc(total)} • показано ${list.length}</div>` + (list.length ? list.map((t, i) => trackRow(t, i, list)).join("") : `<div class="empty">Ничего не найдено</div>`);
    bindTracks(el("content"), list);
    rememberSearch(q);
  } catch (e) {
    el("content").innerHTML = `<div class="empty">Ошибка: ${esc(String(e))}</div>`;
  }
}

function playlistPhoto(p) {
  const photo = p.photo || {};
  const thumbs = p.thumbs || {};
  return photo.photo_600 || photo.photo_300 || thumbs.photo_600 || thumbs.photo_300 || p.photo_600 || "";
}

function playlistGrid(list) {
  return (
    `<div class="playlist-grid">` +
    list
      .map(
        (p, i) =>
          `<div class="playlist-card" data-pi="${i}">${coverBox(playlistPhoto(p), p.title, "pcover")}<div><div class="name">${esc(p.title)}</div><div class="meta">${esc(p.count || 0)} треков</div></div></div>`
      )
      .join("") +
    `</div>`
  );
}

function bindPlaylists(container, list) {
  container.querySelectorAll(".playlist-card[data-pi]").forEach((card) => {
    card.addEventListener("click", () => openPlaylist(list[Number(card.dataset.pi)]));
  });
}

async function loadPlaylists() {
  el("content").innerHTML = `<div class="empty">Загрузка плейлистов…</div>`;
  try {
    const res = await invoke("catalog_get_audio", { ownerId: state.user?.id ?? null });
    const list = ownPlaylists(res.playlists, state.user?.id);
    state.playlists = list;
    el("content").innerHTML = `<div class="section-title">Плейлисты • ${list.length}</div>` + (list.length ? playlistGrid(list) : `<div class="empty">Плейлистов нет</div>`);
    bindPlaylists(el("content"), list);
  } catch (e) {
    el("content").innerHTML = `<div class="empty">Ошибка: ${esc(String(e))}</div>`;
  }
}

async function openPlaylist(p) {
  const sectionId = `playlist${p.owner_id}_${p.id}`;
  el("content").innerHTML = `<div class="empty">Загрузка плейлиста…</div>`;
  try {
    const res = await invoke("catalog_get_section", { sectionId, startFrom: null });
    renderSection(sectionId, p.title || "", res, false);
  } catch (e) {
    const list = state.playlists || [];
    el("content").innerHTML =
      `<div class="empty" style="text-align:left;padding:0 0 12px">Плейлист недоступен через каталог: ${esc(String(e))}</div>` +
      (list.length ? `<div class="section-title">Плейлисты • ${list.length}</div>` + playlistGrid(list) : "") +
      `<div class="row"><button class="ghost" id="back-lib">← Библиотека</button></div>`;
    el("back-lib").addEventListener("click", () => openView("library"));
  }
}

async function likeTrack(t) {
  const key = trackKey(t);
  const inLib = state.libraryKeys.has(key);
  try {
    if (inLib) {
      await invoke("audio_delete2", { audioId: t.id, ownerId: t.owner_id });
      state.libraryKeys.delete(key);
    } else {
      await invoke("audio_add2", { audioId: t.id, ownerId: t.owner_id });
      state.libraryKeys.add(key);
    }
    await loadLibrary();
  } catch (e) {
    alert(`Не удалось ${inLib ? "убрать" : "добавить"}: ${e}`);
  }
}

async function cacheTrack(t) {
  if (t.hls && t.url.includes(".m3u8")) return alert("HLS-поток нельзя кэшировать как файл.");
  if (!t.url) return alert("У трека нет прямого URL (только HLS) — кэш недоступен.");
  const key = trackKey(t);
  try {
    await invoke("cache_download", { key, url: t.url });
    const meta = cacheMeta();
    meta[key] = t;
    saveCacheMeta(meta);
    await refreshCacheIndex();
    const row = document.querySelector(`.track[data-idx]`);
    if (state.view === "cache") await renderCache();
    if (state.queue[state.index] && trackKey(state.queue[state.index]) === key) {
      audio.src = mediaUrl(key);
      audio.play();
    }
    if (row) row.querySelector(".sub").insertAdjacentHTML("beforeend", ' • <span style="color:var(--accent-2)">кэш</span>');
  } catch (e) {
    alert(`Ошибка кэширования: ${e}`);
  }
}

async function renderCache() {
  await refreshCacheIndex();
  const meta = cacheMeta();
  const entries = [...state.cache.values()].sort((a, b) => b.created_at - a.created_at);
  const total = entries.reduce((s, e) => s + (e.size || 0), 0);
  const list = entries
    .map((e) => {
      const t = meta[e.key];
      return { key: e.key, size: e.size, track: t ? { ...t, owner_id: t.owner_id } : null };
    })
    .filter((x) => x.track);
  el("content").innerHTML =
    `<div class="cache-info"><div class="section-title" style="margin:0">Кэш • ${list.length} • ${(total / 1048576).toFixed(1)} MB</div><button id="cache-clear" class="ghost">Очистить всё</button></div>` +
    (list.length
      ? list
          .map((x, i) => `<div class="track" data-ci="${i}"><div class="idx">${i + 1}</div><div><div class="title">${esc(x.track.title)}</div><div class="sub">${esc(x.track.artist)} • ${(x.size / 1048576).toFixed(1)} MB</div></div><div class="time">${fmtTime(x.track.duration)}</div><div class="actions"><button class="ghost" data-del="${i}">Удалить</button></div></div>`)
          .join("")
      : `<div class="empty">Пусто. Нажми «Кэш» у трека в библиотеке.</div>`);
  const playFromCache = (i) => {
    const track = list[i].track;
    state.queue = list.map((x) => x.track);
    state.index = i;
    playCurrent();
  };
  el("content").querySelectorAll("[data-ci]").forEach((row) => {
    row.addEventListener("dblclick", () => playFromCache(Number(row.dataset.ci)));
  });
  el("content").querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const entry = list[Number(btn.dataset.del)];
      await invoke("cache_delete", { key: entry.key });
      const meta = cacheMeta();
      delete meta[entry.key];
      saveCacheMeta(meta);
      await renderCache();
    });
  });
  const clear = el("cache-clear");
  if (clear)
    clear.addEventListener("click", async () => {
      if (!confirm("Удалить весь кэш?")) return;
      await invoke("cache_clear");
      saveCacheMeta({});
      await renderCache();
    });
}

function renderSettings() {
  const s = state.settings;
  el("content").innerHTML = `<div class="settings">
    <div class="section-title">Внешний вид</div>
    <div class="track"><div class="idx">T</div><div><div class="title">Тема</div><div class="sub">Оформление интерфейса</div></div><div></div>
      <select id="theme-select">${themes.map((t) => `<option value="${t}" ${t === (s.theme || "dark") ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="track"><div class="idx">A</div><div><div class="title">Акцент</div><div class="sub">Цвет кнопок и выделения</div></div><div></div>
      <input id="accent-input" type="color" value="${esc(s.accent || "#6f9dff")}" />
    </div>
    <div class="section-title">Аккаунт</div>
    <div class="track"><div class="idx">ID</div><div><div class="title">client_id для OAuth</div><div class="sub">Используется кнопкой «Открыть VK OAuth»</div></div><div></div>
      <div class="row"><input id="client-id-input" placeholder="2685278" value="${esc(s.client_id || "")}" /><button id="save-client" class="ghost">Сохранить</button></div>
    </div>
    <div class="track"><div class="idx">VK</div><div><div class="title">Токен</div><div class="sub">Права audio, offline</div></div><div></div>
      <div class="row"><button id="reauth" class="ghost">Сменить</button><button id="logout2" class="ghost">Выйти</button></div>
    </div>
    <div class="section-title">Локальная фонотека</div>
    <div class="track"><div class="idx">M</div><div><div class="title">Папка с музыкой</div><div class="sub">MP3, FLAC, M4A, OGG, WAV · рекурсивно</div></div><div></div>
      <div class="row"><input id="folder-input" placeholder="D:\\Music" value="${esc(s.music_folder || "")}" /><button id="scan-btn" class="ghost">Сканировать</button></div>
    </div>
    <div class="track"><div class="idx">n</div><div><div class="title">Треков в базе</div><div class="sub">${state.local.length}</div></div><div></div><button id="rescan-btn" class="ghost">Обновить список</button></div>
    <div class="section-title">Обновления</div>
    <div class="track"><div class="idx">U</div><div><div class="title">Версия</div><div class="sub" id="update-status">Проверка не запускалась</div></div><div></div>
      <div class="row"><button id="update-check" class="ghost">Проверить</button><button id="show-update" class="ghost">Что нового</button><button id="update-install" class="ghost hidden">Обновить</button></div>
    </div>
    <div class="track"><div class="idx">URL</div><div><div class="title">Endpoint обновлений</div><div class="sub">latest.json из GitHub Releases</div></div><div></div>
      <div class="row"><input id="update-endpoint" value="${esc(s.update_endpoint || "")}" placeholder="https://github.com/OWNER/REPO/releases/latest/download/latest.json" /><button id="save-endpoint" class="ghost">Сохранить</button></div>
    </div>
    <div class="section-title">О приложении</div>
    <div class="track"><div class="idx">i</div><div><div class="title">VKX Desktop <span id="app-version">0.1.6</span></div><div class="sub">Rust + Tauri 2 · порт музыкального контура VKX 9.0</div></div><div></div><div class="muted small">SPEC.md</div></div></div>`;
  el("theme-select").addEventListener("change", (e) => setSetting("theme", e.target.value));
  el("accent-input").addEventListener("input", (e) => setSetting("accent", e.target.value));
  el("save-client").addEventListener("click", async () => {
    await setSetting("client_id", el("client-id-input").value.trim());
    alert("Сохранено");
  });
  el("reauth").addEventListener("click", () => showLogin());
  el("logout2").addEventListener("click", doLogout);
  el("scan-btn").addEventListener("click", async () => {
    const dir = el("folder-input").value.trim();
    if (!dir) return;
    try {
      const list = await invoke("scan_folder", { dir });
      await setSetting("music_folder", dir);
      state.local = list;
      alert(`Добавлено треков: ${list.length}`);
    } catch (e) {
      alert(`Ошибка сканирования: ${e}`);
    }
  });
  el("rescan-btn").addEventListener("click", async () => {
    const dir = state.settings.music_folder || el("folder-input").value.trim();
    if (!dir) return;
    try {
      state.local = await invoke("scan_folder", { dir });
      renderSettings();
    } catch (e) {
      alert(`Ошибка: ${e}`);
    }
  });
  el("update-check").addEventListener("click", () => checkUpdates(true));
  el("update-install").addEventListener("click", installUpdate);
  el("show-update").addEventListener("click", () => {
    if (state.update && state.update.available) showUpdatePrompt();
    else checkUpdates(true);
  });
  el("save-endpoint").addEventListener("click", async () => {
    await setSetting("update_endpoint", el("update-endpoint").value.trim());
    alert("Endpoint сохранён");
  });
}

async function doLogout() {
  stopLoginPoll();
  await invoke("clear_token");
  state.token = null;
  state.user = null;
  state.queue = [];
  state.index = -1;
  state.section = null;
  state.playlists = [];
  state.libraryKeys = new Set();
  audio.pause();
  showLogin();
}

function renderEq() {
  el("eq-bands").innerHTML = `<div class="empty">Эквалайзер недоступен для сетевых потоков: CDN VK не отдаёт CORS, и Web Audio глушит такой звук. Локальный прокси для EQ — отдельная задача.</div>`;
}

function applyPreset() {
  renderEq();
}

function updateMuteIcon() {
  const button = el("mute");
  if (!button) return;
  const icon = button.querySelector("use");
  if (icon) icon.setAttribute("href", audio.muted ? "#i-volume-off" : "#i-volume");
  button.classList.toggle("on", audio.muted);
}

function setPlayingIcon() {
  const icon = el("play").querySelector("use");
  if (icon) icon.setAttribute("href", audio.paused ? "#i-play" : "#i-pause");
}

function stopHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function displayTrack(t) {
  el("np-title").textContent = t.title;
  el("np-artist").textContent = t.artist;
  el("cover").src = t.cover || "";
  el("cover").style.visibility = t.cover ? "visible" : "hidden";
}

async function restoreQueue() {
  if (!state.token) return;
  try {
    const items = await invoke("queue_load");
    if (!items.length) return;
    const audios = items.map((i) => `${i.owner_id}_${i.id}`).join(",");
    const res = await invoke("vk_audio_method", { method: "audio.getById", params: { audios } });
    const list = (res.items || []).map(normTrack);
    if (!list.length) return;
    state.queue = list;
    let idx = Number(state.settings.queue_index || 0);
    if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) idx = 0;
    state.index = idx;
    displayTrack(list[idx]);
  } catch (e) {
    console.warn("queue restore failed", e);
  }
}

function playCurrent() {
  const t = state.queue[state.index];
  if (!t) return;
  const key = trackKey(t);
  const cached = !t.local_id && state.cache.has(key);
  stopHls();
  const src = t.local_id ? `http://vkxfile.localhost/${t.local_id}` : cached ? mediaUrl(key) : t.url;
  const hlsUrl = t.local_id || cached ? "" : t.hls;
  displayTrack(t);
  if (hlsUrl && window.Hls && window.Hls.isSupported()) {
    state.hls = new Hls({ enableWorker: true });
    state.hls.loadSource(hlsUrl);
    state.hls.attachMedia(audio);
    state.hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
    state.hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal && src) {
        stopHls();
        audio.src = src;
        audio.play().catch(() => {});
      }
    });
  } else {
    audio.src = src || hlsUrl;
    audio.play().catch((e) => console.warn("play failed", e));
  }
  renderActiveRow();
  invoke("queue_save", { items: state.queue.map((x) => ({ id: x.id, owner_id: x.owner_id })) }).catch(() => {});
  invoke("settings_set", { key: "queue_index", value: String(state.index) }).catch(() => {});
}

function renderActiveRow() {
  document.querySelectorAll(".track[data-idx]").forEach((row) => {
    const idx = Number(row.dataset.idx);
    const t = state.tracks[idx];
    row.classList.toggle("active", !!t && !!state.queue[state.index] && trackKey(t) === trackKey(state.queue[state.index]));
  });
  document.querySelectorAll(".track[data-li]").forEach((row) => {
    const l = state.local[Number(row.dataset.li)];
    row.classList.toggle("active", !!l && !!state.queue[state.index] && state.queue[state.index].local_id === l.id);
  });
}

function playList(list, idx) {
  state.queue = list.slice();
  state.index = idx;
  playCurrent();
}

function nextIndex(dir) {
  if (!state.queue.length) return -1;
  if (state.shuffle) {
    if (state.queue.length === 1) return 0;
    let n = state.index;
    while (n === state.index) n = Math.floor(Math.random() * state.queue.length);
    return n;
  }
  const n = state.index + dir;
  if (n < 0) return state.repeat === "all" ? state.queue.length - 1 : 0;
  if (n >= state.queue.length) return state.repeat === "all" ? 0 : state.queue.length - 1;
  return n;
}

function next(auto = false) {
  const n = nextIndex(1);
  if (n === state.index && auto) {
    if (state.repeat === "track") {
      audio.currentTime = 0;
      audio.play();
    }
    return;
  }
  state.index = n;
  playCurrent();
}

function prev() {
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  state.index = nextIndex(-1);
  playCurrent();
}

function renderQueue() {
  el("queue-list").innerHTML = state.queue
    .map((t, i) => `<li class="${i === state.index ? "active" : ""}" data-qi="${i}">${i + 1}. ${esc(t.artist)} — ${esc(t.title)}</li>`)
    .join("");
  el("queue-list").querySelectorAll("[data-qi]").forEach((li) => {
    li.addEventListener("click", () => {
      state.index = Number(li.dataset.qi);
      playCurrent();
      renderQueue();
    });
  });
}

async function loadLyrics() {
  const t = state.queue[state.index];
  if (!t) return;
  el("lyrics-text").textContent = "Загрузка…";
  el("lyrics-modal").showModal();
  if (!t.lyrics_id) {
    el("lyrics-text").textContent = "У этого трека нет сохранённого текста (lyrics_id отсутствует).";
    return;
  }
  try {
    const res = await invoke("vk_audio_method", { method: "audio.getLyrics", params: { lyrics_id: Number(t.lyrics_id) } });
    el("lyrics-text").textContent = res.text || "Пусто";
  } catch (e) {
    el("lyrics-text").textContent = `Ошибка: ${e}`;
  }
}

function bind() {
  document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => openView(b.dataset.view)));
  el("web-login").addEventListener("click", startLoginPoll);
  el("toggle-cookie").addEventListener("click", () => el("cookie-fields").classList.toggle("hidden"));
  el("check-login").addEventListener("click", async () => {
    el("login-error").textContent = "Проверяю вход…";
    try {
      const info = await invoke("vk_capture_cookies");
      if (info && info.access_token) await finishLogin(info);
      else el("login-error").textContent = "Cookie пока нет. Войди в окне VK по номеру/паролю и нажми снова.";
    } catch (e) {
      el("login-error").textContent = String(e);
    }
  });
  el("cookie-login").addEventListener("click", loginWithCookies);
  el("oauth").addEventListener("click", async () => {
    const clientId = el("client-id").value.trim();
    if (clientId) await setSetting("client_id", clientId);
    const url = await invoke("auth_url");
    await invoke("open_url", { url });
  });
  el("login-btn").addEventListener("click", async () => {
    try {
      el("login-error").textContent = "";
      await finishLogin(await invoke("save_token", { input: el("token-input").value }));
    } catch (e) {
      el("login-error").textContent = String(e);
    }
  });
  el("logout").addEventListener("click", doLogout);
  el("refresh").addEventListener("click", () => openView(state.view));
  el("search-btn").addEventListener("click", doSearch);
  el("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  el("play").addEventListener("click", () => {
    if (!state.queue.length) return;
    if (!audio.src && !state.hls) return playCurrent();
    if (audio.paused) {
      audio.play();
    } else audio.pause();
  });
  el("next").addEventListener("click", () => next(false));
  el("prev").addEventListener("click", prev);
  el("shuffle").addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    el("shuffle").classList.toggle("on", state.shuffle);
  });
  el("repeat").addEventListener("click", () => {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "track" : "off";
    const icon = el("repeat").querySelector("use");
    if (icon) icon.setAttribute("href", state.repeat === "track" ? "#i-repeat-one" : "#i-repeat");
    el("repeat").classList.toggle("on", state.repeat !== "off");
  });

  audio.addEventListener("play", setPlayingIcon);
  audio.addEventListener("pause", setPlayingIcon);
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("loadedmetadata", () => (el("dur").textContent = fmtTime(audio.duration)));
  audio.addEventListener("timeupdate", () => {
    el("cur").textContent = fmtTime(audio.currentTime);
    if (audio.duration) el("seek").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  });
  el("seek").addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (Number(el("seek").value) / 1000) * audio.duration;
  });
  el("volume").addEventListener("input", () => {
    audio.volume = Number(el("volume").value) / 100;
    audio.muted = false;
    updateMuteIcon();
  });
  audio.volume = Number(el("volume").value) / 100;
  el("mute").addEventListener("click", () => {
    audio.muted = !audio.muted;
    updateMuteIcon();
  });
  updateMuteIcon();

  el("queue-btn").addEventListener("click", () => {
    renderQueue();
    el("queue-modal").showModal();
  });
  el("lyrics-btn").addEventListener("click", loadLyrics);
  el("eq-btn").addEventListener("click", () => {
    renderEq();
    el("eq-modal").showModal();
  });
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("cover-img")) return;
      const box = img.parentElement;
      const name = img.dataset.name || "?";
      img.remove();
      if (box) {
        box.classList.add("cover-missing");
        box.dataset.letter = (name.trim()[0] || "?").toUpperCase();
      }
    },
    true
  );
  el("update-now").addEventListener("click", installUpdate);
  el("update-later").addEventListener("click", async () => {
    if (state.update && state.update.version) await setSetting("skipped_update", state.update.version);
    el("update-modal").close();
  });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space") {
      e.preventDefault();
      el("play").click();
    }
    if (e.code === "ArrowRight" && e.shiftKey) next(false);
    if (e.code === "ArrowLeft" && e.shiftKey) prev();
    if (e.code === "Slash") {
      e.preventDefault();
      openView("search");
      el("search-input").focus();
      return;
    }
    const views = { Digit1: "library", Digit2: "playlists", Digit3: "cache", Digit4: "settings" };
    if (views[e.code] && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      openView(views[e.code]);
    }
    if (e.code === "KeyC" && e.ctrlKey) {
      const t = state.queue[state.index];
      if (t) cacheTrack(t);
    }
  });
}

bind();
boot().catch((e) => showLogin(String(e)));