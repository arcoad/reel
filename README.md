# VKX Desktop

Неофициальный десктопный порт музыкальной части **VKX 9.0** на Rust + Tauri 2.
Не аффилирован с VK, ITaysonLab или авторами VKX. Код написан с нуля по результатам
статического анализа APK; бинарники и ресурсы VKX в репозитории не распространяются.

## Что это

Плеер для музыки VK под Windows: библиотека, поиск, плейлисты, очередь, кэш для офлайна,
локальные файлы, темы и автоматические обновления. Работает в отдельном окне WebView2,
сеть и БД — на стороне Rust.

## Что умеет

- вход через VK: окно `m.vk.com/login` → cookie `p` + `remixsid` → `login.vk.ru/?act=web_token`
  (приложение `6287487`), либо ручной токен;
- `catalog.getAudio`, `catalog.getSection`, `audio.search`, `audio.add/delete` на `api.vk.ru` v5.282;
- воспроизведение MP3 и HLS (`m3u8` через hls.js), очередь, repeat/shuffle, seek, громкость;
- кэш треков в SQLite + файлы, офлайн-воспроизведение через собственный протокол с Range;
- локальная фонотека: рекурсивное сканирование папки (MP3/FLAC/M4A/OGG/WAV);
- сохранение очереди и позиции, текст песни (`audio.getLyrics`), темы dark/light/amoled/nord/gruvbox;
- автообновление через GitHub Releases (NSIS + подпись minisign).

## Ограничения

- VK закрыл публичный `audio.*` для сторонних токенов. VKX ходит в свой `api.moosic.io` через
  `silent_token`; здесь используется современный `web_token`-путь приложения `6287487`.
  Нужен вход в VK, иначе каталог недоступен.
- Эквалайзер отключён для сетевых потоков: CDN VK не отдаёт CORS, и Web Audio глушит такой звук.
  Для локального прокси-пути EQ — отдельная задача.
- Не перенесены: UMA-радио, подкасты/аудиокниги, Android Auto/Cast/виджеты, Realm-миграции,
  VK Connect (`silent_token`).
- Токен и cookies хранятся локально в `%APPDATA%\dev.vkx.desktop\vkx.db`; приложение не отправляет
  их никуда, кроме `api.vk.ru` / `login.vk.ru`.

## Установка

1. Скачай `VKX-Desktop_<version>_x64-setup.exe` из [Releases](../../releases/latest).
2. Установи и запусти. Первая установка — вручную; дальше обновления приходят из приложения.
3. Войди: «Войти через VK» (окно) или «У меня уже есть cookie» (`p`, `remixsid` из DevTools).
4. Настройки → «Проверить» в разделе «Обновления».

Установленная копия живёт в `%LOCALAPPDATA%\VKX Desktop`. Голый exe из `dist/` автообновление
не получит — нужен установщик.

## Сборка

Нужны: Rust (MSVC toolchain), Node.js, WebView2, Visual Studio Build Tools.

```bash
cd src-tauri
cargo build --release
cd ..
npx @tauri-apps/cli@2 build
```

Установщик и `latest.json` появятся в `src-tauri/target/release/bundle/nsis/`.
Для подписи обновлений:

```bash
export TAURI_SIGNING_PRIVATE_KEY="%USERPROFILE%\.tauri\vkx-desktop.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx @tauri-apps/cli@2 build
```

Приватный ключ не коммитится. Публичный уже вшит в `src-tauri/tauri.conf.json`; его замена
ломает обновления у установленных клиентов.

## Как это работает

- **UI** — статические `ui/*.html|css|js` во встроенном WebView2. Никакого бандлера.
- **Rust** (`src-tauri/src/main.rs`) — команды: токен/cookies, вызовы VK API, SQLite, кэш,
  локальная фонотека, два custom-протокола (`vkxcache`, `vkxfile`) с Range для seek.
- **VK-слой** — `api.vk.ru/method/*?v=5.282&client_id=6287487` с мобильным UA,
  токен получается из cookie через `login.vk.ru/?act=web_token` и автообновляется.
- **Медиа** — `Audio` элемент; HLS отдаётся в hls.js, mp3 играется напрямую. WebAudio не
  используется, чтобы не глушить кросс-доменный поток.
- **Данные** — `vkx.db`: `token`, `settings`, `cache`, `queue`, `local_tracks`.

## Релизы и обновления

Репозиторий собирает установщики через GitHub Actions по тегу `vX.Y.Z`.

1. Подними `version` в `src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Actions соберёт NSIS, подпишет артефакты и создаст релиз с `latest.json`.
4. Клиенты видят обновление в Настройках; установка идёт в passive-режиме с перезапуском.

Секреты Actions: `TAURI_SIGNING_PRIVATE_KEY` (содержимое приватного ключа),
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (пусто, если ключ без пароля).

Endpoint по умолчанию:
`https://github.com/arcoad/vkx-desktop/releases/latest/download/latest.json`.
Можно переопределить в Настройках приложения.

## Правовой статус

Проект создан для совместимости и личного использования. VK API и музыка принадлежат VK;
VKX и его торговая марка — авторам VKX. Используй на свой аккаунт и соблюдай правила VK.
Автор репозитория не связан с VK и не предоставляет доступ к чужому контенту.