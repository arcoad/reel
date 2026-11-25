// Reel backend — logging
#![allow(unused_imports)]
use crate::*;

pub(crate) fn logs_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("app.reel.desktop")
        .join("logs")
}

pub(crate) fn log_line(message: &str) {
    let dir = logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("app.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("app.log.1"));
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{}] {}", now_ts(), message);
    }
}

pub(crate) fn init_logging() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {info}");
        log_line(&msg);
        // GUI-сборка без консоли: отдельный файл, чтобы падение было видно пользователю/в поддержке.
        let dir = logs_dir();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("panic.log"), format!("[{}] {msg}\n", now_ts()));
        // Паника в Tauri (например, не удалось создать WebView) иначе выглядит как
        // мгновенное закрытие окна без единого сообщения.
        show_startup_error(&format!("{info}"));
    }));
    log_line("app started");
}

#[tauri::command]
pub(crate) fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub(crate) fn open_logs() -> Result<(), String> {
    let dir = logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
