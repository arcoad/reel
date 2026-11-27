// Reel UI — discord.js
let presenceStartedAt = 0;
let presenceKey = "";

function presenceEnabled() {
  return state.settings.discord_presence === "1";
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

function presenceDuration(t) {
  const value = Number(t && t.duration);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function presenceRemaining(duration) {
  const left = duration - (audio.currentTime || 0);
  return left > 0.5 ? Math.ceil(left) : null;
}

async function sendPresence(t, remaining) {
  const title = (t.title || "Без названия").slice(0, 128);
  const artist = (t.artist || "").slice(0, 128);
  await invoke("discord_presence_update", {
    details: title,
    status: artist,
    cover: presenceCover(t),
    startedAt: presenceStartedAt,
    duration: remaining,
  }).catch(() => {});
}

async function pushDiscordPresence() {
  if (!presenceEnabled()) return;
  const t = state.queue[state.index];
  if (!t || t.local_id) {
    presenceKey = "";
    await invoke("discord_presence_clear").catch(() => {});
    return;
  }
  if (audio.paused) {
    if (presenceKey) {
      presenceKey = "";
      await invoke("discord_presence_clear").catch(() => {});
    }
    return;
  }
  const key = trackKey(t);
  if (presenceKey !== key) {
    presenceKey = key;
    presenceStartedAt = Math.floor(Date.now() / 1000) - Math.floor(audio.currentTime || 0);
  }
  await sendPresence(t, presenceRemaining(presenceDuration(t)));
}