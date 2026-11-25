// Reel backend — storage
#![allow(unused_imports)]
use crate::*;

#[tauri::command]
pub(crate) fn playback_save(state: State<'_, AppState>, data: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute(
        "INSERT INTO playback(id,state,updated_at) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
        params![data, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn playback_load(state: State<'_, AppState>) -> Option<String> {
    let conn = state.db.lock().ok()?;
    conn.query_row("SELECT state FROM playback WHERE id=1", [], |r| r.get(0))
        .ok()
}

#[tauri::command]
pub(crate) fn cache_meta_set(state: State<'_, AppState>, key: String, json: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute(
        "INSERT INTO cache_meta(track_key,json) VALUES(?1,?2)
         ON CONFLICT(track_key) DO UPDATE SET json=excluded.json",
        params![key, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cache_meta_all(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT track_key,json FROM cache_meta")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cache_cleanup(state: State<'_, AppState>) -> Result<i64, String> {
    let mut freed = 0i64;
    let mut valid = std::collections::HashSet::new();
    let mut missing = Vec::new();
    {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        let mut stmt = conn
            .prepare("SELECT track_key,path FROM cache")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            if std::path::Path::new(&row.1).exists() {
                valid.insert(row.1);
            } else {
                missing.push(row.0);
            }
        }
        for key in missing {
            let _ = conn.execute("DELETE FROM cache WHERE track_key=?1", params![key]);
        }
    }
    if let Ok(entries) = std::fs::read_dir(&state.cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let keep = path.to_string_lossy();
            if path.is_file() && !valid.contains(keep.as_ref()) {
                if let Ok(meta) = entry.metadata() {
                    freed += meta.len() as i64;
                }
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(freed)
}

#[tauri::command]
pub(crate) async fn github_profile(state: State<'_, AppState>) -> Result<Value, String> {
    let response = state
        .http
        .get("https://api.github.com/users/arcoad")
        .header(reqwest::header::USER_AGENT, "Reel")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("github: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("github http {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "login": body.get("login"),
        "name": body.get("name"),
        "avatar_url": body.get("avatar_url"),
        "html_url": body.get("html_url"),
        "bio": body.get("bio")
    }))
}

#[tauri::command]
pub(crate) fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub(crate) fn autostart_get(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    db_set_setting(&conn, "close_to_tray", if enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())
}
