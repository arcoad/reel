#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Emitter, Manager, State};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::WindowEvent;
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_updater::UpdaterExt;

const API_VERSION: &str = "5.272";
const USER_AGENT: &str = "Reel/1.0.0 (+https://github.com/arcoad/reel)";
const DEFAULT_CLIENT_ID: &str = "2685278";
const AUDIO_CLIENT_ID: &str = "6287487";
const AUDIO_API: &str = "https://api.vk.ru/method/";
const MOBILE_UA: &str = "VKAndroidApp/4.13.1-1206 (Android 4.4.3; SDK 19; armeabi; ; ru)";
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0";

struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
    cache_dir: PathBuf,
    close_to_tray: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone)]
struct TokenInfo {
    access_token: String,
    user_id: Option<i64>,
    expires_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct QueueItem {
    id: i64,
    owner_id: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    key: String,
    path: String,
    size: i64,
    created_at: i64,
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS token(access_token TEXT NOT NULL, user_id INTEGER, expires_at INTEGER);
         CREATE TABLE IF NOT EXISTS playlists(id INTEGER NOT NULL, owner_id INTEGER NOT NULL, title TEXT, count INTEGER, photo TEXT, description TEXT, PRIMARY KEY(id, owner_id));
         CREATE TABLE IF NOT EXISTS queue(pos INTEGER PRIMARY KEY, id INTEGER NOT NULL, owner_id INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS cache(track_key TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS library(id INTEGER NOT NULL, owner_id INTEGER NOT NULL, title TEXT, artist TEXT, duration INTEGER, saved_at INTEGER, PRIMARY KEY(id, owner_id));
         CREATE TABLE IF NOT EXISTS local_tracks(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, artist TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS playback(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS cache_meta(track_key TEXT PRIMARY KEY, json TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
         PRAGMA user_version=2;",
    )
}

fn db_get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0))
        .ok()
}

fn db_set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn db_token(conn: &Connection) -> Option<TokenInfo> {
    conn.query_row(
        "SELECT access_token,user_id,expires_at FROM token LIMIT 1",
        [],
        |r| {
            Ok(TokenInfo {
                access_token: r.get(0)?,
                user_id: r.get(1).ok(),
                expires_at: r.get(2).ok(),
            })
        },
    )
    .ok()
}

fn require_token(conn: &Connection) -> Result<TokenInfo, String> {
    db_token(conn).ok_or_else(|| "Не авторизован: добавь access_token в настройках".to_string())
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

async fn vk_call_raw(
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
        return Err(err.to_string());
    }
    if !status.is_success() {
        return Err(format!("http {status}: {body}"));
    }
    body.get("response")
        .cloned()
        .ok_or_else(|| format!("no response field: {body}"))
}

async fn vk_call(
    state: &AppState,
    method: &str,
    params_obj: Map<String, Value>,
) -> Result<Value, String> {
    let token = {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        require_token(&conn)?
    };
    vk_call_raw(&state.http, &token.access_token, method, &params_obj).await
}

fn parse_params(params: Value) -> Result<Map<String, Value>, String> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map),
        _ => Err("params must be an object".into()),
    }
}

fn clean_cookie(name: &str, raw: &str) -> String {
    let t = raw.trim().trim_matches('"').trim();
    let t = t.strip_prefix(&format!("{name}=")).unwrap_or(t);
    t.trim_end_matches(';').trim().to_string()
}

async fn exchange_variant(
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

async fn exchange_web_token(
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

#[tauri::command]
async fn web_token_probe(
    state: State<'_, AppState>,
    p: String,
    remixsid: String,
) -> Result<Value, String> {
    let p = clean_cookie("p", &p);
    let sid = clean_cookie("remixsid", &remixsid);
    let mut out = Vec::new();
    for (host, origin, label) in [
        ("login.vk.ru", "https://vk.ru", "vk.ru"),
        ("login.vk.com", "https://vk.com", "vk.com"),
        ("login.vk.ru", "https://vk.ru", "sid-only"),
    ] {
        let (use_p, tag) = if label == "sid-only" { ("", label) } else { (p.as_str(), label) };
        let res = exchange_variant(&state.http, use_p, &sid, host, origin).await;
        out.push(match res {
            Ok(info) => json!({"variant": tag, "ok": true, "token_len": info.access_token.len()}),
            Err(e) => json!({"variant": tag, "ok": false, "error": e}),
        });
    }
    Ok(Value::Array(out))
}

fn store_web_session(
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

async fn ensure_fresh_token(state: &AppState) -> Result<String, String> {
    let (token, expires, p, sid) = {
        let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
        let token = require_token(&conn)?;
        let expires = token.expires_at;
        (token.access_token, expires, db_get_setting(&conn, "web_p"), db_get_setting(&conn, "web_remixsid"))
    };
    let stale = expires.map(|e| e - now_ts() < 600).unwrap_or(false);
    if stale {
        if let (Some(p), Some(sid)) = (p, sid) {
            let fresh = exchange_web_token(&state.http, &p, &sid).await?;
            store_web_session(state, &fresh, &p, &sid)?;
            return Ok(fresh.access_token);
        }
    }
    Ok(token)
}

async fn vk_audio_call(
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
        return Err(err.to_string());
    }
    if !status.is_success() {
        return Err(format!("http {status}: {body}"));
    }
    body.get("response")
        .cloned()
        .ok_or_else(|| format!("no response field: {body}"))
}

#[tauri::command]
async fn web_token_from_cookies(
    state: State<'_, AppState>,
    p: String,
    remixsid: String,
) -> Result<TokenInfo, String> {
    let info = exchange_web_token(&state.http, p.trim(), remixsid.trim()).await?;
    store_web_session(&state, &info, p.trim(), remixsid.trim())?;
    Ok(info)
}

#[tauri::command]
async fn vk_login_window(app: tauri::AppHandle) -> Result<(), String> {
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
async fn vk_capture_cookies(
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
async fn vk_audio_method(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let map = parse_params(params)?;
    vk_audio_call(&state, &method, map).await
}

#[tauri::command]
async fn catalog_get_audio(
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
async fn catalog_get_section(
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
async fn audio_search2(
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
async fn audio_add2(
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
async fn audio_delete2(
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
async fn vk_method(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let map = parse_params(params)?;
    vk_call(&state, &method, map).await
}

#[tauri::command]
async fn audio_get(
    state: State<'_, AppState>,
    owner_id: i64,
    offset: i64,
    count: i64,
    playlist_id: Option<i64>,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("owner_id".into(), json!(owner_id));
    p.insert("offset".into(), json!(offset));
    p.insert("count".into(), json!(count));
    if let Some(pid) = playlist_id {
        p.insert("playlist_id".into(), json!(pid));
    }
    vk_call(&state, "audio.get", p).await
}

#[tauri::command]
async fn audio_search(
    state: State<'_, AppState>,
    q: String,
    offset: i64,
    count: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("q".into(), json!(q));
    p.insert("offset".into(), json!(offset));
    p.insert("count".into(), json!(count));
    p.insert("filter".into(), json!("all"));
    match vk_call(&state, "audio.search", p.clone()).await {
        Ok(v) => Ok(v),
        Err(_) => vk_call(&state, "audio.searchMain", p).await,
    }
}

#[tauri::command]
async fn audio_playlists(
    state: State<'_, AppState>,
    owner_id: i64,
    offset: i64,
    count: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("owner_id".into(), json!(owner_id));
    p.insert("offset".into(), json!(offset));
    p.insert("count".into(), json!(count));
    vk_call(&state, "audio.getPlaylists", p).await
}

#[tauri::command]
async fn audio_add(
    state: State<'_, AppState>,
    audio_id: i64,
    owner_id: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("audio_id".into(), json!(audio_id));
    p.insert("owner_id".into(), json!(owner_id));
    vk_call(&state, "audio.add", p).await
}

#[tauri::command]
async fn audio_delete(
    state: State<'_, AppState>,
    audio_id: i64,
    owner_id: i64,
) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("audio_id".into(), json!(audio_id));
    p.insert("owner_id".into(), json!(owner_id));
    vk_call(&state, "audio.delete", p).await
}

#[tauri::command]
async fn audio_get_by_id(state: State<'_, AppState>, audios: String) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("audios".into(), json!(audios));
    vk_call(&state, "audio.getById", p).await
}

#[tauri::command]
async fn lyrics(state: State<'_, AppState>, lyrics_id: i64) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert("lyrics_id".into(), json!(lyrics_id));
    vk_call(&state, "audio.getLyrics", p).await
}

fn strip_lrc(input: &str) -> String {
    input
        .lines()
        .map(|line| match line.find(']') {
            Some(index) => line[index + 1..].trim_start(),
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
async fn external_lyrics(
    state: State<'_, AppState>,
    artist: String,
    title: String,
) -> Result<Option<String>, String> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return Ok(None);
    }
    let response = state
        .http
        .get("https://lrclib.net/api/get")
        .query(&[("artist_name", artist.as_str()), ("track_name", title.as_str())])
        .header(
            reqwest::header::USER_AGENT,
            "Reel (https://github.com/arcoad/reel)",
        )
        .send()
        .await
        .map_err(|e| format!("lrclib: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await.map_err(|e| format!("lrclib json: {e}"))?;
    if let Some(text) = body.get("plainLyrics").and_then(|v| v.as_str()) {
        if !text.trim().is_empty() {
            return Ok(Some(text.to_string()));
        }
    }
    if let Some(text) = body.get("syncedLyrics").and_then(|v| v.as_str()) {
        let cleaned = strip_lrc(text);
        if !cleaned.trim().is_empty() {
            return Ok(Some(cleaned));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn account_info(state: State<'_, AppState>) -> Result<Value, String> {
    let mut p = Map::new();
    p.insert(
        "fields".into(),
        json!("photo_200,first_name,last_name,domain"),
    );
    vk_call(&state, "users.get", p).await
}

#[tauri::command]
fn auth_url(state: State<'_, AppState>) -> String {
    let client_id = {
        let conn = state.db.lock().expect("db");
        db_get_setting(&conn, "client_id").unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
    };
    format!(
        "https://oauth.vk.com/authorize?client_id={client_id}&display=page&redirect_uri=https://oauth.vk.com/blank.html&scope=audio,offline,groups&response_type=token&v={API_VERSION}"
    )
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn parse_fragment(input: &str) -> Result<TokenInfo, String> {
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
fn save_token(state: State<'_, AppState>, input: String) -> Result<TokenInfo, String> {
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
fn get_token(state: State<'_, AppState>) -> Option<TokenInfo> {
    let conn = state.db.lock().ok()?;
    db_token(&conn)
}

#[tauri::command]
fn clear_token(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM token", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>, key: String) -> Option<String> {
    let conn = state.db.lock().ok()?;
    db_get_setting(&conn, &key)
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    db_set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_all(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT key,value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn queue_save(state: State<'_, AppState>, items: Vec<QueueItem>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM queue", []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO queue(pos,id,owner_id) VALUES(?1,?2,?3)")
            .map_err(|e| e.to_string())?;
        for (i, item) in items.iter().enumerate() {
            stmt.execute(params![i as i64, item.id, item.owner_id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn queue_load(state: State<'_, AppState>) -> Result<Vec<QueueItem>, String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut stmt = conn
        .prepare("SELECT id,owner_id FROM queue ORDER BY pos")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(QueueItem {
                id: r.get(0)?,
                owner_id: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
struct LocalTrack {
    id: i64,
    path: String,
    title: String,
    artist: String,
    duration: i64,
}

fn audio_ext(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "flac" | "m4a" | "aac" | "ogg" | "opus" | "wav")
    )
}

fn split_name(stem: &str) -> (String, String) {
    if let Some((artist, title)) = stem.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    ("Неизвестный исполнитель".to_string(), stem.trim().to_string())
}

fn walk_audio(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, depth: usize) {
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

#[tauri::command]
fn scan_folder(state: State<'_, AppState>, dir: String) -> Result<Vec<LocalTrack>, String> {
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
fn local_tracks(state: State<'_, AppState>) -> Result<Vec<LocalTrack>, String> {
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
fn local_remove(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    conn.execute("DELETE FROM local_tracks WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cache_list(state: State<'_, AppState>) -> Result<Vec<CacheEntry>, String> {
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn cache_lookup(state: State<'_, AppState>, key: String) -> Option<CacheEntry> {
    let conn = state.db.lock().ok()?;
    conn.query_row(
        "SELECT track_key,path,size,created_at FROM cache WHERE track_key=?1",
        params![key],
        |r| {
            Ok(CacheEntry {
                key: r.get(0)?,
                path: r.get(1)?,
                size: r.get(2)?,
                created_at: r.get(3)?,
            })
        },
    )
    .ok()
}

#[tauri::command]
async fn cache_download(
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
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
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
fn cache_delete(state: State<'_, AppState>, key: String) -> Result<(), String> {
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
fn cache_clear(state: State<'_, AppState>) -> Result<(), String> {
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

fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("flac") => "audio/flac",
        Some("m4a" | "aac") => "audio/mp4",
        Some("ogg" | "opus") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "audio/mpeg",
    }
}

fn file_response(request: &Request<Vec<u8>>, path: &std::path::Path) -> Response<Vec<u8>> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| {
            let mut parts = v.splitn(2, '-');
            let start = parts.next()?.parse::<u64>().ok()?;
            let end = parts
                .next()
                .filter(|s| !s.is_empty())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(len.saturating_sub(1));
            Some((start, end.min(len.saturating_sub(1))))
        });
    if let Some((start, end)) = range {
        if start > end || start >= len {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap();
        }
        let size = (end - start + 1) as usize;
        let mut buf = vec![0u8; size];
        let _ = file.seek(SeekFrom::Start(start));
        let _ = file.read_exact(&mut buf);
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime_for(path))
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, size.to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{len}"),
            )
            .body(buf)
            .unwrap();
    }
    let mut buf = Vec::with_capacity(len as usize);
    let _ = file.read_to_end(&mut buf);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_for(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string())
        .body(buf)
        .unwrap()
}

#[derive(Serialize)]
struct UpdateStatus {
    available: bool,
    current: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

fn updater_for(
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
async fn update_check(
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
async fn update_install(
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

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
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

fn logs_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("app.reel.desktop")
        .join("logs")
}

fn log_line(message: &str) {
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

fn init_logging() {
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("PANIC: {info}"));
    }));
    log_line("app started");
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn client_log(message: String) {
    log_line(&format!("frontend: {message}"));
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    let dir = logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn playback_save(state: State<'_, AppState>, data: String) -> Result<(), String> {
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
fn playback_load(state: State<'_, AppState>) -> Option<String> {
    let conn = state.db.lock().ok()?;
    conn.query_row("SELECT state FROM playback WHERE id=1", [], |r| r.get(0))
        .ok()
}

#[tauri::command]
fn cache_meta_set(state: State<'_, AppState>, key: String, json: String) -> Result<(), String> {
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
fn cache_meta_all(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
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
fn cache_cleanup(state: State<'_, AppState>) -> Result<i64, String> {
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
async fn github_profile(state: State<'_, AppState>) -> Result<Value, String> {
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
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    let conn = state.db.lock().map_err(|_| "db lock".to_string())?;
    db_set_setting(&conn, "close_to_tray", if enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())
}

fn main() {
    init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("reelcache", |ctx, request| {
            let app = ctx.app_handle();
            let state = app.state::<AppState>();
            let key = request
                .uri()
                .path()
                .trim_start_matches('/')
                .trim_end_matches(".mp3")
                .to_string();
            let path = {
                let conn = match state.db.lock() {
                    Ok(c) => c,
                    Err(_) => {
                        return Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Vec::new())
                            .unwrap()
                    }
                };
                conn.query_row(
                    "SELECT path FROM cache WHERE track_key=?1",
                    params![key],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .map(PathBuf::from)
            };
            match path {
                Some(p) if p.exists() => file_response(&request, &p),
                _ => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .register_uri_scheme_protocol("reelfile", |ctx, request| {
            let app = ctx.app_handle();
            let state = app.state::<AppState>();
            let id: i64 = request
                .uri()
                .path()
                .trim_start_matches('/')
                .trim_end_matches(".mp3")
                .parse()
                .unwrap_or(0);
            let path = {
                let Ok(conn) = state.db.lock() else {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Vec::new())
                        .unwrap();
                };
                conn.query_row(
                    "SELECT path FROM local_tracks WHERE id=?1",
                    params![id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .map(PathBuf::from)
            };
            match path {
                Some(p) if p.exists() => file_response(&request, &p),
                _ => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            if !dir.join("reel.db").exists() {
                if let Ok(appdata) = std::env::var("APPDATA") {
                    let old = PathBuf::from(appdata).join("dev.vkx.desktop");
                    if old.exists() && old.join("vkx.db").exists() {
                        let _ = copy_dir_all(&old, &dir);
                        let old_db = dir.join("vkx.db");
                        let new_db = dir.join("reel.db");
                        if old_db.exists() && !new_db.exists() {
                            let _ = std::fs::rename(old_db, new_db);
                        }
                        for suffix in ["-wal", "-shm"] {
                            let old_side = dir.join(format!("vkx.db{suffix}"));
                            let new_side = dir.join(format!("reel.db{suffix}"));
                            if old_side.exists() && !new_side.exists() {
                                let _ = std::fs::rename(old_side, new_side);
                            }
                        }
                    }
                }
            }
            std::fs::create_dir_all(&dir)?;
            let cache_dir = dir.join("cache");
            std::fs::create_dir_all(&cache_dir)?;
            let conn = Connection::open(dir.join("reel.db"))?;
            init_db(&conn)?;
            let http = reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(std::time::Duration::from_secs(30))
                .build()?;
            let close_to_tray = db_get_setting(&conn, "close_to_tray")
                .map(|v| v != "0")
                .unwrap_or(true);
            let start_minimized = db_get_setting(&conn, "start_minimized")
                .map(|v| v == "1")
                .unwrap_or(false);
            let minimized_arg = std::env::args().any(|a| a == "--minimized");
            app.manage(AppState {
                db: Mutex::new(conn),
                http,
                cache_dir,
                close_to_tray: AtomicBool::new(close_to_tray),
            });

            let show = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let play = MenuItem::with_id(app, "play", "Пауза / играть", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &play, &quit])?;
            let mut tray = TrayIconBuilder::with_id("reel-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "play" => {
                        let _ = app.emit("tray-play", ());
                    }
                    "quit" => {
                        let _ = app.emit("app-save", ());
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                if start_minimized || minimized_arg {
                    let _ = window.hide();
                }
                let w = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let close_to_tray = app_handle
                            .state::<AppState>()
                            .close_to_tray
                            .load(Ordering::Relaxed);
                        if close_to_tray {
                            let _ = app_handle.emit("app-save", ());
                            api.prevent_close();
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            web_token_from_cookies,
            web_token_probe,
            vk_login_window,
            vk_capture_cookies,
            vk_audio_method,
            catalog_get_audio,
            catalog_get_section,
            audio_search2,
            audio_add2,
            audio_delete2,
            vk_method,
            audio_get,
            audio_search,
            audio_playlists,
            audio_add,
            audio_delete,
            audio_get_by_id,
            lyrics,
            external_lyrics,
            account_info,
            auth_url,
            open_url,
            save_token,
            get_token,
            clear_token,
            settings_get,
            settings_set,
            settings_all,
            queue_save,
            queue_load,
            cache_list,
            cache_lookup,
            cache_download,
            cache_delete,
            cache_clear,
            scan_folder,
            local_tracks,
            local_remove,
            update_check,
            update_install,
            playback_save,
            playback_load,
            cache_meta_set,
            cache_meta_all,
            cache_cleanup,
            github_profile,
            autostart_set,
            autostart_get,
            set_close_to_tray,
            client_log,
            open_logs,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("reel-desktop failed to start");
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_oauth_fragment() {
        let t = parse_fragment(
            "https://oauth.vk.com/blank.html#access_token=abc1234567890&expires_in=3600&user_id=42",
        )
        .unwrap();
        assert_eq!(t.access_token, "abc1234567890");
        assert_eq!(t.user_id, Some(42));
        assert!(t.expires_at.unwrap() > now_ts());
    }

    #[test]
    fn parses_bare_token() {
        let t = parse_fragment("abcdefghijklmnopqrstuvwxyz").unwrap();
        assert_eq!(t.access_token, "abcdefghijklmnopqrstuvwxyz");
    }

    #[test]
    fn serves_range_and_full() {
        let dir = std::env::temp_dir().join("reel-test-range");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.mp3");
        std::fs::write(&path, b"0123456789").unwrap();
        let req = Request::builder()
            .header(header::RANGE, "bytes=2-4")
            .body(Vec::new())
            .unwrap();
        let r = file_response(&req, &path);
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().as_slice(), b"234");
        let full = file_response(&Request::builder().body(Vec::new()).unwrap(), &path);
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body().len(), 10);
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod local_tests {
    use super::*;

    #[test]
    fn splits_artist_title() {
        assert_eq!(split_name("Nirvana - Smells Like Teen Spirit"), ("Nirvana".to_string(), "Smells Like Teen Spirit".to_string()));
        assert_eq!(split_name("Untitled"), ("Неизвестный исполнитель".to_string(), "Untitled".to_string()));
    }

    #[test]
    fn walks_only_audio() {
        let dir = std::env::temp_dir().join("reel-test-scan");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(sub.join("b.FLAC"), b"x").unwrap();
        std::fs::write(dir.join("c.txt"), b"x").unwrap();
        let mut out = Vec::new();
        walk_audio(&dir, &mut out, 0);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| audio_ext(p)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
