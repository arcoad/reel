// Reel backend — auth
#![allow(unused_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn account_info(state: State<'_, AppState>) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert(
        "fields".into(),
        json!("photo_200,first_name,last_name,domain"),
    );
    let token = ensure_fresh_token(&state).await?;
    vk_call_raw(&state.http, &token, "users.get", &p).await
}

#[tauri::command]
pub(crate) fn auth_url(state: State<'_, AppState>) -> String {
    let client_id = {
        let conn = state.db.lock().expect("db");
        db_get_setting(&conn, "client_id").unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
    };
    format!(
        "https://oauth.vk.com/authorize?client_id={client_id}&display=page&redirect_uri=https://oauth.vk.com/blank.html&scope=audio,offline,groups&response_type=token&v={API_VERSION}"
    )
}

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub(crate) fn parse_fragment(input: &str) -> Result<TokenInfo, String> {
    let trimmed = input.trim();
    if !trimmed.contains('#')
        && !trimmed.contains("access_token=")
        && !trimmed.contains(char::is_whitespace)
        && trimmed.len() >= 20
    {
        return Ok(TokenInfo {
            access_token: trimmed.to_string(),
            user_id: None,
            expires_at: None,
        });
    }
    let hash = input
        .find('#')
        .map(|i| &input[i + 1..])
        .or_else(|| input.find("access_token=").map(|i| &input[i..]))
        .ok_or_else(|| "не найден access_token в строке".to_string())?;
    let mut token = None;
    let mut user_id = None;
    let mut expires_at = None;
    for pair in hash.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        match k {
            "access_token" => token = Some(v.to_string()),
            "user_id" => user_id = v.parse::<i64>().ok(),
            "expires_in" => {
                expires_at = v.parse::<i64>().ok().map(|secs| now_ts() + secs);
            }
            _ => {}
        }
    }
    let access_token = token.ok_or_else(|| "пустой access_token".to_string())?;
    if access_token.len() < 10 {
        return Err("access_token слишком короткий".into());
    }
    Ok(TokenInfo {
        access_token,
        user_id,
        expires_at,
    })
}

#[tauri::command]
pub(crate) fn save_token(state: State<'_, AppState>, input: String) -> Result<TokenInfo, String> {
    let info = parse_fragment(input.trim())?;
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM token", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO token(access_token,user_id,expires_at) VALUES(?1,?2,?3)",
        params![info.access_token, info.user_id, info.expires_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
pub(crate) fn get_token(state: State<'_, AppState>) -> Option<TokenInfo> {
    let conn = state.db.lock().ok()?;
    db_token(&conn)
}

#[tauri::command]
pub(crate) fn clear_token(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM token", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    db_set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn settings_all(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT key,value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct LocalTrack {
    pub(crate) id: i64,
    pub(crate) path: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) duration: i64,
}

pub(crate) fn audio_ext(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "flac" | "m4a" | "aac" | "ogg" | "opus" | "wav")
    )
}

pub(crate) fn split_name(stem: &str) -> (String, String) {
    if let Some((artist, title)) = stem.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    ("Неизвестный исполнитель".to_string(), stem.trim().to_string())
}

pub(crate) fn walk_audio(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, depth: usize) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_audio(&path, out, depth + 1);
        } else if audio_ext(&path) {
            out.push(path);
        }
    }
}
