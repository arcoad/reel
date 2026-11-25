// Reel UI — player.js
const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [7, 6, 4, 2, 0, -1, -2, -3, -3, -4],
  vocal: [-2, -1, 1, 3, 5, 4, 2, 0, -1, -2],
  rock: [4, 3, 1, -1, -2, 0, 2, 3, 4, 5],
};
const eq = { ctx: null, source: null, filters: [], gains: [...EQ_PRESETS.flat], preset: "flat", ready: false };

function eqProxyUrl(url) {
  const bytes = new TextEncoder().encode(url);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `http://reelstream.localhost/${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function eqSource(track, cached, key) {
  if (track.local_id) return `http://reelfile.localhost/${track.local_id}`;
  if (cached) return mediaUrl(key);
  if (track.url) return eqProxyUrl(track.url);
  return "";
}

function applyEqGains() {
  if (!eq.ready) return;
  eq.filters.forEach((filter, i) => filter.gain.setTargetAtTime(eq.gains[i], eq.ctx.currentTime, 0.02));
}

async function ensureEqualizer() {
  if (eq.ready) return true;
  const track = state.queue[state.index];
  if (!track) return false;
  const key = trackKey(track);
  const cached = !track.local_id && state.cache.has(key);
  const nextSrc = eqSource(track, cached, key);
  if (!nextSrc) {
    toast("EQ недоступен для HLS-трека без прямого URL");
    return false;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    toast("Web Audio API недоступен");
    return false;
  }
  try {
    eq.ctx = new Ctx();
    audio.crossOrigin = "anonymous";
    eq.source = eq.ctx.createMediaElementSource(audio);
    let node = eq.source;
    eq.filters = EQ_BANDS.map((freq) => {
      const filter = eq.ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = freq;
      filter.Q.value = 1.1;
      filter.gain.value = eq.gains[EQ_BANDS.indexOf(freq)];
      node.connect(filter);
      node = filter;
      return filter;
    });
    node.connect(eq.ctx.destination);
    eq.ready = true;
    const wasPlaying = !audio.paused;
    const position = audio.currentTime;
    stopHls();
    audio.src = nextSrc;
    audio.load();
    audio.addEventListener(
      "loadedmetadata",
      () => {
        if (position > 0) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 1));
        if (wasPlaying) audio.play().catch(() => {});
      },
      { once: true },
    );
    await eq.ctx.resume();
    applyEqGains();
    return true;
  } catch (e) {
    eq.ready = false;
    toast(`EQ не включился: ${e}`);
    return false;
  }
}

function renderEq() {
  el("eq-bands").innerHTML = EQ_BANDS.map((freq, i) => {
    const label = freq >= 1000 ? `${freq / 1000}k` : String(freq);
    return `<div class="eq-band"><input type="range" min="-12" max="12" step="1" value="${eq.gains[i]}" data-eq="${i}" aria-label="${label} Hz" /><label>${label}</label></div>`;
  }).join("");
  el("eq-bands").querySelectorAll("[data-eq]").forEach((input) => {
    input.addEventListener("input", async () => {
      const index = Number(input.dataset.eq);
      eq.gains[index] = Number(input.value);
      eq.preset = "custom";
      if (!eq.ready && !(await ensureEqualizer())) return;
      applyEqGains();
    });
  });
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.classList.toggle("on", button.dataset.preset === eq.preset);
  });
}

async function applyPreset(name) {
  eq.preset = EQ_PRESETS[name] ? name : "flat";
  eq.gains = [...EQ_PRESETS[eq.preset]];
  renderEq();
  if (!eq.ready && !(await ensureEqualizer())) return;
  applyEqGains();
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
  el("now-title").innerHTML = trackTitleHtml(track);
  el("now-artist").innerHTML = artistLinksHtml(track);
  bindInlineLinks(el("now-title"));
  bindInlineLinks(el("now-artist"));
  const cover = el("now-cover");
  cover.src = track.cover || "";
  cover.style.visibility = track.cover ? "visible" : "hidden";
  el("now-bg").style.backgroundImage = track.cover ? `url("${track.cover}")` : "none";
  el("now-cur").textContent = fmtTime(audio.currentTime);
  el("now-dur").textContent = fmtTime(audio.duration || track.duration);
  el("now-seek").value = audio.duration ? String(Math.round((audio.currentTime / audio.duration) * 1000)) : "0";
  updateNowPlayIcon();
}

const lyricsState = { timed: false, times: [], lines: [], active: -1, raf: 0, key: "" };

function parseLyricsText(raw) {
  const rows = [];
  let timed = false;
  for (const rawLine of String(raw || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const content = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!content) continue;
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length) {
      timed = true;
      for (const stamp of stamps) {
        const frac = stamp[3] ? Number(stamp[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
        rows.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + frac, text: content });
      }
    } else {
      rows.push({ time: null, text: content });
    }
  }
  if (!timed) return { timed: false, lines: rows.map((r) => r.text), times: [] };
  const sorted = rows.filter((r) => r.time !== null).sort((a, b) => a.time - b.time);
  return { timed: true, lines: sorted.map((r) => r.text), times: sorted.map((r) => r.time) };
}

function stopLyricsSync() {
  if (lyricsState.raf) cancelAnimationFrame(lyricsState.raf);
  lyricsState.raf = 0;
}

function focusLyric(index) {
  if (index === lyricsState.active) return;
  lyricsState.active = index;
  const box = el("now-lyrics");
  const track = box.querySelector(".lyrics-track");
  if (!track) return;
  [...track.children].forEach((line, i) => line.classList.toggle("active", i === index));
  const line = track.children[index];
  if (!line) return;
  const offset = line.offsetTop + line.offsetHeight / 2 - box.clientHeight / 2;
  track.style.transform = `translateY(${-offset}px)`;
}

function syncLyrics() {
  if (!lyricsState.timed || !lyricsState.times.length) return;
  const t = audio.currentTime;
  let index = 0;
  for (let i = 0; i < lyricsState.times.length; i++) {
    if (lyricsState.times[i] <= t + 0.08) index = i;
    else break;
  }
  focusLyric(index);
  const track = el("now-lyrics").querySelector(".lyrics-track");
  const line = track && track.children[index];
  if (!line) return;
  const start = lyricsState.times[index];
  const end = lyricsState.times[index + 1] || Math.min(audio.duration || start + 4, start + 5);
  const progress = end > start ? Math.max(0, Math.min(1, (t - start) / (end - start))) : 1;
  line.style.setProperty("--fill", `${(progress * 100).toFixed(1)}%`);
}

function startLyricsSync() {
  stopLyricsSync();
  if (!lyricsState.timed) return;
  const tick = (now) => {
    if (el("now-view").classList.contains("hidden")) { lyricsState.raf = 0; return; }
    if (now - (lyricsState.last || 0) < 66) { lyricsState.raf = requestAnimationFrame(tick); return; }
    lyricsState.last = now;
    syncLyrics();
    lyricsState.raf = requestAnimationFrame(tick);
  };
  lyricsState.raf = requestAnimationFrame(tick);
}

function renderLyrics(text) {
  const box = el("now-lyrics");
  const parsed = parseLyricsText(text);
  lyricsState.timed = parsed.timed;
  lyricsState.times = parsed.times;
  lyricsState.lines = parsed.lines;
  lyricsState.active = -1;
  box.classList.toggle("lyrics-timed", parsed.timed);
  box.innerHTML = "";
  if (!parsed.lines.length) return false;
  const track = document.createElement("div");
  track.className = "lyrics-track";
  for (const line of parsed.lines) {
    const node = document.createElement("div");
    node.className = "lyrics-line";
    node.textContent = line;
    track.appendChild(node);
  }
  box.appendChild(track);
  if (parsed.timed) {
    syncLyrics();
    startLyricsSync();
  }
  return true;
}

async function loadNowLyrics() {
  const track = state.queue[state.index];
  if (!track) return;
  const view = el("now-view");
  const key = trackKey(track);
  stopLyricsSync();
  lyricsState.key = key;
  view.classList.remove("no-lyrics");
  const box = el("now-lyrics");
  const cached = state.lyricsCache.get(key);
  if (cached !== undefined) {
    if (cached) {
      renderLyrics(cached);
      view.classList.remove("no-lyrics");
    } else {
      box.innerHTML = '<div class="lyrics-line active">Текст не найден</div>';
      view.classList.add("no-lyrics");
    }
    return;
  }
  box.innerHTML = '<div class="lyrics-line active">Загрузка текста…</div>';
  let text = "";
  // VK-текст приходит из того же API и обычно быстрый — пробуем его первым.
  if (track.lyrics_id) {
    try {
      const res = await invoke("lyrics", { lyricsId: Number(track.lyrics_id) });
      text = (res && res.text) || "";
    } catch {}
  }
  if (!text.trim()) {
    // Внешние провайдеры могут висеть: не держим пользователя на «Загрузка…».
    text =
      (await Promise.race([
        invoke("external_lyrics", { artist: track.artist, title: track.title, duration: track.duration || null }).catch(() => ""),
        new Promise((resolve) => setTimeout(() => resolve(""), 4000)),
      ])) || "";
  }
  const current = state.queue[state.index];
  if (!current || trackKey(current) !== key) return;
  state.lyricsCache.set(key, text.trim() ? text : "");
  if (text.trim() && renderLyrics(text)) {
    view.classList.remove("no-lyrics");
  } else {
    box.innerHTML = '<div class="lyrics-line active">Текст не найден</div>';
    view.classList.add("no-lyrics");
  }
}

function nowTextHidden() {
  return state.settings.now_hide_text === "1";
}

function applyNowText() {
  const view = el("now-view");
  if (!view) return;
  const hidden = nowTextHidden();
  view.classList.toggle("hide-text", hidden);
  const btn = el("now-text-toggle");
  if (btn) {
    btn.classList.toggle("on", hidden);
    btn.title = hidden ? "Показать текст песни" : "Скрыть текст песни";
    const label = btn.querySelector("span");
    if (label) label.textContent = hidden ? "Показать текст" : "Текст";
  }
}

async function toggleNowText() {
  await setSetting("now_hide_text", nowTextHidden() ? "0" : "1");
  applyNowText();
}

function openNowView() {
  if (!state.queue[state.index]) return;
  el("now-view").classList.remove("hidden");
  applyNowText();
  renderNowView();
  loadNowLyrics();
}

function closeNowView() {
  stopLyricsSync();
  el("now-view").classList.add("hidden");
}

function stopHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function displayTrack(t) {
  el("np-title").innerHTML = trackTitleHtml(t);
  el("np-artist").innerHTML = artistLinksHtml(t);
  bindInlineLinks(el("np-title"));
  bindInlineLinks(el("np-artist"));
  el("cover").src = t.cover || "";
  el("cover").style.visibility = t.cover ? "visible" : "hidden";
  el("cur").textContent = "0:00";
  el("dur").textContent = fmtTime(t.duration);
  el("seek").value = "0";
  paintRange(el("seek"));
  const liked = state.libraryKeys.has(trackKey(t));
  el("like").classList.toggle("on", liked);
  el("like").setAttribute("aria-pressed", String(liked));
  const disliked = !!t.disliked;
  el("dislike").classList.toggle("on", disliked);
  el("dislike").setAttribute("aria-pressed", String(disliked));
}

function playbackSnapshot() {
  // Волна бесконечная: в снапшот кладём только окно вокруг текущего трека.
  const LIMIT = 120;
  let queue = state.queue;
  let index = state.index;
  if (queue.length > LIMIT) {
    const start = Math.max(0, Math.min(index - 40, queue.length - LIMIT));
    queue = queue.slice(start, start + LIMIT);
    index = Math.max(0, index - start);
  }
  return {
    queue,
    index,
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

let restartAttempts = 0;
let restartTimer = 0;
let lastSwitchAt = 0;

function playCurrent(resume = 0) {
  const t = state.queue[state.index];
  if (!t) return;
  const key = trackKey(t);
  const cached = !t.local_id && state.cache.has(key);
  restartAttempts = 0;
  lastSwitchAt = Date.now();
  clearTimeout(restartTimer);
  stopHls();
  const eqSrc = eq.ready ? eqSource(t, cached, key) : "";
  const src = eqSrc || (t.local_id ? `http://reelfile.localhost/${t.local_id}` : cached ? mediaUrl(key) : t.url);
  const hlsUrl = eq.ready ? "" : t.local_id || cached ? "" : t.hls;
  if (eq.ready && !eqSrc) toast("Для этого HLS-трека EQ недоступен");
  const resumeAt = Math.max(0, Number(resume) || 0);
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
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        state.hls.recoverMediaError();
        return;
      }
      // Фатальная ошибка HLS: сразу падаем на прямой MP3, не ждём повторов.
      const at = audio.currentTime || 0;
      stopHls();
      if (!src || src.includes(".m3u8")) return;
      audio.src = src;
      const restore = () => {
        if (at > 0 && audio.duration) audio.currentTime = Math.min(at, Math.max(0, audio.duration - 0.5));
      };
      if (audio.readyState >= 1) restore();
      else audio.addEventListener("loadedmetadata", restore, { once: true });
      audio.play().catch(() => {});
    });
  } else {
    audio.src = src || hlsUrl;
    audio.play().catch((e) => console.warn("play failed", e));
  }
  if (resumeAt > 0) {
    const apply = () => {
      if (audio.duration) audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 1));
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener("loadedmetadata", apply, { once: true });
  }
  renderActiveRow();
  schedulePlaybackSave();
}

// Короткий автоповтор того же трека после обрыва сети/ошибки потока.
// Не срабатывает на переключении треков и на обычном abort — только на реальной ошибке.
function restartCurrent(reason = "") {
  const t = state.queue[state.index];
  if (!t || !audio.src && !state.hls) return;
  if (Date.now() - lastSwitchAt < 1500) return;
  if (audio.error && audio.error.code === 1) return;
  if (restartAttempts >= 2) {
    restartAttempts = 0;
    return;
  }
  const at = audio.currentTime || 0;
  const attempt = ++restartAttempts;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (state.queue[state.index] !== t) {
      restartAttempts = 0;
      return;
    }
    const key = trackKey(t);
    // На повторе не доверяем кэшу: файл мог исчезнуть с диска.
    const cached = attempt === 1 && !t.local_id && state.cache.has(key);
    const hlsSource = t.hls || (t.url && t.url.includes(".m3u8") ? t.url : "");
    // VK иногда отдаёт испорченный MP3 с нового CDN — заранее просим свежую ссылку.
    // Она применится со второй попытки, не задерживая первую.
    if (attempt >= 2 && !t.local_id && !cached) {
      invoke("audio_by_id", { audios: [`${t.owner_id}_${t.id}`] })
        .then((res) => {
          const arr = Array.isArray(res) ? res : res.audios || res.items || [];
          const fresh = arr[0] && normTrack(arr[0]);
          if (fresh && fresh.id === t.id && fresh.owner_id === t.owner_id) {
            if (fresh.url) t.url = fresh.url;
            if (fresh.hls) t.hls = fresh.hls;
          }
        })
        .catch(() => {});
    }
    stopHls();
    const useHls = attempt === 1 && !!(hlsSource && !t.local_id && !cached && window.Hls && window.Hls.isSupported());
    const seekBack = () => {
      if (at > 0 && audio.duration) audio.currentTime = Math.min(at, Math.max(0, audio.duration - 0.5));
    };
    if (useHls) {
      state.hls = new Hls({ enableWorker: true });
      state.hls.loadSource(hlsSource);
      state.hls.attachMedia(audio);
      state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        seekBack();
        audio.play().catch(() => {});
        restartAttempts = 0;
      });
      state.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          state.hls.recoverMediaError();
          return;
        }
        const fallback = t.url;
        stopHls();
        if (!fallback || fallback.includes(".m3u8")) return;
        audio.src = fallback;
        audio.play().then(() => { restartAttempts = 0; }).catch(() => {});
      });
    } else {
      const src = t.local_id
        ? `http://reelfile.localhost/${t.local_id}`
        : cached
          ? mediaUrl(key)
          : t.url;
      // WebView2 не умеет m3u8 напрямую — такой вариант должен идти через HLS.js.
      if (!src || src.includes(".m3u8")) {
        restartAttempts = 0;
        return;
      }
      audio.src = src;
      if (audio.readyState >= 1) seekBack();
      else audio.addEventListener("loadedmetadata", seekBack, { once: true });
      audio.play().then(() => { restartAttempts = 0; }).catch(() => { restartCurrent("src"); });
    }
  }, attempt === 1 ? 150 : 300);
}

function renderActiveRow() {
  const current = state.queue[state.index];
  const key = current ? trackKey(current) : "";
  document.querySelectorAll(".track[data-key]").forEach((row) => {
    row.classList.toggle("active", !!key && row.dataset.key === key);
  });
}

function playList(list, idx) {
  state.wave.active = false;
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

async function next(auto = false) {
  await maybeExtendWave();
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
