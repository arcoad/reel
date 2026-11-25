// Reel UI — tracks.js
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

function eachTrackList() {
  const lists = [state.queue, state.tracks, state.myMusic, state.recent];
  if (state.artistPage) lists.push(state.artistPage.tracks);
  if (state.albumPage) lists.push(state.albumPage.tracks);
  for (const list of state.playlistCache.values()) lists.push(list);
  return lists;
}

function updateDislikeDom(key, value) {
  document.querySelectorAll(".track[data-key]").forEach((row) => {
    if (row.dataset.key !== key) return;
    row.classList.toggle("disliked", value);
    const btn = row.querySelector('button[data-act="dislike"]');
    if (btn) {
      btn.classList.toggle("on", value);
      btn.title = value ? "Убрать дизлайк" : "Дизлайк";
    }
  });
  const cur = state.queue[state.index];
  if (cur && trackKey(cur) === key) {
    el("dislike").classList.toggle("on", value);
    el("dislike").setAttribute("aria-pressed", String(value));
  }
}

function applyDisliked(key, value) {
  for (const list of eachTrackList()) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (t && trackKey(t) === key) t.disliked = value;
    }
  }
  updateDislikeDom(key, value);
  renderActiveRow();
}

async function setTrackDisliked(t, value) {
  if (!t || t.local_id) return false;
  try {
    await invoke("audio_dislike", { audioId: t.id, ownerId: t.owner_id, dislike: value });
    applyDisliked(trackKey(t), value);
    return true;
  } catch (e) {
    toast(`Не удалось: ${e}`);
    return false;
  }
}

async function toggleTrackDislike(t) {
  if (!t) return;
  const next = !t.disliked;
  if (await setTrackDisliked(t, next)) toast(next ? "Дизлайк поставлен" : "Дизлайк убран");
}

async function togglePlayerDislike() {
  const t = state.queue[state.index];
  if (!t) return;
  await toggleTrackDislike(t);
}

async function cacheTrack(t) {
  if (t.hls && t.url.includes(".m3u8")) return alert("HLS-поток нельзя кэшировать как файл.");
  if (!t.url) return alert("У трека нет прямого URL (только HLS) — кэш недоступен.");
  const key = trackKey(t);
  for (let attempt = 0; attempt < 2; attempt++) {
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
      return;
    } catch (e) {
      if (attempt === 0) {
        toast("Кэш не удался, пробую свежую ссылку…");
        try {
          const res = await invoke("audio_by_id", { audios: [`${t.owner_id}_${t.id}`] });
          const arr = Array.isArray(res) ? res : res.audios || res.items || [];
          const fresh = arr[0] && normTrack(arr[0]);
          if (fresh && fresh.url && fresh.id === t.id && fresh.owner_id === t.owner_id) {
            t.url = fresh.url;
            continue;
          }
        } catch {}
      }
      toast(`Ошибка кэширования: ${e}`);
      return;
    }
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
    `<div class="page-head"><div><h1>Кэш</h1><p>Треки доступны без интернета</p></div><button class="btn btn-ghost" id="cache-clear">${icon("trash")} Очистить</button></div>` +
    `<div class="section-title">Занято <small class="mono">${(total / 1048576).toFixed(1)} MB · ${list.length} треков</small></div>` +
    (list.length
      ? `<div class="track-list">${list
          .map((x, i) => `<div class="track" data-ci="${i}"><div class="idx">${i + 1}</div><div><div class="t-title">${esc(x.track.title)}</div><div class="t-sub">${esc(x.track.artist)} · ${(x.size / 1048576).toFixed(1)} MB</div></div><div class="t-time">${fmtTime(x.track.duration)}</div><div class="t-actions"><button class="icon-btn" data-del="${i}" title="Удалить">${icon("trash")}</button></div></div>`)
          .join("")}</div>`
      : `<div class="empty">${icon("download")} Пусто. Нажми «Кэш» у трека в библиотеке.</div>`);
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
