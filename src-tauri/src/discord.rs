// Reel backend — Discord Rich Presence
#![allow(unused_imports)]
use crate::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, GetLastError, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, ReadFile, WriteFile,
};
#[cfg(windows)]
use windows_sys::Win32::System::Pipes::{NMPWAIT_WAIT_FOREVER, WaitNamedPipeW};

pub(crate) const DISCORD_APP_ID: &str = "1575828210954936332";
const PIPE_TEMPLATE: &str = r"\\.\pipe\discord-ipc-";

pub(crate) struct DiscordPresence {
    tx: Option<Sender<Presence>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Clone)]
pub(crate) struct Presence {
    pub(crate) details: String,
    pub(crate) state: String,
    pub(crate) cover: String,
    pub(crate) started_at: u64,
    pub(crate) end_at: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DiscordPresence {
    pub(crate) fn new() -> Self {
        Self { tx: None, stop: Arc::new(AtomicBool::new(false)), thread: None }
    }

    pub(crate) fn start(&mut self) -> Result<(), String> {
        if self.tx.is_some() && !self.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let (tx, rx) = channel::<Presence>();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let handle = std::thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || run(rx, thread_stop))
            .map_err(|e| e.to_string())?;
        log_line("discord: presence thread started");
        self.tx = Some(tx);
        self.stop = stop;
        self.thread = Some(handle);
        Ok(())
    }

    pub(crate) fn stop(&mut self) {
        self.tx = None;
        self.thread = None;
        self.stop.store(true, Ordering::SeqCst);
    }

    pub(crate) fn update(&self, presence: Presence) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(presence);
        }
    }
}

impl Drop for DiscordPresence {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(rx: Receiver<Presence>, stop: Arc<AtomicBool>) {
    let mut last: Option<Presence> = None;
    let mut last_sent = 0;
    while !stop.load(Ordering::SeqCst) {
        let mut conn = match Connection::open() {
            Some(conn) => conn,
            None => {
                log_line("discord: pipe not ready, retrying");
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
        };
        conn.handshake();
        log_line(&format!("discord: handshake alive={}", conn.alive));
        if !conn.alive {
            conn.close();
            let _ = rx.recv_timeout(Duration::from_secs(5));
            continue;
        }
        let mut pending: Option<Presence> = None;
        loop {
            if stop.load(Ordering::SeqCst) {
                conn.close();
                return;
            }
            match rx.try_recv() {
                Ok(presence) => pending = Some(presence),
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    conn.close();
                    return;
                }
            }
            if let Some(presence) = pending.take() {
                if conn.alive {
                    conn.set_activity(&presence);
                    last_sent = now_ms();
                }
                let empty = presence.details.is_empty() && presence.state.is_empty();
                last = if empty { None } else { Some(presence) };
            }
            if !conn.alive {
                conn.close();
                break;
            }
            if let Some(presence) = &last {
                if now_ms() - last_sent >= 15_000 {
                    conn.set_activity(presence);
                    last_sent = now_ms();
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        last = None;
    }
}

struct Connection {
    handle: usize,
    alive: bool,
    nonce: u64,
    buf: Vec<u8>,
}

impl Connection {
    fn open() -> Option<Self> {
        let handle = open_pipe(&format!("{PIPE_TEMPLATE}0"))?;
        Some(Self { handle, alive: true, nonce: 0, buf: Vec::new() })
    }

    fn send(&mut self, opcode: u32, payload: &Value) -> bool {
        let body = serde_json::to_vec(payload).ok();
        let Some(body) = body else { return false };
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&opcode.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        write_all(self.handle, &frame)
    }

    fn pump(&mut self) {
        let mut chunk = [0u8; 8192];
        loop {
            match read_some(self.handle, &mut chunk, 200) {
                ReadResult::Data(0) => return,
                ReadResult::Data(n) => self.buf.extend_from_slice(&chunk[..n]),
                ReadResult::Timeout => return,
                ReadResult::Closed => {
                    self.alive = false;
                    return;
                }
            }
        }
    }

    fn next_frame(&mut self, deadline: u64) -> Option<(u32, Value)> {
        loop {
            if self.buf.len() >= 8 {
                let opcode = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
                let length = u32::from_le_bytes([self.buf[4], self.buf[5], self.buf[6], self.buf[7]]) as usize;
                if length > 1 << 20 {
                    self.alive = false;
                    return None;
                }
                if self.buf.len() >= 8 + length {
                    let body = self.buf[8..8 + length].to_vec();
                    self.buf.drain(..8 + length);
                    let value = serde_json::from_slice(&body).ok()?;
                    return Some((opcode, value));
                }
            }
            if now_ms() >= deadline {
                return None;
            }
            self.pump();
            if !self.alive {
                return None;
            }
        }
    }

    fn read(&mut self, timeout_ms: u64) -> Option<(u32, Value)> {
        self.next_frame(now_ms() + timeout_ms)
    }


    fn handshake(&mut self) {
        self.nonce += 1;
        let payload = json!({"v": 1, "client_id": DISCORD_APP_ID});
        let sent = self.send(0, &payload);
        let _ = sent;
        if !sent {
            self.alive = false;
            return;
        }
        match self.read(5_000) {
            Some((1, value)) if value.get("evt").and_then(|v| v.as_str()) == Some("READY") => {}
            Some((_, value)) => {
                log_line(&format!("discord: handshake rejected: {value}"));
                self.alive = false;
            }
            None => {
                        self.alive = false;
            }
        }
    }

    fn set_activity(&mut self, presence: &Presence) {
        self.nonce += 1;
        let activity = activity_payload(presence);
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {"pid": std::process::id(), "activity": activity},
            "nonce": self.nonce.to_string(),
        });
        if !self.send(1, &payload) {
            log_line("discord: SET_ACTIVITY write failed");
            self.alive = false;
            return;
        }
        self.pump();
    }

    fn close(&mut self) {
        if self.handle != 0 {
            self.nonce += 1;
            let _ = self.send(2, &json!({"nonce": self.nonce.to_string()}));
            close_pipe(self.handle);
            self.handle = 0;
        }
        self.alive = false;
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}

fn activity_payload(presence: &Presence) -> Value {
    if presence.details.is_empty() && presence.state.is_empty() {
        return Value::Null;
    }
    let mut assets = Map::new();
    if !presence.cover.is_empty() {
        assets.insert("large_image".into(), json!(presence.cover.clone()));
        assets.insert("large_text".into(), json!("Reel"));
    }
    let mut timestamps = Map::new();
    timestamps.insert("start".into(), json!(presence.started_at));
    if let Some(end) = presence.end_at.filter(|end| *end > presence.started_at) {
        timestamps.insert("end".into(), json!(end));
    }
    json!({
        "type": 2,
        "details": presence.details,
        "state": presence.state,
        "timestamps": Value::Object(timestamps),
        "assets": Value::Object(assets),
        "buttons": [{"label": "GitHub", "url": "https://github.com/arcoad/reel"}],
    })
}

#[cfg(windows)]
fn open_pipe(_path: &str) -> Option<usize> {
    use std::os::windows::ffi::OsStrExt;
    let mut first: Option<usize> = None;
    for index in 0..10 {
        let slot = format!("{PIPE_TEMPLATE}{index}");
        let wide: Vec<u16> = std::ffi::OsStr::new(&slot).encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                3,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            continue;
        }
        if first.is_none() {
            first = Some(handle as usize);
        } else {
            unsafe { CloseHandle(handle) };
        }
    }
    first
}

#[cfg(windows)]
fn write_all(handle: usize, data: &[u8]) -> bool {
    let mut written: u32 = 0;
    let mut offset = 0;
    while offset < data.len() {
        let ok = unsafe {
            WriteFile(
                handle as _,
                data[offset..].as_ptr(),
                (data.len() - offset) as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return false;
        }
        offset += written as usize;
        if written == 0 {
            return false;
        }
    }
    true
}

enum ReadResult {
    Data(usize),
    Timeout,
    Closed,
}

fn read_some(handle: usize, buf: &mut [u8], _timeout_ms: u32) -> ReadResult {
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let mut available: u32 = 0;
    let ok = unsafe {
        PeekNamedPipe(
            handle as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return ReadResult::Closed;
    }
    if available == 0 {
        return ReadResult::Timeout;
    }
    let mut read: u32 = 0;
    let want = buf.len().min(available as usize) as u32;
    let ok = unsafe {
        ReadFile(
            handle as _,
            buf.as_mut_ptr(),
            want,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || read == 0 {
        return ReadResult::Timeout;
    }
    ReadResult::Data(read as usize)
}

#[cfg(windows)]
fn close_pipe(handle: usize) {
    unsafe { CloseHandle(handle as _) };
}

#[cfg(not(windows))]
fn close_pipe(_handle: usize) {}

#[tauri::command]
pub(crate) fn discord_presence_start(state: State<'_, AppState>) -> Result<bool, String> {
    let mut presence = state.discord.lock().map_err(|_| "db lock".to_string())?;
    presence.start()?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn discord_presence_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut presence = state.discord.lock().map_err(|_| "db lock".to_string())?;
    presence.stop();
    Ok(())
}

#[tauri::command]
pub(crate) fn discord_presence_update(
    state: State<'_, AppState>,
    details: String,
    status: String,
    cover: String,
    started_at: u64,
    duration: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.discord.lock().map_err(|_| "db lock".to_string())?;
    if guard.tx.is_none() {
        guard.start()?;
    }
    let presence = guard;
    let now = now_ms();
    let started_at = started_at.min(now);
    let end_at = duration
        .filter(|d| *d > 0)
        .map(|d| now.saturating_add(d.saturating_mul(1000)));
    presence.update(Presence { details, state: status, cover, started_at, end_at });
    Ok(())
}

#[tauri::command]
pub(crate) fn discord_presence_clear(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.discord.lock().map_err(|_| "db lock".to_string())?;
    let presence = guard;
    presence.update(Presence {
        details: String::new(),
        state: String::new(),
        cover: String::new(),
        started_at: 0,
        end_at: None,
    });
    Ok(())
}