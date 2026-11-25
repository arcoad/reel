// Reel backend — net
#![allow(unused_imports)]
use crate::*;

pub(crate) fn mime_for(path: &std::path::Path) -> &'static str {
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

pub(crate) fn file_response(request: &Request<Vec<u8>>, path: &std::path::Path) -> Response<Vec<u8>> {
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
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Accept-Ranges")
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
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Accept-Ranges")
        .header(header::CONTENT_TYPE, mime_for(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string())
        .body(buf)
        .unwrap()
}
