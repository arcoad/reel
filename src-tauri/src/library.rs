// Reel backend — library
#![allow(unused_imports)]
use crate::*;

#[tauri::command]
pub(crate) fn scan_folder(state: State<'_, AppState>, dir: String) -> Result<Vec<LocalTrack>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("не папка: {dir}"));
    }
    let mut files = Vec::new();
    walk_audio(&root, &mut files, 0);
    files.sort();
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    for path in files {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("track");
        let (artist, title) = split_name(stem);
        let _ = conn.execute(
            "INSERT INTO local_tracks(path,title,artist,added_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(path) DO UPDATE SET title=excluded.title,artist=excluded.artist",
            params![path.to_string_lossy(), title, artist, now_ts()],
        );
    }
    drop(conn);
    local_tracks(state)
}

#[tauri::command]
pub(crate) fn local_tracks(state: State<'_, AppState>) -> Result<Vec<LocalTrack>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT id,path,title,artist,duration FROM local_tracks ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LocalTrack {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                artist: r.get(3)?,
                duration: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn local_remove(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM local_tracks WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cache_list(state: State<'_, AppState>) -> Result<Vec<CacheEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT track_key,path,size,created_at FROM cache ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CacheEntry {
                key: r.get(0)?,
                path: r.get(1)?,
                size: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let entries = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let mut valid = Vec::new();
    let mut stale = Vec::new();
    for entry in entries {
        let ok = std::path::Path::new(&entry.path)
            .metadata()
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false);
        if ok {
            valid.push(entry);
        } else {
            stale.push(entry.key);
        }
    }
    if !stale.is_empty() {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        for key in stale {
            let _ = conn.execute("DELETE FROM cache WHERE track_key=?1", params![key]);
        }
    }
    Ok(valid)
}

#[tauri::command]
pub(crate) async fn cache_download(
    state: State<'_, AppState>,
    key: String,
    url: String,
) -> Result<CacheEntry, String> {
    if !url.starts_with("https://") {
        return Err("invalid url".into());
    }
    if url.contains(".m3u8") {
        return Err("HLS-потоки не кэшируются: у трека нет mp3-URL".into());
    }
    let path = state.cache_dir.join(format!("{key}.mp3"));
    let tmp = state.cache_dir.join(format!("{key}.part"));
    let mut last_error = String::new();
    let mut size = 0i64;
    for attempt in 0..2 {
        let result = async {
            let resp = state
                .http
                .get(&url)
                .header(header::USER_AGENT, USER_AGENT)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("http {}", resp.status()));
            }
            let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            use futures_util::StreamExt;
            use std::io::Write;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).map_err(|e| e.to_string())?;
            }
            drop(file);
            Ok(std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0))
        }
        .await;
        match result {
            Ok(bytes) if bytes > 0 => {
                size = bytes as i64;
                break;
            }
            Ok(_) => last_error = "сервер отдал пустой файл".to_string(),
            Err(e) => last_error = e,
        }
        let _ = std::fs::remove_file(&tmp);
        if attempt == 0 {
            log_line(&format!("cache download retry {key}: {last_error}"));
        }
    }
    if size == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("не удалось скачать: {last_error}"));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let created = now_ts();
    {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        conn.execute(
            "INSERT INTO cache(track_key,path,size,created_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(track_key) DO UPDATE SET path=excluded.path,size=excluded.size,created_at=excluded.created_at",
            params![key, path.to_string_lossy(), size, created],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(CacheEntry {
        key,
        path: path.to_string_lossy().to_string(),
        size,
        created_at: created,
    })
}

#[tauri::command]
pub(crate) fn cache_delete(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    if let Ok(path) = conn.query_row(
        "SELECT path FROM cache WHERE track_key=?1",
        params![key],
        |r| r.get::<_, String>(0),
    ) {
        let _ = std::fs::remove_file(path);
    }
    conn.execute("DELETE FROM cache WHERE track_key=?1", params![key])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cache_meta WHERE track_key=?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cache_clear(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut paths: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path FROM cache") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            paths = rows.flatten().collect();
        }
    }
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    conn.execute("DELETE FROM cache", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cache_meta", []).map_err(|e| e.to_string())?;
    Ok(())
}
