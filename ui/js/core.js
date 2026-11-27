// Reel UI — core.js
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
  playlistFilter: "",
  playlistSection: null,
  playlistCache: new Map(),
  playlistOpenReq: 0,
  myMusic: null,
  myMusicLoading: null,
  wave: {
    active: false,
    extending: false,
    deck: [],
    used: new Set(),
    libKeys: new Set(),
    seenMix: new Set(),
    mixOffset: 0,
    mixExhausted: false,
    mixId: "common",
    mixDry: 0,
    options: {},
  },
  dislikedKeys: new Set(),
  waveFilters: null,
  waveFiltersLoading: null,
  libraryKeys: new Set(),
  loginPoll: null,
  loginBusy: false,
  update: null,
  accountReady: null,
  recent: [],
  recentExpanded: false,
  recentLoading: false,
  recentRequested: false,
  lyricsCache: new Map(),
  artistPage: null,
  albumPage: null,
  navStack: [],
  captureHotkey: null,
};

const HOTKEY_ACTIONS = [
  { key: "playPause", label: "Играть / пауза", desc: "По умолчанию: Space" },
  { key: "next", label: "Следующий трек", desc: "По умолчанию: ↓" },
  { key: "prev", label: "Предыдущий трек", desc: "По умолчанию: ↑" },
  { key: "seekForward", label: "Вперёд на 5 секунд", desc: "По умолчанию: →" },
  { key: "seekBack", label: "Назад на 5 секунд", desc: "По умолчанию: ←" },
  { key: "volumeUp", label: "Громче", desc: "По умолчанию: Ctrl + ↑" },
  { key: "volumeDown", label: "Тише", desc: "По умолчанию: Ctrl + ↓" },
  { key: "like", label: "В библиотеку", desc: "По умолчанию: L" },
  { key: "dislike", label: "Дизлайк", desc: "По умолчанию: D" },
  { key: "nowView", label: "Полный плеер", desc: "По умолчанию: F" },
  { key: "lyrics", label: "Скрыть / показать текст", desc: "По умолчанию: T" },
  { key: "mute", label: "Без звука", desc: "По умолчанию: M" },
  { key: "search", label: "Поиск", desc: "По умолчанию: /" },
  { key: "cache", label: "Кэшировать текущий трек", desc: "По умолчанию: Ctrl + C" },
];
const DEFAULT_HOTKEYS = {
  playPause: "Space",
  next: "ArrowDown",
  prev: "ArrowUp",
  seekForward: "ArrowRight",
  seekBack: "ArrowLeft",
  volumeUp: "Ctrl+ArrowUp",
  volumeDown: "Ctrl+ArrowDown",
  like: "KeyL",
  dislike: "KeyD",
  nowView: "KeyF",
  lyrics: "KeyT",
  mute: "KeyM",
  search: "Slash",
  cache: "Ctrl+KeyC",
};
const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

function hotkeyMap() {
  let custom = {};
  try {
    custom = JSON.parse(state.settings.hotkeys || "{}");
  } catch {}
  if (!custom || typeof custom !== "object") custom = {};
  return { ...DEFAULT_HOTKEYS, ...custom };
}

function hotkeyFromEvent(e) {
  if (MODIFIER_CODES.has(e.code)) return "";
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.code);
  return parts.join("+");
}

function hotkeyLabel(combo) {
  const names = {
    Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win",
    Space: "Space", Slash: "/", Backslash: "\\", Comma: ",", Period: ".",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "⌫", Delete: "Del",
  };
  return String(combo || "")
    .split("+")
    .map((part) => names[part] || part.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num "))
    .join(" + ");
}

function beginHotkeyCapture(action, button) {
  state.captureHotkey = action;
  document.querySelectorAll(".hotkey-btn.capturing").forEach((b) => {
    b.classList.remove("capturing");
    const key = b.dataset.hotkey;
    if (key) b.textContent = hotkeyLabel(hotkeyMap()[key]);
  });
  if (button) {
    button.classList.add("capturing");
    button.textContent = "Нажмите клавишу…";
  }
}

function runHotkeyAction(action) {
  if (action === "playPause") return el("play").click();
  if (action === "next") return next(false);
  if (action === "prev") return prev();
  if (action === "seekForward") {
    if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    return;
  }
  if (action === "seekBack") {
    if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
    return;
  }
  if (action === "volumeUp" || action === "volumeDown") {
    const delta = action === "volumeUp" ? 0.05 : -0.05;
    audio.volume = Math.min(1, Math.max(0, audio.volume + delta));
    audio.muted = false;
    el("volume").value = String(Math.round(audio.volume * 100));
    updateMuteIcon();
    paintRange(el("volume"));
    schedulePlaybackSave();
    return;
  }
  if (action === "like") return togglePlayerLike();
  if (action === "dislike") return togglePlayerDislike();
  if (action === "nowView") {
    const view = el("now-view");
    if (view.classList.contains("hidden")) openNowView();
    else closeNowView();
    return;
  }
  if (action === "lyrics") return toggleNowText();
  if (action === "mute") return el("mute").click();
  if (action === "search") {
    if (state.view === "home") el("home-search-input")?.focus();
    else openView("home").then(() => el("home-search-input")?.focus());
    return;
  }
  if (action === "cache") {
    const t = state.queue[state.index];
    if (t) cacheTrack(t);
  }
}

const CACHE_META = "reel_cache_meta";
const themes = ["dark", "light", "amoled", "nord", "gruvbox"];

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const icon = (name, cls = "i") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

function coverOf(t) {
  const album = t.album || {};
  const albumThumb = album.thumb || {};
  const thumb = t.thumb || {};
  const direct = typeof t.cover === "string" ? t.cover : (t.cover && (t.cover.photo_600 || t.cover.photo_300)) || "";
  return (
    albumThumb.photo_1200 ||
    albumThumb.photo_600 ||
    albumThumb.photo_300 ||
    albumThumb.photo_270 ||
    thumb.photo_1200 ||
    thumb.photo_600 ||
    thumb.photo_300 ||
    thumb.photo_270 ||
    album.photo_1200 ||
    album.photo_600 ||
    direct ||
    (typeof t.image === "string" ? t.image : "") ||
    ""
  );
}

function normTrack(t) {
  let hls = "";
  const streams = t.audio_streams || [];
  for (const s of streams) {
    if ((s.type || "").includes("hls") && s.url) hls = s.url;
  }
  const url = t.url || "";
  if (!hls && url.includes(".m3u8")) hls = url;
  const rawAlbum = t.album && t.album.id ? t.album : null;
  const album = rawAlbum
    ? {
        id: Number(rawAlbum.id),
        owner_id: Number(rawAlbum.owner_id),
        title: rawAlbum.title || "",
        access_key: rawAlbum.access_key || "",
        thumb: rawAlbum.thumb || null,
      }
    : null;
  const artists = [];
  for (const a of [...(t.main_artists || []), ...(t.featured_artists || [])]) {
    if (!a || !a.id) continue;
    const id = String(a.id);
    if (artists.some((x) => x.id === id)) continue;
    artists.push({ id, name: a.name || "", domain: a.domain || "" });
  }
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
    album,
    artists,
    disliked: isDislikedKey(`${t.id}_${t.owner_id}`) || !!t.dislike,
  };
}

function isDislikedKey(key) {
  return state.dislikedKeys.has(key);
}

function loadDislikedKeys() {
  try {
    const list = JSON.parse(state.settings.disliked_tracks || "[]");
    state.dislikedKeys = new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    state.dislikedKeys = new Set();
  }
}

async function storeDislikedKeys() {
  const value = JSON.stringify([...state.dislikedKeys]);
  state.settings.disliked_tracks = value;
  await invoke("settings_set", { key: "disliked_tracks", value });
}

function trackKey(t) {
  return `${t.id}_${t.owner_id}`;
}

function trackTitleHtml(t) {
  const title = esc(t.title || "Без названия");
  if (!t.album || !t.album.id || !t.album.owner_id) return title;
  return `<button type="button" class="linklike" data-album-owner="${t.album.owner_id}" data-album-id="${t.album.id}" data-album-title="${esc(t.album.title || t.title || "")}" data-album-cover="${esc(t.cover || "")}">${title}</button>`;
}

function artistLinksHtml(t) {
  const artists = Array.isArray(t.artists) ? t.artists : [];
  if (!artists.length) return esc(t.artist || "");
  return artists
    .map(
      (a) =>
        `<button type="button" class="linklike" data-artist-id="${esc(a.id)}" data-artist-name="${esc(a.name || t.artist || "")}">${esc(a.name || t.artist || "")}</button>`,
    )
    .join('<span class="artist-sep">, </span>');
}

function bindInlineLinks(root) {
  if (!root) return;
  root.querySelectorAll("[data-artist-id]").forEach((node) => {
    node.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeNowView();
      openArtist(node.dataset.artistId, node.dataset.artistName);
    };
  });
  root.querySelectorAll("[data-album-id]").forEach((node) => {
    node.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeNowView();
      openAlbum(node.dataset.albumOwner, node.dataset.albumId, node.dataset.albumTitle, node.dataset.albumCover);
    };
  });
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

async function loadSettings() {
  const rows = await invoke("settings_all");
  const s = {};
  for (const [k, v] of rows) s[k] = v;
  // Разовая миграция: синие акценты из 1.0.x гасили новый лабораторный вид.
  const legacyAccents = ["#6f9dff", "#2f62d8", "#6f9bff", "#8fbcff", "#385594", "#e0a52a"];
  if (!s.design_v2) {
    if (legacyAccents.includes(String(s.accent || "").toLowerCase())) {
      delete s.accent;
      invoke("settings_set", { key: "accent", value: "" }).catch(() => {});
    }
    s.design_v2 = "1";
    invoke("settings_set", { key: "design_v2", value: "1" }).catch(() => {});
  }
  state.settings = s;
  loadRecent();
  loadDislikedKeys();
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
  const rows = state.recent.map(({ id, owner_id, title, artist, duration, url, hls, lyrics_id, access_key, explicit, cover, album, artists, disliked }) => ({ id, owner_id, title, artist, duration, url, hls, lyrics_id, access_key, explicit, cover, album, artists, disliked }));
  state.settings.recent_tracks = JSON.stringify(rows);
  invoke("settings_set", { key: "recent_tracks", value: state.settings.recent_tracks }).catch(() => {});
  if (state.view === "home") renderRecent();
}

function moveNavPill() {
  const pill = el("nav-pill");
  const active = document.querySelector(".nav-groups .nav.active");
  const nav = document.querySelector(".nav-groups");
  if (!pill || !active || !nav) return;
  const box = active.getBoundingClientRect();
  pill.style.transform = `translateY(${box.top - nav.getBoundingClientRect().top}px)`;
  pill.style.height = `${box.height}px`;
}

function animateContent() {
  const c = el("content");
  if (!c || !c.animate) return;
  if (c._viewAnim) c._viewAnim.cancel();
  c._viewAnim = c.animate(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
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
