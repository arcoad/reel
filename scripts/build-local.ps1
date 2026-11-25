$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# rust-lld линкует заметно быстрее link.exe. Берём линкер из активного toolchain.
$sysroot = & rustc --print sysroot
$lld = Join-Path $sysroot "lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe"
if ((Test-Path $lld) -and (-not $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER)) {
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $lld
  Write-Host "Linker: rust-lld"
}

$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
if (-not (Test-Path $cargo)) { $cargo = "cargo" }
Push-Location (Join-Path $root "src-tauri")
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  $sw.Stop()
} finally {
  Pop-Location
}

$exe = Join-Path $root "src-tauri\target\release\reel-desktop.exe"
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir "Reel-dev.exe"
Copy-Item $exe $out -Force

# Папка проекта может наследовать метку Low integrity (песочница агента/редактора).
# Windows тогда запускает exe с пониженными правами, WebView2 не может создать профиль
# в %LOCALAPPDATA% и приложение молча закрывается через 1-2 секунды.
# Возвращаем обычный уровень целостности для собранного exe.
& icacls $out /setintegritylevel Medium | Out-Null

Write-Host ("Ready: {0} ({1:n1}s, {2:n1} MB)" -f $out, $sw.Elapsed.TotalSeconds, ((Get-Item $out).Length / 1MB))
