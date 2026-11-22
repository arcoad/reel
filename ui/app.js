const { invoke } = window.__TAURI__.core;

const audio = document.getElementById("audio");
const el = (id) => document.getElementById(id);

const state = {
  token: null,
  user: null,
  view: "home",
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
  cacheMeta: new Map(),
  resumePosition: 0,
  saveTimer: null,
  section: null,
  playlists: [],
  libraryKeys: new Set(),
  loginPoll: null,
  loginBusy: false,
  update: null,
  accountReady: null,
  recent: [],
  recentExpanded: false,
  recentLoading: false,
  recentRequested: false,
};

const CACHE_META = "reel_cache_meta";
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
  return `http://reelcache.localhost/${key}`;
}

async function loadCacheMeta() {
  try {
    const rows = await invoke("cache_meta_all");
    state.cacheMeta = new Map(rows);
    if (!rows.length) {
      try {
        const legacy = JSON.parse(localStorage.getItem(CACHE_META) || "{}");
        for (const [key, value] of Object.entries(legacy)) {
          const json = JSON.stringify(value);
          state.cacheMeta.set(key, json);
          await invoke("cache_meta_set", { key, json });
        }
      } catch {}
    }
  } catch {
    state.cacheMeta = new Map();
  }
}

function cacheMetaObject() {
  const result = {};
  for (const [key, json] of state.cacheMeta) {
    try {
      result[key] = JSON.parse(json);
    } catch {}
  }
  return result;
}

async function setCacheMeta(key, track) {
  const json = JSON.stringify(track);
  state.cacheMeta.set(key, json);
  await invoke("cache_meta_set", { key, json });
}

async function api(method, params = {}) {
  return invoke("vk_method", { method, params });
}

async function loadSettings() {
  const rows = await invoke("settings_all");
  const s = {};
  for (const [k, v] of rows) s[k] = v;
  state.settings = s;
  loadRecent();
  applyTheme();
}

function loadRecent() {
  try {
    const list = JSON.parse(state.settings.recent_tracks || "[]");
    state.recent = Array.isArray(list) ? list.filter((t) => t && t.id && (t.url || t.hls || t.local_id)).slice(0, 30) : [];
  } catch {
    state.recent = [];
  }
}

function rememberTrack(t) {
  if (!t || !t.id) return;
  const key = trackKey(t);
  state.recent = [t, ...state.recent.filter((x) => trackKey(x) !== key)].slice(0, 30);
  const rows = state.recent.map(({ id, owner_id, title, artist, duration, url, hls, lyrics_id, access_key, explicit, cover }) => ({ id, owner_id, title, artist, duration, url, hls, lyrics_id, access_key, explicit, cover }));
  state.settings.recent_tracks = JSON.stringify(rows);
  invoke("settings_set", { key: "recent_tracks", value: state.settings.recent_tracks }).catch(() => {});
  if (state.view === "home") renderRecent();
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
  el("user-name").textContent = name || "Не выполнен вход";
  const initials = [u.first_name, u.last_name]
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  el("user-avatar").textContent = initials || (u.domain ? u.domain.slice(0, 2).toUpperCase() : "?");
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

async function boot() {
  await loadSettings();
  await loadCacheMeta();
  state.token = await invoke("get_token");
  if (state.token) await afterLogin();
  else showLogin();
  await refreshCacheIndex();
  setInterval(() => {
    if (!audio.paused) savePlayback();
  }, 5000);
  window.addEventListener("beforeunload", () => savePlayback());
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
  el("home-search-form").classList.toggle("hidden", view !== "home");
  el("refresh").classList.toggle("hidden", view === "home" || view === "settings" || view === "search");
  const titles = { home: "Главная", library: "Библиотека", search: "Поиск", playlists: "Плейлисты", cache: "Кэш", settings: "Настройки" };
  el("view-title").textContent = titles[view] || view;
}

async function openView(view) {
  setViewChrome(view);
  const content = el("content");
  content.classList.remove("view-in");
  void content.offsetWidth;
  content.classList.add("view-in");
  if (view === "home") return renderHome();
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
  if (code === 9 || /Flood control/i.test(msg)) return "Сервис временно ограничил запросы. Подожди 15–30 минут.";
  if (code === 5) return "Токен недействителен или отозван. Войди заново через окно входа.";
  if (code === 3 || /Unknown method/i.test(msg)) return "Этот токен не подходит для сервиса. Войди через окно входа.";
  return msg || "Не удалось получить данные сервиса.";
}

async function loadLocalTracks() {
  try {
    state.local = await invoke("local_tracks");
  } catch {
    state.local = [];
  }
}

function inferUid(res) {
  const sections = (res.catalog && res.catalog.sections) || [];
  for (const section of sections) {
    const match = String(section.url || "").match(/\/audios(\d+)/);
    if (match) return Number(match[1]);
  }
  const generated = (res.playlists || []).find((p) => p.type === "generated" || Number(p.id) < 0);
  return generated && generated.owner_id ? Number(generated.owner_id) : null;
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

function orderedStrict(list, blocks) {
  const ids = [];
  for (const block of blocks || []) for (const id of block.audios_ids || []) ids.push(String(id));
  if (!ids.length) return list;
  const byKey = new Map();
  for (const track of list) {
    byKey.set(`${track.id}_${track.owner_id}`, track);
    byKey.set(`${track.owner_id}_${track.id}`, track);
  }
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const track = byKey.get(id);
    if (track && !seen.has(track)) {
      seen.add(track);
      out.push(track);
    }
  }
  return out;
}

async function loadMyMusic(sectionId) {
  const seen = new Set();
  const tracks = [];
  let start = null;
  for (let page = 0; page < 50; page++) {
    const res = await invoke("catalog_get_section", { sectionId, startFrom: start });
    const section = res.section || {};
    const block = (section.blocks || []).find((b) => (b.audios_ids || []).length);
    const pageTracks = orderedStrict((res.audios || []).map(normTrack), section.blocks || []);
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

function startWave(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const bands = [
    { base: 0.54, amp: 0.13, freq: 2.6, speed: 0.1, width: 0.3, phase: 0.0 },
    { base: 0.46, amp: 0.11, freq: 3.2, speed: -0.08, width: 0.2, phase: 2.1 },
    { base: 0.62, amp: 0.08, freq: 2.0, speed: 0.06, width: 0.1, phase: 4.2 },
  ];
  let w = 1;
  let h = 1;
  let xs = [];
  let grads = [];
  let glow = null;
  let raf = 0;
  let last = 0;
  const start = performance.now();

  function build() {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(1, rect.width);
    h = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    xs = [];
    for (let i = 0; i <= 120; i++) xs.push(-0.08 * w + (1.16 * w * i) / 120);
    grads = bands.map((band, i) => {
      const gradient = ctx.createLinearGradient(-0.1 * w, 0, 1.1 * w, 0);
      gradient.addColorStop(0, "rgba(60,30,160,0)");
      gradient.addColorStop(0.18, i === 1 ? "rgba(92,60,255,0.35)" : "rgba(100,60,255,0.5)");
      gradient.addColorStop(0.55, i === 1 ? "rgba(140,100,255,0.55)" : "rgba(170,130,255,0.8)");
      gradient.addColorStop(0.85, i === 1 ? "rgba(90,50,220,0.35)" : "rgba(110,70,255,0.5)");
      gradient.addColorStop(1, "rgba(70,40,190,0)");
      return gradient;
    });
    glow = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.05, w * 0.5, h * 0.5, w * 0.6);
    glow.addColorStop(0, "rgba(110,70,255,0.12)");
    glow.addColorStop(0.55, "rgba(80,45,200,0.06)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
  }

  function path(band, time) {
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const p = x / w;
      const y =
        h *
        (band.base +
          Math.sin(p * band.freq * 6.283 + time * band.speed + band.phase) * band.amp +
          Math.sin(p * 11.2 - time * 0.11 + band.phase) * band.amp * 0.28);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function frame(now) {
    if (!canvas.isConnected) {
      observer.disconnect();
      cancelAnimationFrame(raf);
      return;
    }
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;
    last = now;
    const time = (now - start) / 1000;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      path(band, time);
      ctx.strokeStyle = grads[i];
      ctx.globalAlpha = 0.14;
      ctx.lineWidth = h * band.width;
      ctx.stroke();
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = h * band.width * 0.34;
      ctx.stroke();
      ctx.globalAlpha = 0.1;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  const observer = new ResizeObserver(build);
  observer.observe(canvas);
  build();
  raf = requestAnimationFrame(frame);
}

function recentCard(t, i) {
  const cover = t.cover
    ? `<img src="${esc(t.cover)}" alt="" loading="lazy" />`
    : `<span class="recent-letter">${esc((t.title || "?").trim().charAt(0).toUpperCase())}</span>`;
  return `<button class="recent-card" data-recent="${i}" title="Включить снова" aria-label="Включить ${esc(t.title)} — ${esc(t.artist)}">
    <span class="recent-cover">${cover}<span class="recent-play"><svg class="i"><use href="#i-play"></use></svg></span></span>
    <span class="recent-name">${esc(t.title)}</span>
    <span class="recent-artist">${esc(t.artist)}</span>
  </button>`;
}

function renderRecent() {
  const section = el("recent-section");
  if (!section) return;
  const all = state.recent;
  const visible = all.slice(0, state.recentExpanded ? 12 : 6);
  const cards = visible.length
    ? visible.map((t, i) => recentCard(t, i)).join("")
    : state.recentLoading
      ? Array.from({ length: 6 }, () => `<div class="recent-card is-skeleton"><span class="recent-cover"></span><span class="recent-skel-line"></span><span class="recent-skel-line short"></span></div>`).join("")
      : `<div class="recent-empty">Пока пусто. Включи трек — он появится здесь.</div>`;
  section.innerHTML = `<div class="recent-head">
    <div class="recent-title">Недавно прослушанное <span class="recent-chev">›</span></div>
    ${all.length > 6 ? `<button class="recent-all" id="recent-all">${state.recentExpanded ? "Свернуть" : "Показать всё"}</button>` : ""}
  </div><div class="recent-row">${cards}</div>`;
  section.querySelectorAll("[data-recent]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.recent);
      playList(visible, index);
    });
  });
  const allButton = el("recent-all");
  if (allButton) {
    allButton.addEventListener("click", () => {
      state.recentExpanded = !state.recentExpanded;
      renderRecent();
    });
  }
  bindRecentWheel(section.querySelector(".recent-row"));
}

function bindRecentWheel(row) {
  if (!row) return;
  const maxScroll = () => Math.max(0, row.scrollWidth - row.clientWidth);
  let target = row.scrollLeft;
  let raf = 0;
  let settle = 0;
  let direction = 1;
  const animate = () => {
    if (!row.isConnected) {
      raf = 0;
      return;
    }
    const diff = target - row.scrollLeft;
    if (Math.abs(diff) < 0.6) {
      row.scrollLeft = target;
      raf = 0;
      return;
    }
    row.scrollLeft += diff * 0.22;
    raf = requestAnimationFrame(animate);
  };
  const start = () => {
    if (!raf) raf = requestAnimationFrame(animate);
  };
  const stepSize = () => {
    const card = row.querySelector(".recent-card");
    const gap = parseFloat(getComputedStyle(row).columnGap) || 14;
    return (card ? card.getBoundingClientRect().width : 150) + gap;
  };
  row.addEventListener(
    "wheel",
    (e) => {
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1;
      const move = delta * scale;
      const max = maxScroll();
      if (!max) return;
      e.preventDefault();
      const current = target;
      const next = Math.min(max, Math.max(0, current + move));
      if (next === current) return;
      target = next;
      direction = Math.sign(move) || 1;
      clearTimeout(settle);
      settle = setTimeout(() => {
        const step = stepSize();
        const snapped = direction > 0 ? Math.ceil(target / step) * step : Math.floor(target / step) * step;
        target = Math.min(max, Math.max(0, snapped));
        start();
      }, 140);
      start();
    },
    { passive: false },
  );
  row.addEventListener("scroll", () => {
    if (!raf) target = row.scrollLeft;
  });
}

async function ensureRecent() {
  if (state.recent.length || state.recentRequested) return;
  if (state.accountReady) await state.accountReady;
  state.recentRequested = true;
  state.recentLoading = true;
  renderRecent();
  try {
    const res = await invoke("catalog_get_section", { sectionId: "my", startFrom: null });
    const list = (res.audios || []).map(normTrack).filter((t) => t.url || t.hls).slice(0, 12);
    if (!state.recent.length) state.recent = list;
  } catch {}
  state.recentLoading = false;
  if (state.view === "home") renderRecent();
}

async function renderHome() {
  el("content").innerHTML = `<section class="hero">
    <canvas id="wave-canvas" class="hero-art" aria-hidden="true"></canvas>
    <div class="hero-copy">
      <div class="hero-kicker">REEL</div>
      <h1>Моя <span>волна</span></h1>
      <p>Умная подборка музыки под твоё настроение</p>
      <div class="hero-actions">
        <button id="wave-play" class="primary">Слушать</button>
      </div>
    </div>
  </section>
  <section class="recent" id="recent-section"></section>`;
  startWave(el("wave-canvas"));
  renderRecent();
  ensureRecent();
  el("wave-play").addEventListener("click", playWave);
}

async function playWave() {
  try {
    if (state.accountReady) await state.accountReady;
    const res = await invoke("catalog_get_section", { sectionId: "my", startFrom: null });
    const list = (res.audios || []).map(normTrack).slice(0, 50);
    if (!list.length) return toast("Нет треков для волны");
    state.queue = list;
    state.index = 0;
    playCurrent();
    toast("Волна запущена");
  } catch (e) {
    toast(String(e));
  }
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
    if (!state.user?.id) {
      const inferred = inferUid(res);
      if (inferred) state.user = { ...(state.user || {}), id: inferred };
    }
    playlists = ownPlaylists(res.playlists, state.user?.id);
    const lib = librarySection(sections);
    vkList = lib ? await loadMyMusic(lib.id) : [];
  } catch (e) {
    vkError = vkHint(e);
  }
  state.tracks = vkList;
  state.libraryKeys = new Set(vkList.map(trackKey));
  state.playlists = playlists;
  let html = "";
  if (vkError) html += `<div class="notice"><div class="notice-title">Сервис недоступен</div><div class="notice-text">${esc(vkError)}</div></div>`;
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

function startSearch(query) {
  const q = String(query || "").trim();
  if (!q) return;
  el("search-input").value = q;
  openView("search");
  doSearch();
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
    if (!state.user?.id) {
      const inferred = inferUid(res);
      if (inferred) state.user = { ...(state.user || {}), id: inferred };
    }
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

async function togglePlayerLike() {
  const t = state.queue[state.index];
  if (!t) return;
  const key = trackKey(t);
  const next = !state.libraryKeys.has(key);
  try {
    if (next) await invoke("audio_add2", { audioId: t.id, ownerId: t.owner_id });
    else await invoke("audio_delete2", { audioId: t.id, ownerId: t.owner_id });
    if (next) state.libraryKeys.add(key);
    else state.libraryKeys.delete(key);
    const on = state.libraryKeys.has(key);
    el("like").classList.toggle("on", on);
    el("like").setAttribute("aria-pressed", String(on));
    renderActiveRow();
    toast(next ? "Добавлено в библиотеку" : "Убрано из библиотеки");
  } catch (e) {
    toast(`Не удалось: ${e}`);
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
    await setCacheMeta(key, t);
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
  const meta = cacheMetaObject();
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
      state.cacheMeta.delete(entry.key);
      await renderCache();
    });
  });
  const clear = el("cache-clear");
  if (clear)
    clear.addEventListener("click", async () => {
      if (!confirm("Удалить весь кэш?")) return;
      await invoke("cache_clear");
      state.cacheMeta.clear();
      await renderCache();
    });
}

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
  const enabled = (key, fallback = true) => (s[key] === undefined ? fallback : s[key] === "1");
  const userName = [state.user?.first_name, state.user?.last_name].filter(Boolean).join(" ") || state.user?.domain || (state.user?.id ? String(state.user.id) : "Не выполнен вход");
  const avatar = s.gh_avatar || "https://github.com/arcoad.png";
  const name = s.gh_name || "arcoad";
  const login = s.gh_login || "arcoad";
  el("content").innerHTML = `<div class="settings">
    <div class="profile-card">
      <div class="profile-avatar" id="profile-avatar">${avatar ? `<img id="gh-avatar" src="${esc(avatar)}" alt="" />` : ""}<span id="gh-initial">${esc((name || "A").trim()[0].toUpperCase())}</span></div>
      <div class="profile-info"><div class="profile-name" id="gh-name">${esc(name)}</div><div class="profile-login" id="gh-login">@${esc(login)}</div></div>
      <div class="profile-links"><button class="ghost" data-link="https://t.me/arcoad">Telegram</button><button class="ghost" data-link="https://github.com/arcoad">GitHub</button></div>
    </div>

    <div class="section-title">Поведение</div>
    <div class="setting-list">
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
      <input id="accent-input" type="color" value="${esc(s.accent || "#6f9dff")}" />
    </div>

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
    <div class="setting-row"><div><div class="setting-label">Reel <span id="app-version">1.0.0</span></div><div class="setting-desc">Rust + Tauri · музыкальный плеер</div></div>
      <button class="ghost" data-link="https://github.com/arcoad/reel">GitHub</button>
    </div>
  </div>`;

  el("theme-select").addEventListener("change", (e) => setSetting("theme", e.target.value));
  el("accent-input").addEventListener("input", (e) => setSetting("accent", e.target.value));
  el("content").querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.dataset.toggle;
      const next = !button.classList.contains("on");
      button.classList.toggle("on", next);
      button.setAttribute("aria-checked", String(next));
      await setSetting(key, next ? "1" : "0");
      if (key === "close_to_tray") await invoke("set_close_to_tray", { enabled: next });
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
  state.section = null;
  state.playlists = [];
  state.libraryKeys = new Set();
  state.accountReady = null;
  audio.pause();
  showLogin();
}

function renderEq() {
  el("eq-bands").innerHTML = `<div class="empty">Эквалайзер недоступен для сетевых потоков: CDN сервиса не отдаёт CORS, и Web Audio глушит такой звук. Локальный прокси для EQ — отдельная задача.</div>`;
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

function paintRange(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${Math.min(100, Math.max(0, pct))}%`);
}

function setPlayingIcon() {
  const icon = el("play").querySelector("use");
  if (icon) icon.setAttribute("href", audio.paused ? "#i-play" : "#i-pause");
  updateNowPlayIcon();
}

function updateNowPlayIcon() {
  const icon = el("now-play").querySelector("use");
  if (icon) icon.setAttribute("href", audio.paused ? "#i-play" : "#i-pause");
}

function renderNowView() {
  const track = state.queue[state.index];
  if (!track) return;
  el("now-title").textContent = track.title;
  el("now-artist").textContent = track.artist;
  const cover = el("now-cover");
  cover.src = track.cover || "";
  cover.style.visibility = track.cover ? "visible" : "hidden";
  el("now-bg").style.backgroundImage = track.cover ? `url("${track.cover}")` : "none";
  el("now-cur").textContent = fmtTime(audio.currentTime);
  el("now-dur").textContent = fmtTime(audio.duration || track.duration);
  el("now-seek").value = audio.duration ? String(Math.round((audio.currentTime / audio.duration) * 1000)) : "0";
  updateNowPlayIcon();
}

async function loadNowLyrics() {
  const track = state.queue[state.index];
  if (!track) return;
  const view = el("now-view");
  view.classList.remove("no-lyrics");
  el("now-lyrics").textContent = "Загрузка…";
  const key = trackKey(track);
  let text = "";
  if (track.lyrics_id) {
    try {
      const res = await invoke("lyrics", { lyricsId: Number(track.lyrics_id) });
      text = (res && res.text) || "";
    } catch {}
  }
  if (!text.trim()) {
    try {
      text = (await invoke("external_lyrics", { artist: track.artist, title: track.title })) || "";
    } catch {}
  }
  const current = state.queue[state.index];
  if (!current || trackKey(current) !== key) return;
  if (text.trim()) {
    el("now-lyrics").textContent = text;
    view.classList.remove("no-lyrics");
  } else {
    view.classList.add("no-lyrics");
  }
}

function openNowView() {
  if (!state.queue[state.index]) return;
  el("now-view").classList.remove("hidden");
  renderNowView();
  loadNowLyrics();
}

function closeNowView() {
  el("now-view").classList.add("hidden");
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
  el("cur").textContent = "0:00";
  el("dur").textContent = fmtTime(t.duration);
  el("seek").value = "0";
  paintRange(el("seek"));
  const liked = state.libraryKeys.has(trackKey(t));
  el("like").classList.toggle("on", liked);
  el("like").setAttribute("aria-pressed", String(liked));
}

function playbackSnapshot() {
  return {
    queue: state.queue,
    index: state.index,
    position: audio.currentTime || 0,
    repeat: state.repeat,
    shuffle: state.shuffle,
    volume: audio.volume,
    updated: Date.now(),
  };
}

async function savePlayback() {
  if (state.settings.save_position === "0") return;
  try {
    await invoke("playback_save", { data: JSON.stringify(playbackSnapshot()) });
  } catch {}
}

function schedulePlaybackSave() {
  if (state.settings.save_position === "0") return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(savePlayback, 500);
}

async function restorePlayback() {
  if (!state.token) return;
  try {
    const raw = await invoke("playback_load");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return;
    state.queue = saved.queue;
    let index = Number(saved.index);
    if (!Number.isFinite(index) || index < 0 || index >= state.queue.length) index = 0;
    state.index = index;
    state.repeat = saved.repeat === "track" || saved.repeat === "all" ? saved.repeat : "off";
    state.shuffle = !!saved.shuffle;
    if (typeof saved.volume === "number") {
      audio.volume = Math.min(1, Math.max(0, saved.volume));
      el("volume").value = String(Math.round(audio.volume * 100));
      audio.muted = false;
      updateMuteIcon();
      paintRange(el("volume"));
    }
    state.resumePosition = Number(saved.position) || 0;
    displayTrack(state.queue[index]);
    const repeatIcon = el("repeat").querySelector("use");
    if (repeatIcon) repeatIcon.setAttribute("href", state.repeat === "track" ? "#i-repeat-one" : "#i-repeat");
    el("repeat").classList.toggle("on", state.repeat !== "off");
    el("shuffle").classList.toggle("on", state.shuffle);
    setPlayingIcon();
    if (!el("now-view").classList.contains("hidden")) {
      renderNowView();
      loadNowLyrics();
    }
  } catch (e) {
    console.warn("playback restore failed", e);
  }
}

function playCurrent() {
  const t = state.queue[state.index];
  if (!t) return;
  const key = trackKey(t);
  const cached = !t.local_id && state.cache.has(key);
  stopHls();
  const src = t.local_id ? `http://reelfile.localhost/${t.local_id}` : cached ? mediaUrl(key) : t.url;
  const hlsUrl = t.local_id || cached ? "" : t.hls;
  const resume = state.resumePosition;
  state.resumePosition = 0;
  rememberTrack(t);
  displayTrack(t);
  if (!el("now-view").classList.contains("hidden")) {
    renderNowView();
    loadNowLyrics();
  }
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
  if (resume > 0) {
    const apply = () => {
      if (audio.duration) audio.currentTime = Math.min(resume, Math.max(0, audio.duration - 1));
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener("loadedmetadata", apply, { once: true });
  }
  renderActiveRow();
  schedulePlaybackSave();
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
      else el("login-error").textContent = "Cookie пока нет. Войди в окне входа по номеру/паролю и нажми снова.";
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
  el("support-continue").addEventListener("click", dismissSupport);
  el("support").addEventListener("click", (e) => {
    if (e.target === el("support")) dismissSupport();
  });
  el("support").addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismissSupport();
  });
  el("support").querySelectorAll("[data-link]").forEach((button) => {
    button.addEventListener("click", () => invoke("open_url", { url: button.dataset.link }).catch((e) => toast(String(e))));
  });
  el("refresh").addEventListener("click", () => openView(state.view));
  el("search-btn").addEventListener("click", doSearch);
  el("home-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    startSearch(el("home-search-input").value);
  });
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
    schedulePlaybackSave();
  });
  el("repeat").addEventListener("click", () => {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "track" : "off";
    const icon = el("repeat").querySelector("use");
    if (icon) icon.setAttribute("href", state.repeat === "track" ? "#i-repeat-one" : "#i-repeat");
    el("repeat").classList.toggle("on", state.repeat !== "off");
    schedulePlaybackSave();
  });

  audio.addEventListener("play", setPlayingIcon);
  audio.addEventListener("pause", () => {
    setPlayingIcon();
    savePlayback();
  });
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("loadedmetadata", () => {
    el("dur").textContent = fmtTime(audio.duration);
    paintRange(el("seek"));
  });
  audio.addEventListener("timeupdate", () => {
    el("cur").textContent = fmtTime(audio.currentTime);
    if (audio.duration) el("seek").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    paintRange(el("seek"));
    if (!el("now-view").classList.contains("hidden")) {
      el("now-cur").textContent = fmtTime(audio.currentTime);
      if (audio.duration) el("now-seek").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
  });
  el("seek").addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (Number(el("seek").value) / 1000) * audio.duration;
    paintRange(el("seek"));
    schedulePlaybackSave();
  });
  el("volume").addEventListener("input", () => {
    audio.volume = Number(el("volume").value) / 100;
    audio.muted = false;
    updateMuteIcon();
    paintRange(el("volume"));
    schedulePlaybackSave();
  });
  audio.volume = Number(el("volume").value) / 100;
  paintRange(el("seek"));
  paintRange(el("volume"));
  el("like").addEventListener("click", togglePlayerLike);
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
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("tray-play", () => el("play").click());
    window.__TAURI__.event.listen("app-save", () => savePlayback());
  }
  el("cover").addEventListener("click", openNowView);
  el("now-close").addEventListener("click", closeNowView);
  el("now-play").addEventListener("click", () => el("play").click());
  el("now-prev").addEventListener("click", prev);
  el("now-next").addEventListener("click", () => next(false));
  el("now-seek").addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (Number(el("now-seek").value) / 1000) * audio.duration;
  });
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
    if (e.code === "ArrowRight") {
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    }
    if (e.code === "ArrowLeft") {
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
    }
    if (e.code === "ArrowDown") {
      e.preventDefault();
      next(false);
    }
    if (e.code === "ArrowUp") {
      e.preventDefault();
      prev();
    }
    if (e.code === "Escape") {
      closeNowView();
      document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    }
    if (e.code === "Slash") {
      e.preventDefault();
      if (state.view === "home") el("home-search-input")?.focus();
      else openView("home").then(() => el("home-search-input")?.focus());
      return;
    }
    const views = { Digit0: "home", Digit1: "library", Digit2: "playlists", Digit3: "cache", Digit4: "settings" };
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