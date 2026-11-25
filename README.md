# Reel

Неофициальный музыкальный плеер для Windows на Rust + Tauri 2.
Не связан с правообладателями сервиса и не распространяет их бинарники или ресурсы.

## Что это

Reel — тихий десктопный плеер: библиотека, поиск, плейлисты, очередь, офлайн-кэш,
локальные файлы, экран «сейчас играет» с текстом, трей и автоматические обновления.
Интерфейс на русском, данные хранятся локально.

## Возможности

- вход через официальный сайт сервиса: окно входа → cookie `p` + `remixsid` → токен;
- каталог, поиск, плейлисты, добавление и удаление треков;
- MP3 и HLS, очередь, repeat/shuffle, seek, громкость, mute;
- экран «Сейчас играет» по клику на обложку: большой конверт, управление, текст;
- сохранение трека, позиции, очереди, режимов и громкости в SQLite; восстановление на паузе;
- кэш треков и офлайн-воспроизведение через собственный протокол с Range;
- локальная фонотека: MP3/FLAC/M4A/OGG/WAV, рекурсивно;
- тёмная/светлая/amoled/nord/gruvbox темы, акцент;
- трей, закрытие в трей, автозапуск с Windows, single-instance;
- автообновления через GitHub Releases (NSIS + minisign).

## Установка

1. Скачай `Reel_<version>_x64-setup.exe` из [Releases](../../releases/latest).
2. Установи и запусти.
3. Войди в аккаунт: «Войти в аккаунт» или «У меня уже есть cookie».
4. Обновления приходят автоматически; «Позже» скрывает окно для этой версии.

Установленная копия живёт в `%LOCALAPPDATA%\Reel`; данные — в
`%APPDATA%\app.reel.desktop\reel.db`. Голый exe из `dist/` автообновление не получит.

## Сборка

Нужны Rust (MSVC), Node.js, WebView2, Visual Studio Build Tools.

```bash
cd src-tauri
cargo build --release
cd ..
npx @tauri-apps/cli@2 build
```

Быстрая локальная сборка без установщика (скрипт сам подставляет `rust-lld`
и печатает время сборки):

```powershell
.\scripts\build-local.ps1
```

Release-профиль в `src-tauri/Cargo.toml` настроен на скорость: без LTO,
с инкрементальной компиляцией и без отладочных символов. Холодная сборка
занимает несколько минут, повторная после правки `main.rs` — секунды.
Каталог `src-tauri/target/` — кэш сборки; `cargo clean` сбрасывает его,
но следующая сборка снова будет холодной.

Установщик и `latest.json` появятся в `src-tauri/target/release/bundle/nsis/`.
Для подписи:

```bash
export TAURI_SIGNING_PRIVATE_KEY="%USERPROFILE%\.tauri\reel.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx @tauri-apps/cli@2 build
```

Приватный ключ не коммитится. Публичный вшит в `src-tauri/tauri.conf.json`.

## Как это работает

- **UI** — статические `ui/*.html|css|js` в WebView2, без бандлера.
- **Rust** — команды: авторизация, запросы каталога, SQLite, кэш, локальная фонотека,
  протоколы `reelcache`/`reelfile` с Range для seek, трей и окно.
- **Медиа** — `Audio` и hls.js; WebAudio не используется, чтобы не глушить кросс-доменный поток.
- **Данные** — `reel.db`: `token`, `settings`, `cache`, `cache_meta`, `playback`, `local_tracks`.

## Документация

- [docs/RELEASING.md](docs/RELEASING.md) — как устроены релизы и автообновления.
- [docs/VKX-9.0-spec.md](docs/VKX-9.0-spec.md) — разбор Android-клиента VKX 9.0:
  какие запросы и параметры использует оригинальное приложение.

## Версии и релизы

Схема: `1.0.0` → `1.0.1` (фикс) → `1.1.0` (фичи) → `2.0.0` (breaking).
Четырёхзначные версии (`1.0.0.1`) не поддерживаются semver.

1. Подними `version` в `src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. GitHub Actions соберёт NSIS, подпишет артефакты и создаст релиз с `latest.json`.
4. Клиенты видят обновление; установка passive с перезапуском.

Секреты Actions: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Endpoint по умолчанию:
`https://github.com/arcoad/reel/releases/latest/download/latest.json`.

## Правовой статус

Проект создан для личного использования и совместимости. Права на сервис, контент и
товарные знаки принадлежат их владельцам. Автор репозитория не связан с сервисом и не
предоставляет доступ к чужому контенту.