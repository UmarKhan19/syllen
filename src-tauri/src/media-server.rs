//! Loopback HTTP playback, including the byte-range requests used for seeking.

use std::{
    fs::File,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use http_range::HttpRange;

const MEDIA_ROUTE: &str = "/audio";

/// WebKitGTK cannot play media from a custom URI scheme, so serve one current
/// audio path over loopback HTTP.
pub(super) struct MediaServer {
    pub(super) port: u16,
    current: Arc<Mutex<Option<(PathBuf, String)>>>,
}

impl MediaServer {
    pub(super) fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let current = Arc::new(Mutex::new(None));
        let files = Arc::clone(&current);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let files = Arc::clone(&files);
                std::thread::spawn(move || {
                    let _ = serve_media(stream, &files);
                });
            }
        });
        Ok(Self { port, current })
    }

    pub(super) fn serve(&self, path: &Path, _job: &str) -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("OS random source unavailable");
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if let Ok(mut current) = self.current.lock() {
            *current = Some((path.to_path_buf(), token.clone()));
        }
        format!("http://127.0.0.1:{}{MEDIA_ROUTE}?token={token}", self.port)
    }
}

fn serve_media(
    mut stream: TcpStream,
    files: &Mutex<Option<(PathBuf, String)>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;

    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while head.len() < 16 * 1024 {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let head = String::from_utf8_lossy(&head);
    let mut lines = head.lines();
    let Some(request) = lines.next() else {
        return write_error(&mut stream, 400, "Bad request", None);
    };
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if target.split('?').next().unwrap_or_default() != MEDIA_ROUTE {
        return write_error(&mut stream, 404, "Not found", None);
    }
    if method != "GET" && method != "HEAD" {
        return write_error(&mut stream, 405, "Method not allowed", None);
    }

    let (host, origin) = match security_headers(head.lines().skip(1)) {
        Ok(headers) => headers,
        Err(()) => return write_error(&mut stream, 400, "Bad request", None),
    };
    let expected_host = format!("127.0.0.1:{}", stream.local_addr()?.port());
    if host != expected_host
        || origin.is_some_and(|value| value != format!("http://{expected_host}"))
    {
        return write_error(&mut stream, 403, "Forbidden", None);
    }
    let supplied = target.strip_prefix("/audio?token=");
    let current = files.lock().ok().and_then(|current| current.clone());
    let Some((path, token)) = current else {
        return write_error(&mut stream, 404, "No audio for this job", None);
    };
    if supplied != Some(token.as_str()) {
        return write_error(&mut stream, 403, "Forbidden", None);
    }
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("media server: could not open {}: {error}", path.display());
            return write_error(&mut stream, 404, "Audio file missing", None);
        }
    };
    let len = file.metadata()?.len();
    if len == 0 {
        return write_error(&mut stream, 404, "Audio file is empty", None);
    }

    let mut range_header = None;
    for line in head.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("range")
        {
            range_header = Some(value.trim());
        }
    }

    let (status, start, end) = match range_header {
        None => ("200 OK", 0, len - 1),
        Some(header) => match HttpRange::parse(header, len) {
            Ok(ranges) if ranges.len() == 1 => {
                let range = ranges[0];
                (
                    "206 Partial Content",
                    range.start,
                    (range.start + range.length - 1).min(len - 1),
                )
            }
            _ => {
                return write_error(
                    &mut stream,
                    416,
                    "Range not satisfiable",
                    Some(&format!("bytes */{len}")),
                );
            }
        },
    };

    let mut response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: audio/wav\r\n\
         Accept-Ranges: bytes\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n",
        end + 1 - start
    );
    if status.starts_with("206") {
        response.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes())?;
    if method == "HEAD" {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))?;
    let mut writer = BufWriter::new(stream);
    std::io::copy(&mut file.take(end + 1 - start), &mut writer)?;
    writer.flush()
}

fn security_headers<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> Result<(String, Option<String>), ()> {
    let (mut host, mut origin) = (None, None);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value.trim().to_string()).is_some() {
                return Err(());
            }
        } else if name.eq_ignore_ascii_case("origin")
            && origin.replace(value.trim().to_string()).is_some()
        {
            return Err(());
        }
    }
    host.map(|host| (host, origin)).ok_or(())
}

fn write_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
    content_range: Option<&str>,
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status} {message}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n",
        message.len()
    );
    if let Some(range) = content_range {
        response.push_str(&format!("Content-Range: {range}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(message);
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::TcpStream,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn wav_bytes(samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "yt-transcript-media-{}-{}.tmp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn media_server_serves_byte_ranges() {
        let bytes = wav_bytes(&[1i16; 50]);
        let path = temp_path();
        std::fs::write(&path, &bytes).unwrap();
        let server = MediaServer::start().unwrap();
        let url = server.serve(&path, "test-job");
        let target = url
            .split("127.0.0.1:")
            .nth(1)
            .unwrap()
            .split_once('/')
            .unwrap()
            .1;
        let host = format!("127.0.0.1:{}", server.port);
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                format!("GET /{target} HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nRange: bytes=10-19\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&response[..split]);
        assert!(head.starts_with("HTTP/1.1 206"));
        assert!(head.contains("Content-Range: bytes 10-19/"));
        assert_eq!(&response[split + 4..], &bytes[10..20]);

        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                format!("GET /{target} HTTP/1.1\r\nHost: {host}\r\nRange: bytes=0-\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let _ = std::fs::remove_file(&path);
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&response[..split]);
        assert!(head.starts_with("HTTP/1.1 206"));
        assert!(head.contains(&format!(
            "Content-Range: bytes 0-{}/{}",
            bytes.len() - 1,
            bytes.len()
        )));
        assert_eq!(&response[split + 4..], bytes.as_slice());
    }

    #[test]
    fn media_requires_token_and_same_origin_host_and_invalidates_old_tokens() {
        let path = temp_path();
        std::fs::write(&path, wav_bytes(&[1, 2])).unwrap();
        let server = MediaServer::start().unwrap();
        let old_url = server.serve(&path, "old");
        let old_target = old_url
            .split("127.0.0.1:")
            .nth(1)
            .unwrap()
            .split_once('/')
            .unwrap()
            .1;
        let new_url = server.serve(&path, "new");
        let new_target = new_url
            .split("127.0.0.1:")
            .nth(1)
            .unwrap()
            .split_once('/')
            .unwrap()
            .1;
        for (target, host, origin, expected) in [
            ("/audio", format!("127.0.0.1:{}", server.port), None, "403"),
            (new_target, "attacker.example".into(), None, "403"),
            (
                new_target,
                format!("127.0.0.1:{}", server.port),
                Some("http://evil.example"),
                "403",
            ),
            (
                old_target,
                format!("127.0.0.1:{}", server.port),
                None,
                "403",
            ),
        ] {
            let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let origin = origin.map_or(String::new(), |value| format!("Origin: {value}\r\n"));
            let target = if target.starts_with('/') {
                target.to_string()
            } else {
                format!("/{target}")
            };
            write!(
                stream,
                "GET {target} HTTP/1.1\r\nHost: {host}\r\n{origin}\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with(&format!("HTTP/1.1 {expected}")));
        }

        for headers in [
            vec!["Host: evil.example", "Host: valid.example"],
            vec!["Host: valid.example", "Host: evil.example"],
            vec!["Host: valid.example", "Origin: http://evil", "Origin: null"],
        ] {
            assert!(security_headers(headers.into_iter()).is_err());
        }
        let host = "127.0.0.1:1234";
        assert_eq!(
            security_headers(["Host: 127.0.0.1:1234", "Origin: http://127.0.0.1:1234"].into_iter()),
            Ok((host.into(), Some(format!("http://{host}"))))
        );
        std::fs::remove_file(path).unwrap();
    }
}
