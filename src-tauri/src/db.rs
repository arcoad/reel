// Reel backend — db
#![allow(unused_imports)]
use crate::*;

pub(crate) fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
          PRAGMA wal_autocheckpoint=1000;
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

pub(crate) fn db_get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0))
        .ok()
}

pub(crate) fn db_set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub(crate) fn db_token(conn: &Connection) -> Option<TokenInfo> {
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

pub(crate) fn require_token(conn: &Connection) -> Result<TokenInfo, String> {
    db_token(conn).ok_or_else(|| "Не авторизован: добавь access_token в настройках".to_string())
}

pub(crate) fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
