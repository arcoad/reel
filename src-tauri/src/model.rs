// Reel backend — model
#![allow(unused_imports)]
use crate::*;

pub(crate) const API_VERSION: &str = "5.272";
pub(crate) const USER_AGENT: &str = "Reel/1.1.0 (+https://github.com/arcoad/reel)";
pub(crate) const LYRICS_UA: &str = "Reel (https://github.com/arcoad/reel)";
pub(crate) const DEFAULT_CLIENT_ID: &str = "2685278";
pub(crate) const AUDIO_CLIENT_ID: &str = "6287487";
pub(crate) const AUDIO_API: &str = "https://api.vk.ru/method/";
pub(crate) const MOBILE_UA: &str = "VKAndroidApp/4.13.1-1206 (Android 4.4.3; SDK 19; armeabi; ; ru)";
pub(crate) const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0";

pub(crate) struct AppState {
    pub(crate) db: Mutex<Connection>,
    pub(crate) http: reqwest::Client,
    pub(crate) cache_dir: PathBuf,
    pub(crate) close_to_tray: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct TokenInfo {
    pub(crate) access_token: String,
    pub(crate) user_id: Option<i64>,
    pub(crate) expires_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct CacheEntry {
    pub(crate) key: String,
    pub(crate) path: String,
    pub(crate) size: i64,
    pub(crate) created_at: i64,
}

pub(crate) fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
