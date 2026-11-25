// Reel UI — home.js
async function boot() {
  await loadSettings();
  applyNowText();
  await loadCacheMeta();
  state.token = await invoke("get_token");
  if (state.token) await afterLogin();
  else showLogin();
  await refreshCacheIndex();
  setInterval(() => {
    if (!audio.paused) savePlayback();
  }, 15000);
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
  moveNavPill();
  el("search-box").classList.toggle("hidden", view !== "search");
  el("home-search-form").classList.toggle("hidden", view !== "home");
  el("refresh").classList.toggle("hidden", view === "home" || view === "settings" || view === "search" || view === "artist" || view === "album");
  const titles = { home: "Главная", library: "Библиотека", search: "Поиск", playlists: "Плейлисты", cache: "Кэш", settings: "Настройки", artist: "Исполнитель", album: "Альбом" };
  el("view-title").textContent = titles[view] || view;
}

async function openView(view) {
  state.artistPage = null;
  state.albumPage = null;
  state.navStack.length = 0;
  setViewChrome(view);
  setTimeout(animateContent, 60);
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
  return `<div class="track ${isActive ? "active" : ""} ${t.disliked ? "disliked" : ""}" data-idx="${i}" data-key="${trackKey(t)}">
    <div class="idx">${i + 1}</div>
    ${coverBox(t.cover, t.title, "cover cover-sm")}
    <div>
      <div class="t-title">${trackTitleHtml(t)}${t.explicit ? '<span class="pill">E</span>' : ""}</div>
      <div class="t-sub">${artistLinksHtml(t)}${cached ? ' · <span style="color:var(--accent-2)">кэш</span>' : ""}</div>
    </div>
    <div class="t-time">${fmtTime(t.duration)}</div>
    <div class="t-actions">
      <button class="icon-btn ${inLib ? "on" : ""}" data-act="like" title="В библиотеку">${icon("heart")}</button>
      <button class="icon-btn ${t.disliked ? "on" : ""}" data-act="dislike" title="Дизлайк">${icon("dislike")}</button>
      <button class="icon-btn" data-act="cache" title="Кэш">${icon("download")}</button>
      <button class="icon-btn" data-act="copy" title="Ссылка">${icon("external")}</button>
    </div>
  </div>`;
}

function bindTracks(container, list) {
  bindInlineLinks(container);
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
        if (btn.dataset.act === "dislike") await toggleTrackDislike(t);
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

const PLAYLIST_GROUPS = [
  { key: "own", title: "Мои плейлисты", hint: "созданы тобой" },
  { key: "saved", title: "Сохранённые", hint: "чужие плейлисты, на которые ты подписан" },
  { key: "vk", title: "От VK", hint: "автоматические подборки" },
];

function playlistPhotoOf(p) {
  const photo = p.photo || {};
  const thumbs = p.thumbs || {};
  if (typeof photo === "string") return photo;
  return (
    photo.photo_600 ||
    photo.photo_300 ||
    thumbs.photo_600 ||
    thumbs.photo_300 ||
    p.photo_600 ||
    p.photo_300 ||
    ""
  );
}

function playlistKind(p, userId) {
  const id = Number(p.id);
  const owner = Number(p.owner_id);
  const uid = Number(userId);
  if (p.type === "generated" || id < 0) return "vk";
  if (Number.isFinite(uid) && owner === uid) return "own";
  return "saved";
}

function normalizePlaylist(p, userId) {
  const id = Number(p.id);
  const owner = Number(p.owner_id);
  const hasSection = typeof p.section_id === "string" && p.section_id.length > 0;
  return {
    raw: p,
    id,
    owner_id: owner,
    title: p.title || p.name || "Без названия",
    count: Number(p.count || p.size || p.num_audios || 0),
    kind: playlistKind(p, userId),
    sectionId: hasSection
      ? p.section_id
      : Number.isFinite(id) && Number.isFinite(owner)
        ? `playlist${owner}_${id}`
        : String(p.id),
    photo: playlistPhotoOf(p),
    description: p.description || p.subtitle || "",
  };
}

function normalizePlaylists(list, userId) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    if (!raw || raw.id === undefined || raw.id === null) continue;
    const p = normalizePlaylist(raw, userId);
    if (seen.has(p.sectionId)) continue;
    seen.add(p.sectionId);
    out.push(p);
  }
  const rank = { own: 0, saved: 1, vk: 2 };
  out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  return out;
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

async function loadSectionPage(sectionId, startFrom) {
  const res = await invoke("catalog_get_section", { sectionId, startFrom: startFrom || null });
  const section = res.section || {};
  const block = (section.blocks || []).find((b) => (b.audios_ids || []).length);
  return {
    tracks: orderedStrict((res.audios || []).map(normTrack), section.blocks || []),
    nextFrom: section.next_from || (block && block.next_from) || null,
  };
}

async function loadMyMusic(sectionId) {
  const seen = new Set();
  const tracks = [];
  let start = null;
  for (let page = 0; page < 50; page++) {
    const chunk = await loadSectionPage(sectionId, start);
    for (const t of chunk.tracks) {
      const key = trackKey(t);
      if (!seen.has(key)) {
        seen.add(key);
        tracks.push(t);
      }
    }
    if (!chunk.nextFrom || chunk.nextFrom === start || !chunk.tracks.length) break;
    start = chunk.nextFrom;
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
    if (audio.paused) { raf = 0; return; }
    if (now - last < 66) { raf = requestAnimationFrame(frame); return; }
    raf = requestAnimationFrame(frame);
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
  if (!canvas.__wavePlayBound) {
    canvas.__wavePlayBound = true;
    audio.addEventListener("play", () => {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    });
  }
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
  state.recentLoading = false;
  if (state.view === "home") renderHome();
}

async function renderHome() {
  const recent = (state.recent || []).slice(0, 12);
  const cards = recent.length
    ? recent
        .map((t, i) => `<div class="media-card" data-recent="${i}">
            ${coverBox(t.cover, t.title, "cover cover-md")}
            <button class="play-fab" data-act="play">${icon("play")}</button>
            <b>${esc(t.title)}</b><span>${esc(t.artist)}</span>
          </div>`)
        .join("")
    : `<div class="empty">Пока пусто — включи трек, он появится здесь</div>`;
  const featured = (state.playlists || []).slice(0, 3);
  el("content").innerHTML = `
    <div class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Персональное</div>
        <h1>Твоя <em class="wave-word">волна</em><br>не кончается</h1>
        <p>Собрана из твоей музыки и продолжается сама — трек за треком, без пауз и повторов.</p>
        <div class="hero-actions">
          <button class="btn btn-primary" id="wave-play">${icon("play")} Слушать волну</button>
          <button class="btn btn-ghost" data-view="library">Моя музыка</button>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true"><div class="hero-vinyl"></div><div class="hero-sleeve"><span>REEL · VOL. 01</span></div></div>
    </div>
    <div class="section-title">Недавно прослушанное <small>${state.recent.length} треков</small></div>
    <div class="cards-row">${cards}</div>
    <div class="section-title">Для тебя <small>подборки на сегодня</small></div>
    <div class="grid-cards">${featured.map((p, i) => playlistCard(p, i, true)).join("")}</div>`;
  el("wave-play").addEventListener("click", playWave);
  el("content").querySelectorAll(".media-card[data-recent]").forEach((card) => {
    const play = () => playList(state.recent, Number(card.dataset.recent));
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      play();
    });
    const fab = card.querySelector(".play-fab");
    if (fab) fab.addEventListener("click", (e) => { e.stopPropagation(); play(); });
  });
  bindPlaylists(el("content"), featured);
  ensureRecent();
}

const WAVE_CHUNK = 10;
const WAVE_DISCOVERY_EVERY = 8;

function shuffleCopy(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

async function ensureMyMusic(force = false) {
  if (!force && Array.isArray(state.myMusic) && state.myMusic.length) return state.myMusic;
  if (state.myMusicLoading) return state.myMusicLoading;
  state.myMusicLoading = (async () => {
    try {
      const res = await invoke("catalog_get_audio", { ownerId: state.user?.id ?? null });
      if (!state.user?.id) {
        const inferred = inferUid(res);
        if (inferred) state.user = { ...(state.user || {}), id: inferred };
      }
      const lib = librarySection((res.catalog && res.catalog.sections) || []);
      if (!lib) {
        state.myMusic = state.myMusic || [];
        return state.myMusic;
      }
      // Первая страница — чтобы волна стартовала сразу; остальное догружаем в фоне.
      const first = await loadSectionPage(lib.id, null);
      state.myMusic = first.tracks.slice();
      const pool = state.myMusic;
      (async () => {
        const seen = new Set(pool.map(trackKey));
        let start = first.nextFrom;
        for (let page = 0; page < 40 && start; page++) {
          const chunk = await loadSectionPage(lib.id, start);
          for (const track of chunk.tracks) {
            const key = trackKey(track);
            if (seen.has(key)) continue;
            seen.add(key);
            pool.push(track);
          }
          if (!chunk.tracks.length || chunk.nextFrom === start) break;
          start = chunk.nextFrom;
        }
      })().catch(() => {});
      return pool;
    } catch {
      state.myMusic = state.myMusic || [];
      return state.myMusic;
    } finally {
      state.myMusicLoading = null;
    }
  })();
  return state.myMusicLoading;
}

function takeFromLibrary(want, out, taken) {
  const w = state.wave;
  const pool = state.myMusic || [];
  if (!pool.length || want <= 0) return out;
  let guard = Math.max(8, want * 8);
  while (out.length < want && guard-- > 0) {
    if (!w.deck.length) {
      // В волне каждый трек должен встречаться один раз за всю сессию.
      w.deck = shuffleCopy(pool.filter((t) => !w.used.has(trackKey(t))));
      if (!w.deck.length) break;
    }
    const track = w.deck.pop();
    if (!track) break;
    const key = trackKey(track);
    if (w.used.has(key) || taken.has(key)) continue;
    w.used.add(key);
    w.libKeys.add(key);
    taken.add(key);
    out.push(track);
  }
  return out;
}

async function mixTracks(raw) {
  let list = raw.map(normTrack).filter((t) => t.url || t.hls);
  if (list.length || !raw.length) return list;
  // VK иногда отдаёт только id без ссылок — добираем их отдельным запросом,
  // иначе трек «играет» вхолостую и волна выглядит сломанной.
  try {
    const audios = raw.slice(0, 100).map((t) => `${t.owner_id}_${t.id}`);
    const res = await invoke("audio_by_id", { audios });
    const arr = Array.isArray(res) ? res : res.audios || res.items || [];
    list = arr.map(normTrack).filter((t) => t.url || t.hls);
  } catch {}
  return list;
}

async function takeFromMix(want, out, taken) {
  const w = state.wave;
  if (want <= 0 || w.mixExhausted) return out;
  try {
    const res = await invoke("stream_mix_audios", {
      count: Math.max(want * 2, 10),
      offset: w.mixOffset,
      mixId: w.mixId,
    });
    const list = await mixTracks(Array.isArray(res) ? res : res.audios || []);
    let added = 0;
    for (const track of list) {
      if (added >= want) break;
      const key = trackKey(track);
      if (w.used.has(key) || taken.has(key) || w.seenMix.has(key)) continue;
      w.seenMix.add(key);
      w.used.add(key);
      taken.add(key);
      out.push(track);
      added++;
    }
    if (list.length) w.mixOffset += list.length;
    if (!added) {
      w.mixDry = (w.mixDry || 0) + 1;
      if (!list.length || w.mixDry >= 2) w.mixExhausted = true;
    } else {
      w.mixDry = 0;
    }
  } catch {
    w.mixExhausted = true;
  }
  return out;
}

// Волна строится из «Моей музыки», а рекомендации VK подмешиваются редко —
// иначе подборка скатывается к тому, что и так играло недавно.
async function buildWaveChunk(size = WAVE_CHUNK) {
  const taken = new Set();
  const out = [];
  const hasLibrary = (state.myMusic || []).length > 0;
  const mixQuota = hasLibrary ? Math.max(1, Math.round(size / WAVE_DISCOVERY_EVERY)) : size;
  if (hasLibrary) takeFromLibrary(size - mixQuota, out, taken);
  if (out.length < size) await takeFromMix(size - out.length, out, taken);
  if (hasLibrary && out.length < size) takeFromLibrary(size - out.length, out, taken);
  return out;
}

async function ensureWaveMore(size = WAVE_CHUNK) {
  const w = state.wave;
  if (!w.active || w.extending) return 0;
  w.extending = true;
  try {
    const chunk = await buildWaveChunk(size);
    for (const track of chunk) state.queue.push(track);
    if (chunk.length) {
      schedulePlaybackSave();
      if (el("queue-modal")?.open) renderQueue();
    } else {
      w.active = false;
    }
    return chunk.length;
  } finally {
    w.extending = false;
  }
}

async function maybeExtendWave() {
  const w = state.wave;
  if (!w.active) return;
  if (state.queue.length - 1 - state.index > 2) return;
  await ensureWaveMore(WAVE_CHUNK);
}

async function playWave() {
  const button = el("wave-play");
  if (button) {
    button.disabled = true;
    button.textContent = "Собираю…";
  }
  try {
    if (state.accountReady) await state.accountReady;
    const library = await ensureMyMusic();
    const w = state.wave;
    w.active = true;
    w.extending = false;
    w.deck = [];
    w.used = new Set();
    w.libKeys = new Set();
    w.seenMix = new Set();
    w.mixOffset = 0;
    w.mixExhausted = false;
    w.mixDry = 0;
    const first = await buildWaveChunk(14);
    if (!first.length) {
      w.active = false;
      toast("Волна не собралась: нет треков ни в «Моей музыке», ни в рекомендациях");
      return;
    }
    if (state.shuffle) {
      state.shuffle = false;
      const shuffleButton = el("shuffle");
      if (shuffleButton) shuffleButton.classList.remove("on");
    }
    state.queue = first.slice();
    state.index = 0;
    playCurrent();
    toast(
      library.length
        ? "Моя волна из твоей музыки • дальше продолжится сама"
        : "Волна из рекомендаций VK • добавь треки в «Мою музыку»",
    );
    ensureWaveMore(WAVE_CHUNK);
  } catch (e) {
    state.wave.active = false;
    toast(String(e));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Слушать";
    }
  }
}
