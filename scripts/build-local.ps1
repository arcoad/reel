$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
if (-not (Test-Path $cargo)) { $cargo = "cargo" }
Push-Location (Join-Path $root "src-tauri")
try {
  & $cargo build --release
} finally {
  Pop-Location
}
$exe = Join-Path $root "src-tauri\target\release\vkx-desktop.exe"
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir "VKX-Desktop-dev.exe"
Copy-Item $exe $out -Force
Write-Host "Ready: $out"
