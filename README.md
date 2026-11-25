# Reel

Музыкальный плеер для Windows. Написан на Rust и Tauri 2, интерфейс — обычный HTML/CSS/JS в WebView2.

## Возможности

- вход через официальный сайт сервиса: cookie `p` и `remixsid` обмениваются на токен;
- каталог, поиск, плейлисты, добавление и удаление треков;
- MP3 и HLS, очередь, повтор, случайный порядок, перемотка, громкость;
- экран «Сейчас играет» с текстом песни;
- сохранение трека, позиции, очереди и настроек в SQLite;
- кэш треков и офлайн-воспроизведение;
- локальные файлы: MP3, FLAC, M4A, OGG, WAV;
- темы: тёмная, светлая, amoled, nord, gruvbox; настраиваемый акцент;
- трей, закрытие в трей, автозапуск, один экземпляр;
- обновления через GitHub Releases (NSIS + minisign).

## Установка

1. Скачай `Reel_<version>_x64-setup.exe` со страницы [Releases](../../releases/latest).
2. Установи и запусти.
3. Войди в аккаунт: «Войти в аккаунт» или «У меня уже есть cookie».

Установленная копия лежит в `%LOCALAPPDATA%\Reel`, данные — в
`%APPDATA%\app.reel.desktop\reel.db`. Портативный exe из `dist/` обновления не получает.

## Сборка

Нужны Rust (MSVC), Node.js, WebView2 и Visual Studio Build Tools.

```bash
cd src-tauri
cargo build --release
cd ..
npx @tauri-apps/cli@2 build
```

Быстрая сборка без установщика:

```powershell
.\scripts\build-local.ps1
```

Установщик, `.sig` и `latest.json` появятся в `src-tauri/target/release/bundle/nsis/`.
Для подписи нужен приватный ключ:

```bash
export TAURI_SIGNING_PRIVATE_KEY="%USERPROFILE%\.tauri\reel.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx @tauri-apps/cli@2 build
```

Ключ в репозиторий не попадает. Публичная часть лежит в `src-tauri/tauri.conf.json`.

## Структура

```
ui/                 интерфейс: index.html, design.css, js/*.js
src-tauri/src/      бэкенд: команды, VK API, SQLite, кэш, локальные файлы
src-tauri/icons/    иконки приложения
docs/               документация по релизам
scripts/            локальные скрипты сборки
```

- **UI** — статические файлы в WebView2, без сборщика.
- **Rust** — команды Tauri, SQLite, кэш и протоколы `reelcache`/`reelfile` с Range для перемотки.
- **Медиа** — `Audio` и hls.js.
- **Данные** — `reel.db`: `token`, `settings`, `cache`, `cache_meta`, `playback`, `local_tracks`.

## Релизы

1. Подними `version` в `src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`.
2. Поставь тег `vX.Y.Z` и запушь его.
3. GitHub Actions соберёт NSIS, подпишет файлы и создаст релиз с `latest.json`.

Подробнее — в [docs/RELEASING.md](docs/RELEASING.md).

## Лицензия

Проект для личного использования. Права на сервис, контент и товарные знаки
принадлежат их владельцам. Автор не связан с сервисом.
