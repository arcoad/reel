# Быстрый тест UI в обычном браузере — без сборки Tauri.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ui = Join-Path $root "ui"
$port = 8765
Write-Host "Dev UI: http://127.0.0.1:$port/dev.html"
Write-Host "Для остановки: Ctrl+C"
cmd /c start "" "http://127.0.0.1:$port/dev.html"
& python -m http.server $port --bind 127.0.0.1 --directory $ui
