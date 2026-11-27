// Reel UI — library.js
async function loadLibraryCatalog(force = false) {
  if (!force && state.catalog) return state.catalog;
  let res = {};
  let error = null;
  try {
    res = await invoke("catalog_get_audio", { ownerId: state.user?.id ?? null });
  } catch (e) {
    error = e;
  }
  if (!state.user?.id) {
    const inferred = inferUid(res);
    if (inferred) state.user = { ...(state.user || {}), id: inferred };
  }
  const lib = librarySection((res.catalog && res.catalog.sections) || []);
  // audio.getPlaylists отдаёт и «свои» плейлисты, и подписки — это надёжнее,
  // чем угадывать владельца по owner_id из catalog.getAudio.
  let extra = [];
  try {
    const own = await invoke("audio_playlists", { ownerId: state.user?.id ?? null, count: 100, offset: 0 });
    extra = (own && (own.items || own.playlists)) || [];
  } catch {}
  const merged = normalizePlaylists(res.playlists, state.user?.id);
  const seen = new Set(merged.map((p) => `${p.owner_id}_${p.id}`));
  for (const raw of extra) {
    const p = normalizePlaylist(raw, state.user?.id);
    const key = `${p.owner_id}_${p.id}`;
    if (seen.has(key)) {
      // У одной и той же подборки VK иногда отдаёт фото только в audio.getPlaylists.
      const existing = merged.find((x) => `${x.owner_id}_${x.id}` === key);
      if (existing && !existing.photo && p.photo) existing.photo = p.photo;
      continue;
    }
    seen.add(key);
    merged.push(p);
  }
  const rank = { own: 0, saved: 1, vk: 2 };
  merged.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  state.catalog = { res, lib, error };
  state.playlists = merged;
  if (error && !merged.length) throw error;
  return state.catalog;
}

async function loadLibrary(force = false) {
  state.loading = true;
  state.section = null;
  el("content").innerHTML = `<div class="empty">Загрузка…</div>`;
  await loadLocalTracks();

  let playlists = [];
  let music = [];
  let note = "";
  try {
    const { lib } = await loadLibraryCatalog(force);
    playlists = state.playlists || [];
    if (lib) {
      music = await loadMyMusic(lib.id);
      state.myMusic = music;
    } else {
      note = "VK не отдал раздел «Моя музыка». Попробуй обновить библиотеку.";
    }
  } catch (e) {
    note = vkHint(e);
    playlists = state.playlists || [];
    music = state.myMusic || [];
  }
  state.tracks = music;
  const preview = playlists.filter((p) => p.kind !== "vk").slice(0, 8);
  const ownCount = preview.filter((p) => p.kind === "own").length;
  const savedCount = preview.length - ownCount;

  let html = `<div class="page-head"><div><h1>Библиотека</h1><p>Твоя музыка и плейлисты из VK</p></div><button class="btn btn-ghost" data-view="playlists">Все плейлисты ${icon("forward")}</button></div>`;
  if (note) html += `<div class="notice"><div class="notice-text">${esc(note)}</div></div>`;
  if (preview.length) {
    const parts = [];
    if (ownCount) parts.push(`${ownCount} твоих`);
    if (savedCount) parts.push(`${savedCount} от исполнителей`);
    html += `<div class="section-title">Плейлисты <small>${parts.join(" · ")}</small></div>
      <div class="library-playlists">${preview.map((p, i) => playlistCard(p, i, true)).join("")}</div>`;
  }
  if (music.length)
    html += `<div class="section-title">Моя музыка <small>добавлено в VK · ${music.length}</small></div><div class="track-list">${music.map((t, i) => trackRow(t, i, music)).join("")}</div>`;
  else
    html += `<div class="section-title">Моя музыка <small>добавлено в VK</small></div><div class="empty">${icon("music")} В «Моей музыке» VK пока пусто.</div>`;
  if (state.local.length)
    html += `<div class="section-title">Локальные файлы <small>${state.local.length}</small></div><div class="track-list">${state.local.map((l, i) => localRow(l, i)).join("")}</div>`;
  el("content").innerHTML = html;
  bindTracks(el("content"), music);
  bindPlaylists(el("content"), preview);
  el("content").querySelectorAll("[data-li]").forEach((row) => {
    const i = Number(row.dataset.li);
    row.addEventListener("dblclick", () => playLocal(i));
    row.addEventListener("click", (e) => { if (e.target.closest("button")) return; playLocal(i); });
    const rm = row.querySelector("[data-lrm]");
    if (rm) rm.addEventListener("click", async (e) => {
      e.stopPropagation();
      await invoke("local_remove", { id: state.local[i].id });
      await loadLibrary(force);
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
    el("content").innerHTML = `<div class="empty" style="text-align:left;padding:0 0 12px">Ошибка раздела: ${esc(vkHint(e))}</div><div class="row"><button class="ghost" id="back-lib">← Библиотека</button></div>`;
    el("back-lib").addEventListener("click", () => openView("library"));
  }
}

function playLocal(i) {
  state.wave.active = false;
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
  el("home-search-input").value = q;
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
    el("content").innerHTML = `<div class="empty">Ошибка: ${esc(vkHint(e))}</div>`;
  }
}

function playlistCard(p, index, quick) {
  const meta = p.count ? `${p.count} треков` : "плейлист";
  const badge = p.kind === "saved" ? " · сохранён" : "";
  return `<div class="playlist-card" data-pi="${index}">
    ${coverBox(p.photo, p.title, "pcover")}
    <div class="pl-card-body">
      <div class="name">${esc(p.title)}</div>
      <div class="meta">${esc(meta)}${badge}</div>
    </div>
    ${quick ? `<button class="pl-quick" data-quick="${index}" title="Слушать плейлист" aria-label="Слушать плейлист">▶</button>` : ""}
  </div>`;
}

function playlistGrid(list, quick = true) {
  if (!list.length) return "";
  return `<div class="playlist-grid">${list.map((p, i) => playlistCard(p, i, quick)).join("")}</div>`;
}

function bindPlaylists(container, list) {
  container.querySelectorAll(".playlist-card[data-pi]").forEach((card) => {
    const playlist = list[Number(card.dataset.pi)];
    if (!playlist) return;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-quick]")) return;
      openPlaylist(playlist);
    });
  });
  container.querySelectorAll("[data-quick]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      const playlist = list[Number(button.dataset.quick)];
      if (playlist) await playWholePlaylist(playlist);
    });
  });
}

function renderPlaylistsPage() {
  const all = state.playlists || [];
  const filter = (state.playlistFilter || "").trim().toLowerCase();
  const matches = (p) => !filter || String(p.title).toLowerCase().includes(filter);
  const groups = PLAYLIST_GROUPS.map((group) => ({ ...group, items: all.filter((p) => p.kind === group.key) })).filter(
    (group) => group.items.length
  );
  const flat = [];
  let body = "";
  for (const group of groups) {
    const items = group.items.filter(matches);
    if (!items.length) continue;
    const cards = items
      .map((p) => {
        const index = flat.push(p) - 1;
        return playlistCard(p, index, true);
      })
      .join("");
    body += `<section class="pl-group">
      <div class="pl-group-head">
        <div class="pl-group-title">${esc(group.title)}</div>
        <span class="pl-group-count">${group.items.length}</span>
        <div class="pl-group-hint">${esc(group.hint)}</div>
      </div>
      <div class="playlist-grid">${cards}</div>
    </section>`;
  }
  if (!body) {
    body = all.length
      ? `<div class="empty">По запросу «${esc(state.playlistFilter)}» ничего не нашлось</div>`
      : `<div class="empty">Плейлистов пока нет — VK не отдал ни одного.</div>`;
  }
  const summary = filter ? `найдено ${flat.length} из ${all.length}` : `всего ${all.length}`;
  el("content").innerHTML = `
    <div class="page-head"><div><h1>Плейлисты</h1><p>Твои, сохранённые и от исполнителей</p></div><button class="btn btn-ghost" id="pl-reload">Обновить</button></div>
    <div class="pl-toolbar">
      <input id="pl-search" class="pl-search" placeholder="Поиск по плейлистам" value="${esc(state.playlistFilter || "")}" />
      <span class="pl-total">${esc(summary)}</span>
    </div>
    ${body || `<div class="empty">Плейлистов пока нет.</div>`}`;
  bindPlaylists(el("content"), flat);
  const search = el("pl-search");
  if (search) {
    search.addEventListener("input", () => {
      state.playlistFilter = search.value;
      const caret = search.selectionStart;
      renderPlaylistsPage();
      const again = el("pl-search");
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(caret, caret);
        } catch {}
      }
    });
  }
  const reload = el("pl-reload");
  if (reload) reload.addEventListener("click", () => loadPlaylists(true));
}

async function loadPlaylists(resetFilter = false) {
  el("content").innerHTML = `<div class="empty">Загрузка плейлистов…</div>`;
  try {
    await loadLibraryCatalog(true);
    if (resetFilter) state.playlistFilter = "";
    renderPlaylistsPage();
  } catch (e) {
    el("content").innerHTML =
      `<div class="page-head"><div><h1>Плейлисты</h1><p>Твои, сохранённые и от исполнителей</p></div></div>` +
      `<div class="notice"><div class="notice-title">Плейлисты недоступны</div><div class="notice-text">${esc(vkHint(e))}</div></div>` +
      `<div class="row" style="margin-top:12px"><button class="ghost" id="pl-retry">Повторить</button></div>`;
    const retry = el("pl-retry");
    if (retry) retry.addEventListener("click", () => loadPlaylists(resetFilter));
  }
}

function playlistPage(res) {
  const items = Array.isArray(res) ? res : res.items || res.audios || [];
  const total = Number((!Array.isArray(res) && res.count) || items.length);
  const tracks = items.map(normTrack);
  const offset = Number((!Array.isArray(res) && res.offset) || 0);
  const next = offset + items.length;
  return { tracks, total, nextOffset: items.length && next < total ? next : null };
}

function renderPlaylistView(playlist, page, append) {
  const keep = append && state.playlistSection && state.playlistSection.id === playlist.sectionId ? state.playlistSection.tracks : [];
  const seen = new Set(keep.map(trackKey));
  const tracks = keep.concat(page.tracks.filter((t) => !seen.has(trackKey(t))));
  state.playlistSection = { id: playlist.sectionId, playlist, tracks, nextOffset: page.nextOffset };
  const kindLabel = playlist.kind === "own" ? "Мой плейлист" : playlist.kind === "vk" ? "Подборка VK" : "Сохранённый плейлист";
  const count = page.nextOffset ? `${tracks.length}+` : String(tracks.length);
  const declared = page.total > tracks.length ? ` · заявлено ${page.total}` : "";
  el("content").innerHTML =
    `<button class="btn btn-ghost" id="back-pl" style="margin-bottom:24px">${icon("back")} Плейлисты</button>
    <div class="detail-hero">
      ${coverBox(playlist.photo, playlist.title, "cover cover-lg")}
      <div class="info">
        <div class="detail-kicker">${esc(kindLabel)}</div>
        <h1 class="detail-name">${esc(playlist.title)}</h1>
        <div class="detail-meta">${count} треков${declared}${playlist.description ? ` · ${esc(playlist.description)}` : ""}</div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="pl-play">${icon("play")} Слушать</button>
          <button class="btn btn-ghost" id="pl-shuffle">${icon("shuffle")} Перемешать</button>
          <button class="btn btn-ghost" id="pl-refresh">Обновить</button>
        </div>
      </div>
    </div>` +
    (tracks.length
      ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, tracks)).join("")}</div>`
      : `<div class="empty">В этом плейлисте пока нет треков</div>`) +
    (page.nextOffset ? `<div class="row" style="margin-top:16px"><button class="btn btn-ghost" id="pl-more">Показать ещё</button></div>` : "");
  bindTracks(el("content"), tracks);
  el("back-pl").addEventListener("click", () => openView("playlists"));
  el("pl-play").addEventListener("click", () => playWholePlaylist(playlist, false));
  el("pl-shuffle").addEventListener("click", () => playWholePlaylist(playlist, true));
  el("pl-refresh").addEventListener("click", () => {
    state.playlistCache.delete(playlist.sectionId);
    state.playlistSection = null;
    openPlaylist(playlist, true);
  });
  const more = el("pl-more");
  if (more)
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = "Загрузка…";
      try {
        const next = await fetchPlaylistSection(playlist, state.playlistSection.nextOffset);
        renderPlaylistView(playlist, playlistPage(next), true);
      } catch (e) {
        more.disabled = false;
        more.textContent = `Ошибка: ${e}`;
      }
    });
}

async function fetchPlaylistSection(playlist, offset = 0) {
  if (!Number.isFinite(playlist.owner_id) || !Number.isFinite(playlist.id)) {
    throw new Error("Плейлист недоступен");
  }
  return invoke("playlist_tracks", {
    ownerId: playlist.owner_id,
    playlistId: playlist.id,
    accessKey: playlist.access_key || null,
    count: 100,
    offset: offset || 0,
  });
}

async function openPlaylist(playlist, fromBack = false) {
  if (!playlist) return;
  const req = ++state.playlistOpenReq;
  if (!fromBack) state.navStack.push(currentNav());
  setViewChrome("playlists");
  el("content").innerHTML = `<div class="empty">Загрузка плейлиста…</div>`;
  try {
    const res = await fetchPlaylistSection(playlist, 0);
    if (req !== state.playlistOpenReq || state.view !== "playlists") return;
    renderPlaylistView(playlist, playlistPage(res), false);
  } catch (e) {
    if (req !== state.playlistOpenReq || state.view !== "playlists") return;
    el("content").innerHTML =
      `<div class="row"><button class="ghost" id="back-pl">← Плейлисты</button></div>` +
      `<div class="notice"><div class="notice-title">Плейлист не открылся</div><div class="notice-text">${esc(vkHint(e))}</div><button class="ghost" id="pl-retry-open" style="margin-top:10px">Повторить</button></div>`;
    el("back-pl").addEventListener("click", () => openView("playlists"));
    el("pl-retry-open").addEventListener("click", () => openPlaylist(playlist, true));
  }
}


function pickArtistPhoto(artist) {
  const photos = Array.isArray(artist && artist.photo) ? artist.photo : [];
  return photos.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || "";
}

function currentNav() {
  if (state.artistPage) return { view: "artist", id: state.artistPage.id, name: state.artistPage.name };
  if (state.albumPage) {
    return {
      view: "album",
      ownerId: state.albumPage.ownerId,
      albumId: state.albumPage.albumId,
      title: state.albumPage.title,
      cover: state.albumPage.cover,
    };
  }
  return { view: state.view || "home" };
}

function goBack() {
  const prev = state.navStack.pop();
  if (!prev) return openView("home");
  if (prev.view === "artist") return openArtist(prev.id, prev.name, true);
  if (prev.view === "album") return openAlbum(prev.ownerId, prev.albumId, prev.title, prev.cover, true);
  return openView(prev.view || "home");
}

async function openArtist(id, name, fromBack = false) {
  if (!id) {
    if (name) startSearch(name);
    return;
  }
  if (!fromBack) state.navStack.push(currentNav());
  state.albumPage = null;
  setViewChrome("artist");
  el("view-title").textContent = name || "Исполнитель";
  el("content").innerHTML = `<div class="empty">Загрузка исполнителя…</div>`;
  try {
    const res = await invoke("catalog_artist", { artistId: String(id) });
    const tracks = (res.audios || []).map(normTrack);
    const artist = (res.artists || [])[0] || {};
    state.artistPage = {
      id: String(id),
      name: artist.name || name || "Исполнитель",
      photo: pickArtistPhoto(artist),
      tracks,
    };
    el("view-title").textContent = state.artistPage.name;
    renderArtistPage();
  } catch (e) {
    el("content").innerHTML =
      `<div class="row"><button class="ghost" id="artist-back">← Назад</button></div>` +
      `<div class="notice"><div class="notice-title">Исполнитель не открылся</div><div class="notice-text">${esc(vkHint(e))}</div></div>`;
    el("artist-back").addEventListener("click", goBack);
  }
}

function renderArtistPage() {
  const page = state.artistPage;
  if (!page) return;
  const tracks = page.tracks;
  const letter = esc(((page.name || "?").trim().charAt(0) || "?").toUpperCase());
  const photo = page.photo
    ? `<div class="pl-cover artist-photo"><img src="${esc(page.photo)}" alt="" /></div>`
    : `<div class="pl-cover artist-photo" data-letter="${letter}">${letter}</div>`;
  el("content").innerHTML =
    `<button class="btn btn-ghost" id="artist-back" style="margin-bottom:24px">${icon("back")} Назад</button>
    <div class="detail-hero artist-hero">
      ${photo}
      <div class="info">
        <div class="detail-kicker">Исполнитель</div>
        <h1 class="detail-name">${esc(page.name)}</h1>
        <div class="detail-meta">${tracks.length} треков</div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="artist-play" ${tracks.length ? "" : "disabled"}>${icon("play")} Слушать</button>
          <button class="btn btn-ghost" id="artist-shuffle" ${tracks.length ? "" : "disabled"}>${icon("shuffle")} Перемешать</button>
        </div>
      </div>
    </div>` +
    (tracks.length
      ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, tracks)).join("")}</div>`
      : `<div class="empty">У исполнителя пока нет треков</div>`);
  bindTracks(el("content"), tracks);
  el("artist-back").addEventListener("click", goBack);
  if (tracks.length) {
    el("artist-play").addEventListener("click", () => playList(tracks, 0));
    el("artist-shuffle").addEventListener("click", () => playList(shuffleCopy(tracks), 0));
  }
}

async function openAlbum(ownerId, albumId, title, cover, fromBack = false) {
  const owner = Number(ownerId);
  const album = Number(albumId);
  if (!Number.isFinite(owner) || !Number.isFinite(album)) return;
  if (!fromBack) state.navStack.push(currentNav());
  state.artistPage = null;
  setViewChrome("album");
  el("view-title").textContent = title || "Альбом";
  el("content").innerHTML = `<div class="empty">Загрузка альбома…</div>`;
  try {
    const res = await invoke("audio_album", { ownerId: owner, albumId: album, count: 300, offset: 0 });
    const items = Array.isArray(res) ? res : res.items || [];
    const tracks = items.map(normTrack);
    const total = Number((res && res.count) || tracks.length);
    state.albumPage = {
      ownerId: owner,
      albumId: album,
      title: title || (tracks[0] && tracks[0].album && tracks[0].album.title) || "Альбом",
      cover: cover || (tracks[0] && tracks[0].cover) || "",
      tracks,
      total,
    };
    el("view-title").textContent = state.albumPage.title;
    renderAlbumPage();
  } catch (e) {
    el("content").innerHTML =
      `<div class="row"><button class="ghost" id="album-back">← Назад</button></div>` +
      `<div class="notice"><div class="notice-title">Альбом не открылся</div><div class="notice-text">${esc(vkHint(e))}</div></div>`;
    el("album-back").addEventListener("click", goBack);
  }
}

function renderAlbumPage() {
  const page = state.albumPage;
  if (!page) return;
  const tracks = page.tracks;
  const letter = esc(((page.title || "?").trim().charAt(0) || "?").toUpperCase());
  const cover = page.cover
    ? `<div class="pl-cover"><img src="${esc(page.cover)}" alt="" /></div>`
    : `<div class="pl-cover" data-letter="${letter}">${letter}</div>`;
  const artist = tracks[0] ? artistLinksHtml(tracks[0]) : "";
  el("content").innerHTML =
    `<button class="btn btn-ghost" id="album-back" style="margin-bottom:24px">${icon("back")} Назад</button>
    <div class="detail-hero">
      ${cover}
      <div class="info">
        <div class="detail-kicker">Альбом</div>
        <h1 class="detail-name">${esc(page.title)}</h1>
        <div class="detail-meta">${artist}${artist ? " · " : ""}${tracks.length}${page.total > tracks.length ? ` из ${page.total}` : ""} треков</div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="album-play" ${tracks.length ? "" : "disabled"}>${icon("play")} Слушать</button>
          <button class="btn btn-ghost" id="album-shuffle" ${tracks.length ? "" : "disabled"}>${icon("shuffle")} Перемешать</button>
        </div>
      </div>
    </div>` +
    (tracks.length
      ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, tracks)).join("")}</div>`
      : `<div class="empty">В альбоме пока нет треков</div>`) +
    (tracks.length < page.total ? `<div class="row" style="margin-top:16px"><button class="btn btn-ghost" id="album-more">Показать ещё</button></div>` : "");
  bindTracks(el("content"), tracks);
  el("album-back").addEventListener("click", goBack);
  if (tracks.length) {
    el("album-play").addEventListener("click", () => playList(tracks, 0));
    el("album-shuffle").addEventListener("click", () => playList(shuffleCopy(tracks), 0));
  }
  const more = el("album-more");
  if (more) {
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = "Загрузка…";
      try {
        const res = await invoke("audio_album", {
          ownerId: page.ownerId,
          albumId: page.albumId,
          count: 300,
          offset: page.tracks.length,
        });
        const items = Array.isArray(res) ? res : res.items || [];
        const chunk = items.map(normTrack);
        const seen = new Set(page.tracks.map(trackKey));
        const added = chunk.filter((t) => !seen.has(trackKey(t)));
        page.tracks.push(...added);
        page.total = Number((res && res.count) || page.total);
        if (!added.length) page.total = page.tracks.length;
        renderAlbumPage();
      } catch (e) {
        more.disabled = false;
        more.textContent = `Ошибка: ${e}`;
      }
    });
  }
}

async function loadAllPlaylistTracks(playlist) {
  const cached = state.playlistCache.get(playlist.sectionId);
  if (cached && cached.length) return cached;
  const seen = new Set();
  const tracks = [];
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const chunk = playlistPage(await fetchPlaylistSection(playlist, offset));
    for (const track of chunk.tracks) {
      const key = trackKey(track);
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(track);
    }
    if (chunk.nextOffset === null || !chunk.tracks.length) break;
    offset = chunk.nextOffset;
  }
  state.playlistCache.set(playlist.sectionId, tracks);
  return tracks;
}

async function playWholePlaylist(playlist, shuffle = false) {
  toast("Загружаю плейлист…");
  try {
    const tracks = await loadAllPlaylistTracks(playlist);
    if (!tracks.length) return toast("В плейлисте нет треков");
    const list = shuffle ? shuffleCopy(tracks) : tracks.slice();
    playList(list, 0);
    toast(`${shuffle ? "Перемешано" : "Играет плейлист"} • ${list.length} треков`);
  } catch (e) {
    toast(`Плейлист не загрузился: ${e}`);
  }
}
