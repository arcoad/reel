# Релизы

Обновления идут через GitHub Releases и `tauri-plugin-updater`. Клиент читает
`latest.json`, скачивает NSIS-установщик и проверяет подпись.

Репозиторий: `arcoad/reel`. Endpoint обновлений — в `src-tauri/tauri.conf.json`
(`plugins.updater.endpoints`).

## Первый раз

1. Создай репозиторий и запушь в него содержимое папки `vkx-desktop` как корень.
2. Добавь секреты в Settings → Secrets and variables → Actions:
   - `TAURI_SIGNING_PRIVATE_KEY` — содержимое файла `%USERPROFILE%\.tauri\reel.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пароль ключа (у текущего пустой).
3. Проверь endpoint в `src-tauri/tauri.conf.json`.

## Выпуск версии

1. Подними `version` в `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml`.
2. Закоммить и поставь тег:

   ```
   git tag v1.2.0
   git push origin main
   git push origin v1.2.0
   ```

3. GitHub Actions (`.github/workflows/release.yml`) соберёт NSIS, подпишет файлы
   и создаст релиз с `latest.json`.
4. Клиенты увидят обновление. Установка идёт в passive-режиме с перезапуском.

## Локальная сборка

```
export TAURI_SIGNING_PRIVATE_KEY="%USERPROFILE%\.tauri\reel.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
node "%APPDATA%\npm\node_modules\@tauri-apps\cli\tauri.js" build
```

Результат: `src-tauri/target/release/bundle/nsis/` (`*-setup.exe`, `.sig`, `latest.json`).

## Важно

- В релиз кладётся **установщик** `*-setup.exe`, а не голый exe: обновление
  подхватывает только установленная версия.
- Приватный ключ не коммитится и не публикуется.
- Endpoint можно переопределить в настройках приложения.
