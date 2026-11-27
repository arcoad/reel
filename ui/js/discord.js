// Reel UI — discord.js
let presenceStartedAt = 0;
let presenceKey = "";

function presenceEnabled() {
  return state.settings.discord_presence === "1";
}

function presenceStamp() {
  const t = state.queue[state.index];
  if (!t) return "";
  return trackKey(t);
}

async function applyDiscordPresence(enabled) {
  try {
    if (!enabled) {
      await invoke("discord_presence_stop");
      await invoke("discord_presence_clear");
      presenceKey = "";
      return true;
    }
    await invoke("discord_presence_start");
    presenceKey = "";
    await pushDiscordPresence();
    return true;
  } catch (e) {
    toast(`Discord: ${e}`);
    return false;
  }
}

function presenceCover(t) {
  const cover = t && t.cover;
  if (!cover) return "";
  return /^https?:\/\//i.test(cover) ? cover : "";
}

async function pushDiscordPresence() {
  if (!presenceEnabled()) return;
  const t = state.queue[state.index];
  if (!t || t.local_id) {
    await invoke("discord_presence_clear").catch(() => {});
    presenceKey = "";
    return;
  }
  const key = trackKey(t);
  const playing = !audio.paused;
  if (!playing) {
    if (presenceKey) {
      presenceKey = "";
      await invoke("discord_presence_clear").catch(() => {});
    }
    return;
  }
  if (presenceKey === key) return;
  presenceKey = key;
  presenceStartedAt = Math.floor(Date.now() / 1000) - Math.floor(audio.currentTime || 0);
  const details = [t.title, t.artist].filter(Boolean).join(" — ").slice(0, 128);
  await invoke("discord_presence_update", {
    details: details || "Без названия",
    status: "Слушает Reel",
    cover: presenceCover(t),
    startedAt: presenceStartedAt,
    duration: t.duration || null,
  }).catch(() => {});
}