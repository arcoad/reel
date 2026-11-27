// Reel backend — lyrics
#![allow(unused_imports)]
use crate::*;
use std::future::Future;

pub(crate) fn non_empty(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub(crate) fn lrclib_prefer(body: &Value, synced_only: bool) -> Option<String> {
    non_empty(body.get("syncedLyrics").and_then(|v| v.as_str())).or_else(|| {
        if synced_only {
            None
        } else {
            non_empty(body.get("plainLyrics").and_then(|v| v.as_str()))
        }
    })
}

pub(crate) async fn lrclib_get(
    http: &reqwest::Client,
    artist: &str,
    title: &str,
    duration: Option<i64>,
) -> Option<String> {
    let mut params = vec![("artist_name", artist), ("track_name", title)];
    let duration_buf;
    if let Some(seconds) = duration {
        duration_buf = seconds.to_string();
        params.push(("duration", duration_buf.as_str()));
    }
    let response = http
        .get("https://lrclib.net/api/get")
        .query(&params)
        .header(reqwest::header::USER_AGENT, LYRICS_UA)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    lrclib_prefer(&body, false)
}

fn normalize_lyrics_title(title: &str) -> String {
    let lowered = title.to_lowercase();
    let mut out = lowered;
    for marker in [" mylancore", " mylan core", " prod.", " prod ", " (prod", " speed up", " slowed", " remix"] {
        if let Some(pos) = out.find(marker) {
            out.truncate(pos);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn lyrics_score(row: &Value, artist: &str, title: &str, duration: Option<i64>) -> i64 {
    let row_artist = row.get("artistName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let row_title = normalize_lyrics_title(row.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));
    let want_artist = artist.to_lowercase();
    let want_title = normalize_lyrics_title(title);
    let mut score = 0;
    if !row_artist.is_empty() && (row_artist.contains(&want_artist) || want_artist.contains(&row_artist)) {
        score += 4;
    }
    if !row_title.is_empty() && row_title == want_title {
        score += 4;
    } else if !row_title.is_empty() && (row_title.contains(&want_title) || want_title.contains(&row_title)) {
        score += 2;
    }
    if let Some(seconds) = duration {
        if let Some(d) = row.get("duration").and_then(|v| v.as_f64()) {
            let diff = (d - seconds as f64).abs();
            if diff <= 2.0 {
                score += 3;
            } else if diff <= 6.0 {
                score += 1;
            }
        }
    }
    if row.get("syncedLyrics").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
        score += 1;
    }
    score
}

pub(crate) async fn lrclib_search(
    http: &reqwest::Client,
    artist: &str,
    title: &str,
    duration: Option<i64>,
) -> Option<String> {
    let response = http
        .get("https://lrclib.net/api/search")
        .query(&[("q", format!("{artist} {title}").as_str())])
        .header(reqwest::header::USER_AGENT, LYRICS_UA)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let rows: Value = response.json().await.ok()?;
    let rows = rows.as_array()?;
    let best = rows.iter().map(|row| (lyrics_score(row, artist, title, duration), row)).max_by_key(|(score, _)| *score)?;
    if best.0 <= 0 {
        return None;
    }
    log_line(&format!("lyrics: lrclib pick score {} for {artist} - {title}", best.0));
    lrclib_prefer(best.1, false)
}

pub(crate) async fn resolve_external_lyrics(
    _http: &reqwest::Client,
    artist: &str,
    title: &str,
    duration: Option<i64>,
) -> Option<String> {
    // Внешние источники могут отвечать очень долго: ограничиваем каждый запрос 3 с
    // и запускаем их одновременно. Худший случай ~3 с вместо 4 x 30 с.
    let fast = reqwest::Client::builder()
        .no_proxy()
        .user_agent(LYRICS_UA)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let tasks: Vec<_> = vec![
        Box::pin(lrclib_search(&fast, artist, title, duration))
            as std::pin::Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>,
        Box::pin(lrclib_get(&fast, artist, title, duration)),
    ]
    .into_iter()
    .map(|f| {
        Box::pin(async move { f.await.ok_or(()) })
            as std::pin::Pin<Box<dyn Future<Output = Result<String, ()>> + Send + '_>>
    })
    .collect::<Vec<_>>();
    let result = match futures_util::future::select_ok(tasks).await {
        Ok((text, _)) => {
            log_line(&format!("lyrics: external hit for {artist} - {title}"));
            Some(text)
        }
        Err(_) => {
            log_line(&format!("lyrics: no provider matched {artist} - {title}"));
            None
        }
    };
    result
}

#[tauri::command]
pub(crate) async fn external_lyrics(
    state: State<'_, AppState>,
    artist: String,
    title: String,
    duration: Option<i64>,
) -> Result<Option<String>, String> {
    let artist = artist.trim();
    let title = title.trim();
    if artist.is_empty() || title.is_empty() {
        return Ok(None);
    }
    Ok(resolve_external_lyrics(&state.http, artist, title, duration).await)
}
