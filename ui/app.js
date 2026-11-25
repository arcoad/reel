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
  el("top-avatar").addEventListener("click", (e) => {
    e.stopPropagation();
    el("account-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".account-wrap")) el("account-menu").classList.add("hidden");
  });
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
    if (!audio.src && !state.hls) {
      const at = state.resumePosition;
      state.resumePosition = 0;
      playCurrent(at);
      return;
    }
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
  el("dislike").addEventListener("click", togglePlayerDislike);
  el("mute").addEventListener("click", () => {
    audio.muted = !audio.muted;
    updateMuteIcon();
  });
  updateMuteIcon();

  el("queue-btn").addEventListener("click", () => {
    renderQueue();
    el("queue-modal").showModal();
  });
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
  audio.addEventListener("error", () => {
    // EQ идёт через локальный прокси reelstream. Если он не смог получить поток, пользователь видит причину.
    if ((audio.currentSrc || "").startsWith("http://reelstream.localhost/")) {
      toast("EQ-поток не загрузился (сеть/VPN). Выключите EQ или проверьте соединение");
    }
    if (audio.error && audio.error.code !== 1) restartCurrent("audio");
  });
  el("cover").addEventListener("click", openNowView);
  el("now-close").addEventListener("click", closeNowView);
  el("now-text-toggle").addEventListener("click", toggleNowText);
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
    if (state.captureHotkey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        state.captureHotkey = null;
        renderSettings();
        return;
      }
      const combo = hotkeyFromEvent(e);
      if (!combo) return;
      const action = state.captureHotkey;
      state.captureHotkey = null;
      const custom = { ...hotkeyMap() };
      const busy = Object.keys(custom).find((key) => key !== action && custom[key] === combo);
      custom[action] = combo;
      state.settings.hotkeys = JSON.stringify(custom);
      setSetting("hotkeys", state.settings.hotkeys);
      const button = document.querySelector(`[data-hotkey="${action}"]`);
      if (button) {
        button.classList.remove("capturing");
        button.textContent = hotkeyLabel(combo);
      }
      if (busy) toast(`Комбинация уже занята: ${hotkeyLabel(custom[busy])}`);
      return;
    }
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      closeNowView();
      document.querySelectorAll("dialog[open]").forEach((d) => d.close());
      return;
    }
    const views = { Digit0: "home", Digit1: "library", Digit2: "playlists", Digit3: "cache", Digit4: "settings" };
    if (views[e.code] && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      openView(views[e.code]);
      return;
    }
    const combo = hotkeyFromEvent(e);
    const map = hotkeyMap();
    const action = Object.keys(map).find((key) => map[key] === combo);
    if (action) {
      e.preventDefault();
      runHotkeyAction(action);
    }
  });
}

bind();
boot().catch((e) => showLogin(String(e)));
