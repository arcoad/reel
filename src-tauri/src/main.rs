#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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

// Reel backend modules
mod model;
mod db;
mod vk;
mod lyrics;
mod auth;
mod library;
mod net;
mod updater;
mod logging;
mod storage;
mod startup;

use model::*;
use db::*;
use vk::*;
use lyrics::*;
use auth::*;
use library::*;
use net::*;
use updater::*;
use logging::*;
use storage::*;
use startup::*;
fn main() {
    init_logging();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("reelstream", |ctx, request, responder| {
            let encoded = request.uri().path().trim_start_matches('/').to_string();
            let range = request
                .headers()
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string());
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                let target = URL_SAFE_NO_PAD
                    .decode(encoded.as_bytes())
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .and_then(|u| reqwest::Url::parse(&u).ok());
                let allowed = target
                    .as_ref()
                    .map(|u| {
                        u.scheme() == "https"
                            && u.host_str()
                                .map(|h| {
                                    let host = h.to_ascii_lowercase();
                                    ["vk.com", "vk.ru", "vkuser.net", "okcdn.ru", "userapi.com", "mycdn.me", "ok.ru"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
                                })
                                .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if !allowed {
                    let _ = responder.respond(
                        Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .header(header::CONTENT_TYPE, "text/plain")
                            .body(b"stream host is not allowed".to_vec())
                            .unwrap(),
                    );
                    return;
                }
                // Ответ буферизуется целиком, поэтому общий таймаут клиента (30 с) на трек слишком мал.
                let mut req = state
                    .http
                    .get(target.unwrap())
                    .timeout(std::time::Duration::from_secs(180))
                    .header(header::USER_AGENT, USER_AGENT);
                if let Some(range) = range {
                    req = req.header(header::RANGE, range);
                }
                match req.send().await {
                    Ok(resp) => {
                        let status = resp.status();
                        let content_type = resp
                            .headers()
                            .get(header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("audio/mpeg")
                            .to_string();
                        let content_range = resp
                            .headers()
                            .get(header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .map(|v| v.to_string());
                        let bytes = match resp.bytes().await {
                            Ok(b) => b,
                            Err(_) => {
                                let _ = responder.respond(
                                    Response::builder()
                                        .status(StatusCode::BAD_GATEWAY)
                                        .body(Vec::new())
                                        .unwrap(),
                                );
                                return;
                            }
                        };
                        let mut builder = Response::builder()
                            .status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY))
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Accept-Ranges")
                            .header(header::ACCEPT_RANGES, "bytes")
                            .header(header::CONTENT_TYPE, content_type)
                            .header(header::CONTENT_LENGTH, bytes.len().to_string());
                        if let Some(cr) = content_range {
                            builder = builder.header(header::CONTENT_RANGE, cr);
                        }
                        let _ = responder.respond(builder.body(bytes.to_vec()).unwrap());
                    }
                    Err(_) => {
                        let _ = responder.respond(
                            Response::builder()
                                .status(StatusCode::BAD_GATEWAY)
                                .header(header::CONTENT_TYPE, "text/plain")
                                .body(b"stream request failed".to_vec())
                                .unwrap(),
                        );
                    }
                }
            });
        })
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
            vk_login_window,
            vk_capture_cookies,
            catalog_get_audio,
            catalog_get_section,
            audio_search2,
            audio_add2,
            audio_delete2,
            audio_dislike,
            catalog_artist,
            audio_album,
            audio_by_id,
            stream_mix_audios,
            lyrics,
            external_lyrics,
            account_info,
            auth_url,
            open_url,
            save_token,
            get_token,
            clear_token,
            settings_set,
            settings_all,
            cache_list,
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
            open_logs,
            app_version
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        // GUI-сборка без консоли: молчаливый exit 101 выглядел как «программа не открывается».
        let message = format!("{err}");
        log_line(&format!("startup failed: {message}"));
        let dir = logs_dir();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("panic.log"), format!("[{}] START FAILED: {message}\n", now_ts()));
        show_startup_error(&message);
        std::process::exit(1);
    }
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
