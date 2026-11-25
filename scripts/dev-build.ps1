# Быстрая отладочная сборка: инкрементальный cargo build вместо release.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root "src-tauri")
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & cargo build
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  $sw.Stop()
} finally {
  Pop-Location
}
$exe = Join-Path $root "src-tauri\target\debug\reel-desktop.exe"
$out = Join-Path $root "dist\Reel-dev-debug.exe"
Copy-Item $exe $out -Force
# Папка проекта может иметь метку Low integrity — возвращаем обычный уровень.
& icacls $out /setintegritylevel Medium | Out-Null
Write-Host ("Ready: {0} ({1:n1}s)" -f $out, $sw.Elapsed.TotalSeconds)
