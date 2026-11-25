// Reel backend — updater
#![allow(unused_imports)]
use crate::*;

#[derive(Serialize)]
pub(crate) struct UpdateStatus {
    pub(crate) available: bool,
    pub(crate) current: String,
    pub(crate) version: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) date: Option<String>,
}

pub(crate) fn updater_for(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Ok(conn) = state.db.lock() {
        if let Some(url) = db_get_setting(&conn, "update_endpoint") {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                let parsed = trimmed.parse().map_err(|e| format!("endpoint: {e}"))?;
                builder = builder
                    .endpoints(vec![parsed])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    builder.build().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn update_check(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    let updater = updater_for(&app, &state)?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(match found {
        Some(update) => UpdateStatus {
            available: true,
            current: update.current_version,
            version: Some(update.version),
            notes: update.body,
            date: update.date.map(|d| d.to_string()),
        },
        None => UpdateStatus {
            available: false,
            current,
            version: None,
            notes: None,
            date: None,
        },
    })
}

#[tauri::command]
pub(crate) async fn update_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let updater = updater_for(&app, &state)?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

pub(crate) fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
