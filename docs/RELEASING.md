# Релизы и обновления

Обновления работают через GitHub Releases + `tauri-plugin-updater`. Клиент проверяет `latest.json`, скачивает NSIS-установщик, проверяет подпись и устанавливает.

## Один раз

1. Создай репозиторий `vkx-desktop` (по умолчанию в конфиге: `meskimkolayra-lab/vkx-desktop`). Если имя другое — поменяй endpoint в `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`) или в приложении: Настройки → Endpoint обновлений.
2. Запушь содержимое папки `vkx-desktop` как корень репозитория.
3. Добавь секреты репозитория (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — **всё содержимое** файла `%USERPROFILE%\.tauri\vkx-desktop.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пустая строка (ключ без пароля).
4. Приватный ключ не коммить. Потеря ключа = невозможность выпускать обновления для уже установленных клиентов.

## Выпуск версии

1. Подними `version` в `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml` (например `0.1.1`).
2. Закоммить и поставь тег:
   ```
   git tag v0.1.1
   git push origin v0.1.1
   ```
3. GitHub Actions (`.github/workflows/release.yml`) соберёт NSIS, подпишет артефакты и создаст релиз с `latest.json`.
4. У клиентов: Настройки → «Проверить» → «Обновить». Установщик идёт в passive-режиме, приложение перезапускается.

## Локальная сборка

```
export TAURI_SIGNING_PRIVATE_KEY="%USERPROFILE%\.tauri\vkx-desktop.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
node "%APPDATA%\npm\node_modules\@tauri-apps\cli\tauri.js" build
```

Артефакты: `src-tauri/target/release/bundle/nsis/` (`*-setup.exe`, `.sig`, `latest.json`).

## Важно

- Друзьям раздаётся **установщик** `*-setup.exe`, а не голый exe: автообновление работает только у установленной копии.
- Первая версия с апдейтером ставится вручную; дальше — из приложения.
- Публичный ключ уже вшит в `tauri.conf.json`; менять его нельзя без перевыпуска доверия у клиентов.