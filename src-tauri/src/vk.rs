// Reel backend — vk
#![allow(unused_imports)]
use crate::*;

pub(crate) fn vk_error(err: &Value) -> String {
    let code = err.get("error_code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code == 5 {
        return "Токен истёк. Вставь новый access_token в окне входа — cookie для этого не нужны.".to_string();
    }
    let msg = err
        .get("error_msg")
        .and_then(|v| v.as_str())
        .unwrap_or("неизвестная ошибка VK");
    format!("VK error {code}: {msg}")
}

pub(crate) async fn vk_call_raw(
    http: &reqwest::Client,
    token: &str,
    method: &str,
    params_obj: &Map<String, Value>,
) -> Result<Value, String> {
    let mut req = http
        .get(format!("https://api.vk.com/method/{method}"))
        .query(&[("v", API_VERSION), ("access_token", token), ("lang", "ru")]);
    for (k, v) in params_obj {
        if v.is_null() {
            continue;
        }
        req = req.query(&[(k.as_str(), value_to_string(v))]);
    }
    let resp = req.send().await.map_err(|e| format!("network: {}", e.without_url()))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
    if let Some(err) = body.get("error") {
        return Err(vk_error(err));
    }
    if !status.is_success() {
        return Err(format!("http {status}: {body}"));
    }
    body.get("response")
        .cloned()
        .ok_or_else(|| format!("no response field: {body}"))
}

pub(crate) fn clean_cookie(name: &str, raw: &str) -> String {
    let t = raw.trim().trim_matches('"').trim();
    let t = t.strip_prefix(&format!("{name}=")).unwrap_or(t);
    t.trim_end_matches(';').trim().to_string()
}

pub(crate) async fn exchange_variant(
    http: &reqwest::Client,
    p: &str,
    remixsid: &str,
    host: &str,
    origin: &str,
) -> Result<TokenInfo, String> {
    let cookie = if p.is_empty() {
        format!("remixsid={remixsid}")
    } else {
        format!("p={p}; remixsid={remixsid}")
    };
    let resp = http
        .post(format!("https://{host}/?act=web_token"))
        .header(reqwest::header::USER_AGENT, WEB_UA)
        .header(reqwest::header::ORIGIN, origin)
        .header(reqwest::header::REFERER, format!("{origin}/"))
        .header(reqwest::header::COOKIE, cookie)
        .form(&[("version", "1"), ("app_id", AUDIO_CLIENT_ID)])
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
    if body.get("type").and_then(|v| v.as_str()) == Some("error") {
        return Err(body
            .get("error_info")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string());
    }
    let data = body.get("data").ok_or_else(|| format!("no data: {body}"))?;
    let access_token = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no access_token: {body}"))?
        .to_string();
    let expires = data
        .get("expires")
        .or_else(|| data.get("expires_in"))
        .and_then(|v| v.as_i64());
    let expires_at = expires.map(|e| if e > 1_000_000_000 { e } else { now_ts() + e });
    let user_id = data.get("user_id").and_then(|v| v.as_i64());
    Ok(TokenInfo {
        access_token,
        user_id,
        expires_at,
    })
}

pub(crate) async fn exchange_web_token(
    http: &reqwest::Client,
    p_raw: &str,
    sid_raw: &str,
) -> Result<TokenInfo, String> {
    let p = clean_cookie("p", p_raw);
    let sid = clean_cookie("remixsid", sid_raw);
    if sid.len() < 10 {
        return Err("remixsid пустой или слишком короткий — скопируй только Value".into());
    }
    let mut errors: Vec<String> = Vec::new();
    for (host, origin, label) in [
        ("login.vk.ru", "https://vk.ru", "vk.ru"),
        ("login.vk.com", "https://vk.com", "vk.com"),
    ] {
        match exchange_variant(http, &p, &sid, host, origin).await {
            Ok(info) => return Ok(info),
            Err(e) => errors.push(format!("{label}→{host}: {e}")),
        }
    }
    match exchange_variant(http, "", &sid, "login.vk.ru", "https://vk.ru").await {
        Ok(info) => Ok(info),
        Err(e) => {
            errors.push(format!("только remixsid: {e}"));
            Err(format!("VK не принял cookie ({})", errors.join("; ")))
        }
    }
}

pub(crate) fn store_web_session(
    state: &AppState,
    info: &TokenInfo,
    p: &str,
    remixsid: &str,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM token", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO token(access_token,user_id,expires_at) VALUES(?1,?2,?3)",
        params![info.access_token, info.user_id, info.expires_at],
    )
    .map_err(|e| e.to_string())?;
    db_set_setting(&conn, "web_p", p).map_err(|e| e.to_string())?;
    db_set_setting(&conn, "web_remixsid", remixsid).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn ensure_fresh_token(state: &AppState) -> Result<String, String> {
    let (token, expires, p, sid) = {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        let token = require_token(&conn)?;
        let expires = token.expires_at;
        (token.access_token, expires, db_get_setting(&conn, "web_p"), db_get_setting(&conn, "web_remixsid"))
    };
    let stale = expires.map(|e| e - now_ts() < 600).unwrap_or(false);
    if stale {
        if let (Some(p), Some(sid)) = (p, sid) {
            match exchange_web_token(&state.http, &p, &sid).await {
                Ok(fresh) => {
                    store_web_session(state, &fresh, &p, &sid)?;
                    return Ok(fresh.access_token);
                }
                Err(e) => {
                    // Cookie нужны только для получения токена. Если обновление не вышло,
                    // пробуем существующий токен — API сам скажет, истёк он или нет.
                    log_line(&format!("token refresh failed, using stored token: {e}"));
                }
            }
        }
    }
    Ok(token)
}

pub(crate) async fn vk_audio_call(
    state: &AppState,
    method: &str,
    params_obj: Map<String, Value>,
) -> Result<Value, String> {
    let token = ensure_fresh_token(state).await?;
    let form: Vec<(String, String)> = params_obj
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), value_to_string(v)))
        .collect();
    let resp = state
        .http
        .post(format!("{AUDIO_API}{method}"))
        .header(reqwest::header::USER_AGENT, MOBILE_UA)
        .query(&[
            ("v", "5.282"),
            ("access_token", token.as_str()),
            ("lang", "ru"),
            ("client_id", AUDIO_CLIENT_ID),
        ])
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
    if let Some(err) = body.get("error") {
        return Err(vk_error(err));
    }
    if !status.is_success() {
        return Err(format!("http {status}: {body}"));
    }
    body.get("response")
        .cloned()
        .ok_or_else(|| format!("no response field: {body}"))
}

#[tauri::command]
pub(crate) async fn web_token_from_cookies(
    state: State<'_, AppState>,
    p: String,
    remixsid: String,
) -> Result<TokenInfo, String> {
    let info = exchange_web_token(&state.http, p.trim(), remixsid.trim()).await?;
    store_web_session(&state, &info, p.trim(), remixsid.trim())?;
    Ok(info)
}

#[tauri::command]
pub(crate) async fn vk_login_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("vklogin") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "vklogin",
        tauri::WebviewUrl::External(
            "https://m.vk.com/login"
                .parse()
                .map_err(|e| format!("url: {e}"))?,
        ),
    )
    .title("Вход VK")
    .inner_size(560.0, 760.0)
    .user_agent(WEB_UA)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn vk_capture_cookies(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<TokenInfo>, String> {
    let Some(win) = app.get_webview_window("vklogin") else {
        return Ok(None);
    };
    let cookies = win.cookies().map_err(|e| e.to_string())?;
    let mut p = None;
    let mut sid = None;
    for c in cookies.iter() {
        match c.name() {
            "p" => p = Some(c.value().to_string()),
            "remixsid" => sid = Some(c.value().to_string()),
            _ => {}
        }
    }
    if sid.is_some() && p.is_none() {
        if let Ok(u) = win.url() {
            if u.host_str() == Some("m.vk.com") && u.path() != "/login" {
                let _ = win.navigate("https://vk.com/".parse().expect("url"));
            }
        }
        return Ok(None);
    }
    let (Some(p), Some(sid)) = (p, sid) else {
        return Ok(None);
    };
    if p.is_empty() || sid.is_empty() {
        return Ok(None);
    }
    let info = exchange_web_token(&state.http, &p, &sid).await?;
    store_web_session(&state, &info, &p, &sid)?;
    let _ = win.close();
    Ok(Some(info))
}

#[tauri::command]
pub(crate) async fn catalog_get_audio(
    state: State<'_, AppState>,
    owner_id: Option<i64>,
) -> Result<Value, String> {
    let mut p = Map::new();
    if let Some(id) = owner_id {
        p.insert("owner_id".into(), json!(id));
    }
    p.insert("need_blocks".into(), json!("1"));
    vk_audio_call(&state, "catalog.getAudio", p).await
}

#[tauri::command]
pub(crate) async fn audio_playlists(
    state: State<'_, AppState>,
    owner_id: Option<i64>,
    count: Option<i64>,
    offset: Option<i64>,
) -> Result<Value, String> {
    let mut p = Map::new();
    if let Some(id) = owner_id {
        p.insert("owner_id".into(), json!(id));
    }
    p.insert("count".into(), json!(count.unwrap_or(100).clamp(1, 100)));
    p.insert("offset".into(), json!(offset.unwrap_or(0)));
    vk_audio_call(&state, "audio.getPlaylists", p).await
}

#[tauri::command]
pub(crate) async fn catalog_get_section(
    state: State<'_, AppState>,
    section_id: String,
    start_from: Option<String>,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("section_id".into(), json!(section_id));
    if let Some(s) = start_from {
        p.insert("start_from".into(), json!(s));
    }
    vk_audio_call(&state, "catalog.getSection", p).await
}

#[tauri::command]
pub(crate) async fn stream_mix_audios(
    state: State<'_, AppState>,
    count: Option<i64>,
    offset: Option<i64>,
    mix_id: Option<String>,
) -> Result<Value, String> {
    let mut p = Map::new();
    let mix = mix_id
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "common".to_string());
    p.insert("mix_id".into(), json!(mix));
    p.insert("count".into(), json!(count.unwrap_or(30).clamp(1, 100)));
    if let Some(start) = offset {
        if start > 0 {
            p.insert("offset".into(), json!(start));
        }
    }
    vk_audio_call(&state, "audio.getStreamMixAudios", p).await
}

#[tauri::command]
pub(crate) async fn audio_by_id(state: State<'_, AppState>, audios: Vec<String>) -> Result<Value, String> {
    if audios.is_empty() {
        return Ok(json!([]));
    }
    let mut p = Map::new();
    p.insert("audios".into(), json!(audios.join(",")));
    vk_audio_call(&state, "audio.getById", p).await
}

#[tauri::command]
pub(crate) async fn audio_search2(
    state: State<'_, AppState>,
    q: String,
    count: i64,
    offset: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("q".into(), json!(q));
    p.insert("count".into(), json!(count));
    p.insert("offset".into(), json!(offset));
    vk_audio_call(&state, "audio.search", p).await
}

#[tauri::command]
pub(crate) async fn audio_add2(
    state: State<'_, AppState>,
    audio_id: i64,
    owner_id: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("audio_id".into(), json!(audio_id));
    p.insert("owner_id".into(), json!(owner_id));
    vk_audio_call(&state, "audio.add", p).await
}

#[tauri::command]
pub(crate) async fn audio_delete2(
    state: State<'_, AppState>,
    audio_id: i64,
    owner_id: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("audio_id".into(), json!(audio_id));
    p.insert("owner_id".into(), json!(owner_id));
    vk_audio_call(&state, "audio.delete", p).await
}

#[tauri::command]
pub(crate) async fn audio_dislike(
    state: State<'_, AppState>,
    audio_id: i64,
    owner_id: i64,
    dislike: bool,
) -> Result<Value, String> {
    // VK принимает список пар "owner_id_audio_id" (можно несколько через запятую).
    let mut p = Map::new();
    p.insert("audio_ids".into(), json!(format!("{owner_id}_{audio_id}")));
    let method = if dislike {
        "audio.addDislike"
    } else {
        "audio.removeDislike"
    };
    vk_audio_call(&state, method, p).await
}

#[tauri::command]
pub(crate) async fn catalog_artist(
    state: State<'_, AppState>,
    artist_id: String,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("artist_id".into(), json!(artist_id));
    p.insert("need_blocks".into(), json!(1));
    vk_audio_call(&state, "catalog.getAudioArtist", p).await
}

#[tauri::command]
pub(crate) async fn audio_album(
    state: State<'_, AppState>,
    owner_id: i64,
    album_id: i64,
    count: Option<i64>,
    offset: Option<i64>,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("owner_id".into(), json!(owner_id));
    p.insert("album_id".into(), json!(album_id));
    p.insert("count".into(), json!(count.unwrap_or(300)));
    p.insert("offset".into(), json!(offset.unwrap_or(0)));
    vk_audio_call(&state, "audio.get", p).await
}

#[tauri::command]
pub(crate) async fn lyrics(state: State<'_, AppState>, lyrics_id: i64) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("lyrics_id".into(), json!(lyrics_id));
    let token = ensure_fresh_token(&state).await?;
    vk_call_raw(&state.http, &token, "audio.getLyrics", &p).await
}
