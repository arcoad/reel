// Dev-only stub: позволяет тестировать UI в обычном браузере без сборки Tauri.
(function () {
  const track = (id, title, artist, album) => ({
    id,
    owner_id: 1,
    title,
    artist,
    duration: 183,
    url: "https://example.invalid/dev-track.mp3",
    hls: "",
    lyrics_id: null,
    access_key: "",
    is_explicit: false,
    cover: "",
    main_artists: album ? [{ id: "123456789", name: artist, domain: "dev" }] : [],
    album: album ? { id, owner_id: -1, title: album, thumb: null } : null,
    dislike: false,
  });
  const tracks = [
    track(1, "Тестовый трек", "Тестовый исполнитель", "Тестовый альбом"),
    track(2, "Второй трек", "Тестовый исполнитель", null),
  ];
  const fixtures = {
    settings_all: [],
    settings_set: null,
    get_token: { access_token: "dev", user_id: 1 },
    account_info: [{ id: 1, first_name: "Dev", last_name: "User" }],
    cache_list: [],
    cache_meta_all: [],
    local_tracks: [],
    playback_load: null,
    playback_save: null,
    autostart_get: false,
    autostart_set: null,
    app_version: "dev",
    github_profile: null,
    update_check: null,
    open_url: null,
    external_lyrics: "Строка первая\nСтрока вторая\nСтрока третья",
    lyrics: { text: "[00:00.00]Строка первая\n[00:03.00]Строка вторая" },
    catalog_get_audio: { catalog: { sections: [{ id: "my", title: "Мои треки", url: "section=all" }] }, audios: tracks, playlists: [{ id: 10, owner_id: 1, title: "Мой плейлист", count: 2 }, { id: -1, owner_id: -1, title: "Подборка VK", type: "generated", count: 5 }] },
    catalog_get_section: { audios: tracks, section: { blocks: [], next_from: null }, next_from: null },
    stream_mix_audios: { audios: tracks },
    audio_search: { items: tracks, count: tracks.length },
    audio_by_id: tracks,
    catalog_artist: {
      audios: tracks,
      artists: [{ id: "123456789", name: "Тестовый исполнитель", photo: [] }],
      playlists: [],
    },
    audio_album: { count: tracks.length, items: tracks },
    audio_add2: 1,
    audio_delete2: 1,
    audio_dislike: 1,
    cache_download: null,
    cache_delete: null,
    cache_clear: null,
    scan_folder: [],
    local_remove: null,
    save_token: { access_token: "dev", user_id: 1 },
    clear_token: null,
    set_close_to_tray: null,
    cache_cleanup: 0,
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (Object.prototype.hasOwnProperty.call(fixtures, cmd)) return fixtures[cmd];
        console.warn("[dev-stub] unknown command:", cmd, args || {});
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };
})();
