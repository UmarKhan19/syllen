use http_range::HttpRange;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const DAL_APP_ID: &str = "app.yttranscript.desktop";
const MEDIA_ROUTE: &str = "/audio";
// Keep in step with MEDIA_EXTENSIONS in src/App.tsx.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "wmv", "flv", "ts", "m2ts", "3gp",
    "3g2", "ogv", "mp3", "m4a", "m4b", "wav", "flac", "ogg", "oga", "opus", "aac", "wma", "aiff",
    "aif", "amr", "au", "caf", "ac3",
];

#[derive(Clone, Default)]
struct JobControl {
    child: Arc<Mutex<Option<Child>>>,
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

struct AppState {
    control: JobControl,
    media: Option<MediaServer>,
    library: Option<Library>,
}

/// Transcripts and their audio live in the app data folder, not the job cache.
/// One SQLite connection guarded by a mutex; jobs write at the end, the UI
/// reads and deletes from the library.
struct Library {
    conn: Mutex<Connection>,
    audio_dir: PathBuf,
}

impl Library {
    fn open(app: &AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data directory: {e}"))?;
        Self::open_at(data.join("library.db"), data.join("library"))
    }

    fn open_at(database: PathBuf, audio_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&audio_dir)
            .map_err(|e| format!("Could not create {}: {e}", audio_dir.display()))?;
        let conn = Connection::open(&database)
            .map_err(|e| format!("Could not open the transcript library: {e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("Could not configure the transcript library: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS transcripts (
                 id            TEXT PRIMARY KEY,
                 title         TEXT NOT NULL,
                 source_kind   TEXT NOT NULL,
                 created_at    INTEGER NOT NULL,
                 duration      REAL,
                 text          TEXT NOT NULL,
                 words         TEXT NOT NULL,
                 word_count    INTEGER NOT NULL,
                 segments      TEXT,
                 speaker_count INTEGER,
                 speaker_names TEXT NOT NULL DEFAULT '{}',
                 waveform      BLOB NOT NULL,
                 audio_file    TEXT NOT NULL,
                 audio_bytes   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS transcripts_created
                 ON transcripts (created_at DESC);",
        )
        .map_err(|e| format!("Could not prepare the transcript library: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            audio_dir,
        })
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "The transcript library is unavailable.".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    fn save(
        &self,
        id: &str,
        title: &str,
        source_kind: &str,
        duration: Option<f64>,
        text: &str,
        words: &[Word],
        waveform: &[u8],
        audio_file: &str,
        audio_bytes: u64,
    ) -> Result<(), String> {
        let words_json =
            serde_json::to_string(words).map_err(|e| format!("Could not save the words: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO transcripts
                 (id, title, source_kind, created_at, duration, text, words,
                  word_count, waveform, audio_file, audio_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                title,
                source_kind,
                now_millis() as i64,
                duration,
                text,
                words_json,
                words.len() as i64,
                waveform,
                audio_file,
                audio_bytes as i64,
            ],
        )
        .map_err(|e| format!("Could not save the transcript: {e}"))?;
        Ok(())
    }

    fn list(&self) -> Result<Vec<LibraryItem>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id, title, created_at, duration, word_count,
                        speaker_count, audio_bytes
                 FROM transcripts
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Could not read the library: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    duration: row.get(3)?,
                    word_count: row.get(4)?,
                    speaker_count: row.get(5)?,
                    audio_bytes: row.get(6)?,
                })
            })
            .map_err(|e| format!("Could not read the library: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Could not read the library: {e}"))
    }

    fn get(&self, id: &str) -> Result<SavedTranscript, String> {
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT id, title, created_at, duration, text, words, segments,
                        speaker_count, speaker_names, waveform, audio_file
                 FROM transcripts WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<f64>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Vec<u8>>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("Could not read that transcript: {e}"))?;
        let Some((
            id,
            title,
            created_at,
            duration,
            text,
            words,
            segments,
            speaker_count,
            speaker_names,
            waveform,
            audio_file,
        )) = row
        else {
            return Err("That transcript is no longer in the library.".into());
        };
        let words: Vec<Word> = serde_json::from_str(&words)
            .map_err(|e| format!("The saved words are unreadable: {e}"))?;
        let segments: Option<Vec<Segment>> = segments
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| format!("The saved speaker labels are unreadable: {e}"))?;
        let speaker_names: HashMap<String, String> =
            serde_json::from_str(&speaker_names).unwrap_or_default();
        Ok(SavedTranscript {
            id,
            title,
            created_at,
            duration,
            audio_path: self
                .audio_dir
                .join(audio_file)
                .to_string_lossy()
                .into_owned(),
            audio_url: String::new(),
            waveform,
            text,
            words,
            segments,
            speaker_count: speaker_count.map(|value| value as u32),
            speaker_names,
        })
    }

    fn update_analysis(
        &self,
        id: &str,
        segments: &[Segment],
        speaker_count: Option<u32>,
    ) -> Result<(), String> {
        let segments = serde_json::to_string(segments)
            .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE transcripts SET segments = ?2, speaker_count = ?3 WHERE id = ?1",
            params![id, segments, speaker_count.map(|value| value as i64)],
        )
        .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        Ok(())
    }

    fn update_speaker_names(
        &self,
        id: &str,
        names: &HashMap<String, String>,
    ) -> Result<(), String> {
        let names = serde_json::to_string(names)
            .map_err(|e| format!("Could not save the speaker names: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE transcripts SET speaker_names = ?2 WHERE id = ?1",
            params![id, names],
        )
        .map_err(|e| format!("Could not save the speaker names: {e}"))?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let audio_file: Option<String> = {
            let conn = self.conn()?;
            conn.query_row(
                "SELECT audio_file FROM transcripts WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Could not read that transcript: {e}"))?
        };
        let Some(audio_file) = audio_file else {
            return Err("That transcript is no longer in the library.".into());
        };
        match std::fs::remove_file(self.audio_dir.join(audio_file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete the audio file: {error}")),
        }
        let conn = self.conn()?;
        conn.execute("DELETE FROM transcripts WHERE id = ?1", [id])
            .map_err(|e| format!("Could not delete the transcript: {e}"))?;
        Ok(())
    }
}

/// WebKitGTK refuses to play media from custom URI schemes, so the audio is
/// served over loopback HTTP with byte ranges. One fixed path, loopback only.
struct MediaServer {
    port: u16,
    current: Arc<Mutex<Option<PathBuf>>>,
}

impl MediaServer {
    fn start() -> std::io::Result<Self> {
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

    fn serve(&self, path: &Path, job: &str) -> String {
        if let Ok(mut current) = self.current.lock() {
            *current = Some(path.to_path_buf());
        }
        format!("http://127.0.0.1:{}{MEDIA_ROUTE}?{job}", self.port)
    }
}

fn serve_media(mut stream: TcpStream, files: &Mutex<Option<PathBuf>>) -> std::io::Result<()> {
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

    let path = files.lock().ok().and_then(|current| current.clone());
    let Some(path) = path else {
        return write_error(&mut stream, 404, "No audio for this job", None);
    };
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Word {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job_id: String,
    stage: String,
    percent: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobResult {
    job_id: String,
    title: String,
    duration: Option<f64>,
    audio_path: String,
    audio_url: String,
    waveform: Vec<u8>,
    text: String,
    words: Vec<Word>,
    saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItem {
    id: String,
    title: String,
    created_at: i64,
    duration: Option<f64>,
    word_count: i64,
    speaker_count: Option<i64>,
    audio_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedTranscript {
    id: String,
    title: String,
    created_at: i64,
    duration: Option<f64>,
    audio_path: String,
    audio_url: String,
    waveform: Vec<u8>,
    text: String,
    words: Vec<Word>,
    segments: Option<Vec<Segment>>,
    speaker_count: Option<u32>,
    speaker_names: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Segment {
    speaker: Option<u32>,
    start: f64,
    end: f64,
    text: String,
    words: Vec<Word>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    job_id: String,
    message: String,
}

#[derive(Serialize)]
struct JobStarted {
    job_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo {
    name: String,
    size: u64,
}

enum Source {
    Url(String),
    File(PathBuf),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsStatus {
    yt_dlp: bool,
    yt_dlp_version: Option<String>,
    ffmpeg: bool,
    ffprobe: bool,
    node: bool,
    sidecar: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    ok: bool,
    message: String,
    version: Option<String>,
}

struct Tools {
    node: PathBuf,
    yt_dlp: PathBuf,
    ffmpeg: PathBuf,
    sidecar: PathBuf,
}

#[derive(Deserialize)]
struct SidecarEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    fraction: Option<f64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    words: Option<Vec<Word>>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    message: Option<String>,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, percent: Option<f64>) {
    let _ = app.emit(
        "job:progress",
        ProgressEvent {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            percent: percent.map(|p| p.clamp(0.0, 1.0)),
        },
    );
}

fn emit_error(app: &AppHandle, job_id: &str, message: &str) {
    let _ = app.emit(
        "job:error",
        ErrorEvent {
            job_id: job_id.to_string(),
            message: message.to_string(),
        },
    );
}

fn check_cancel(control: &JobControl) -> Result<(), String> {
    if control.cancel.load(Ordering::SeqCst) {
        Err("Cancelled".into())
    } else {
        Ok(())
    }
}

fn tail(lines: &[String]) -> String {
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n").trim().to_string()
}

fn configure(cmd: &mut Command) {
    cmd.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

fn prepend_tool_path(cmd: &mut Command, tools: &Tools) {
    let Some(dir) = tools
        .ffmpeg
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return;
    };
    let probe = if cfg!(windows) {
        dir.join("ffprobe.exe")
    } else {
        dir.join("ffprobe")
    };
    if !probe.is_file() {
        return;
    }
    let current: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Ok(joined) = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(current)) {
        cmd.env("PATH", joined);
    }
}

fn version_of(program: &Path) -> Option<String> {
    Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|version| !version.is_empty())
}

fn spawn_error(program: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!(
            "{} not found. Install it, or bundle it in the app's resources/bin folder.",
            program.display()
        )
    } else {
        format!("Could not run {}: {error}", program.display())
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
}

fn kill_current(control: &JobControl) {
    if let Some(child) = control.child.lock().unwrap().as_mut() {
        kill_tree(child);
    }
}

fn run_capture(cmd: &mut Command) -> Result<(String, String, ExitStatus), String> {
    configure(cmd);
    let output = cmd
        .output()
        .map_err(|e| spawn_error(cmd.get_program().as_ref(), e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status,
    ))
}

fn run_streaming(
    cmd: &mut Command,
    control: &JobControl,
    on_line: &mut dyn FnMut(&str),
) -> Result<(ExitStatus, Vec<String>), String> {
    configure(cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error(cmd.get_program().as_ref(), e))?;
    let stdout = child.stdout.take().ok_or("Could not read process output")?;
    let stderr = child.stderr.take().ok_or("Could not read process output")?;
    *control.child.lock().unwrap() = Some(child);

    let err_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_sink = err_lines.clone();
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut lines = err_sink.lock().unwrap();
            if lines.len() < 200 {
                lines.push(line);
            }
        }
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(&line);
    }

    let status = {
        let child = control.child.lock().unwrap().take();
        match child {
            Some(mut c) => c
                .wait()
                .map_err(|e| format!("Waiting for process failed: {e}"))?,
            None => return Err("The process disappeared while running".into()),
        }
    };
    let _ = err_thread.join();
    let lines = err_lines.lock().unwrap().clone();
    Ok((status, lines))
}

fn resource_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("bin").join(name));
        candidates.push(dir.join("resources").join("bin").join(name));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin")
            .join(name),
    );
    candidates.into_iter().find(|p| p.is_file())
}

fn tool_path(app: &AppHandle, name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    resource_path(app, &exe).unwrap_or_else(|| PathBuf::from(&exe))
}

fn sidecar_dir(_app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar");
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(dir) = _app.path().resource_dir() {
            let bundled = dir.join("sidecar");
            if bundled.is_dir() {
                return bundled;
            }
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar")
    }
}

fn managed_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("bin").join(exe))
        .filter(|path| path.is_file())
}

fn resolve_tools(app: &AppHandle) -> Tools {
    let sidecar = sidecar_dir(app);
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled_node = sidecar.join(node_name);
    Tools {
        node: if bundled_node.is_file() {
            bundled_node
        } else {
            PathBuf::from(node_name)
        },
        yt_dlp: managed_tool(app, "yt-dlp").unwrap_or_else(|| tool_path(app, "yt-dlp")),
        ffmpeg: tool_path(app, "ffmpeg"),
        sidecar,
    }
}

fn yt_dlp_asset() -> Option<&'static str> {
    if cfg!(windows) {
        Some("yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        Some("yt-dlp_macos")
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        Some("yt-dlp_linux_aarch64")
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        Some("yt-dlp_linux")
    } else {
        None
    }
}

#[tauri::command]
async fn check_tools(app: AppHandle) -> ToolsStatus {
    let tools = resolve_tools(&app);
    let works = |program: &Path, args: &[&str]| {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    let yt_dlp_version = version_of(&tools.yt_dlp);
    ToolsStatus {
        yt_dlp: yt_dlp_version.is_some(),
        yt_dlp_version,
        ffmpeg: works(&tools.ffmpeg, &["-version"]),
        ffprobe: works(&tool_path(&app, "ffprobe"), &["-version"]),
        node: works(&tools.node, &["--version"]),
        sidecar: tools.sidecar.join("server.mjs").is_file()
            && tools
                .sidecar
                .join("node_modules")
                .join("@desert-ant-labs")
                .join("voz")
                .is_dir()
            && tools
                .sidecar
                .join("node_modules")
                .join("onnxruntime-node")
                .is_dir(),
    }
}

#[tauri::command]
async fn update_yt_dlp(app: AppHandle) -> Result<UpdateResult, String> {
    let asset = yt_dlp_asset().ok_or(
        "Automatic yt-dlp updates are not available on this platform. Install yt-dlp yourself and put it in PATH.",
    )?;
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}");
    let client = reqwest::Client::builder()
        .user_agent("yt-transcript/0.1")
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub returned an error: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read the download: {e}"))?;
    if bytes.len() < 1_000_000 {
        return Err(format!(
            "The download is too small to be yt-dlp ({} bytes).",
            bytes.len()
        ));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?
        .join("bin");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let temp = dir.join(if cfg!(windows) {
        "yt-dlp-new.exe"
    } else {
        "yt-dlp-new"
    });
    let target = dir.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    });
    std::fs::write(&temp, &bytes).map_err(|e| format!("Could not write the download: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not make the download executable: {e}"))?;
    }

    let version = Command::new(&temp)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(version) = version else {
        let _ = std::fs::remove_file(&temp);
        return Err("GitHub sent a file that is not a working yt-dlp binary.".into());
    };

    #[cfg(windows)]
    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|e| format!("Could not replace the old yt-dlp: {e}"))?;
    }
    std::fs::rename(&temp, &target)
        .map_err(|e| format!("Could not install the new yt-dlp: {e}"))?;

    Ok(UpdateResult {
        ok: true,
        message: format!(
            "Updated yt-dlp to {version}. The app now uses its own copy in the app data folder; your system install is untouched."
        ),
        version: Some(version),
    })
}

#[tauri::command]
async fn latest_yt_dlp_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("yt-transcript/0.1")
        .build()
        .map_err(|e| format!("Could not start the update check: {e}"))?;
    let response = client
        .get("https://github.com/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            format!(
                "GitHub did not redirect to a release (HTTP {}).",
                response.status()
            )
        })?;
    let tag = location
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    if tag.is_empty() || !tag.chars().any(|c| c.is_ascii_digit()) {
        return Err("GitHub returned an unexpected release tag.".into());
    }
    Ok(tag)
}

fn media_file(path: &Path) -> Result<FileInfo, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "That file could not be read. Choose it again.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a video or audio file, not a folder.".into());
    }
    if metadata.len() == 0 {
        return Err("That file is empty.".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !MEDIA_EXTENSIONS.contains(&extension.as_str()) {
        return Err("That file type is not supported. Choose a video or audio file.".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Recording")
        .to_string();
    Ok(FileInfo {
        name,
        size: metadata.len(),
    })
}

#[tauri::command]
fn file_info(path: String) -> Result<FileInfo, String> {
    media_file(Path::new(&path))
}

#[tauri::command]
fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    path: Option<String>,
) -> Result<JobStarted, String> {
    let source = match (url, path) {
        (Some(url), None) => {
            let url = url.trim().to_string();
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                return Err("Paste a full video URL starting with http:// or https://".into());
            }
            Source::Url(url)
        }
        (None, Some(path)) => {
            let path = PathBuf::from(path);
            media_file(&path)?;
            Source::File(path)
        }
        _ => return Err("Choose a link or a file, not both.".into()),
    };
    if state.control.running.swap(true, Ordering::SeqCst) {
        return Err("A job is already running.".into());
    }
    state.control.cancel.store(false, Ordering::SeqCst);

    let setup = (|| -> Result<(String, PathBuf), String> {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("No app cache directory: {e}"))?;
        let jobs = cache.join("jobs");
        let _ = std::fs::remove_dir_all(&jobs);
        std::fs::create_dir_all(&jobs).map_err(|e| format!("Could not create job folder: {e}"))?;
        let id = now_millis().to_string();
        let dir = jobs.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create job folder: {e}"))?;
        Ok((id, dir))
    })();

    let (id, dir) = match setup {
        Ok(value) => value,
        Err(error) => {
            state.control.running.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };

    let control = state.control.clone();
    let app_handle = app.clone();
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let outcome = run_pipeline(&app_handle, &control, &thread_id, &dir, &source);
        if let Err(message) = outcome {
            if control.cancel.load(Ordering::SeqCst) {
                emit_error(&app_handle, &thread_id, "Cancelled");
            } else {
                emit_error(&app_handle, &thread_id, &message);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        *control.child.lock().unwrap() = None;
        control.running.store(false, Ordering::SeqCst);
    });

    Ok(JobStarted { job_id: id })
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>) {
    state.control.cancel.store(true, Ordering::SeqCst);
    kill_current(&state.control);
}

#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn list_library(state: State<'_, AppState>) -> Result<Vec<LibraryItem>, String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .list()
}

#[tauri::command]
fn load_transcript(
    state: State<'_, AppState>,
    id: String,
) -> Result<SavedTranscript, String> {
    let library = state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?;
    let mut saved = library.get(&id)?;
    let audio = PathBuf::from(&saved.audio_path);
    if audio.is_file()
        && let Some(media) = state.media.as_ref()
    {
        saved.audio_url = media.serve(&audio, &id);
    }
    Ok(saved)
}

#[tauri::command]
fn delete_transcript(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .delete(&id)
}

#[tauri::command]
fn save_analysis(
    state: State<'_, AppState>,
    id: String,
    segments: Vec<Segment>,
    speaker_count: Option<u32>,
) -> Result<(), String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .update_analysis(&id, &segments, speaker_count)
}

#[tauri::command]
fn save_speaker_names(
    state: State<'_, AppState>,
    id: String,
    names: HashMap<String, String>,
) -> Result<(), String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .update_speaker_names(&id, &names)
}

fn persist_audio(source: &Path, audio_dir: &Path, id: &str) -> Result<(PathBuf, u64), String> {
    // shortcut: library audio is the 16 kHz mono WAV (about 115 MB/hour);
    // compress it when libraries get large.
    let target = audio_dir.join(format!("{id}.wav"));
    if std::fs::rename(source, &target).is_err() {
        std::fs::copy(source, &target)
            .map_err(|e| format!("Could not save the audio in the library: {e}"))?;
        let _ = std::fs::remove_file(source);
    }
    let bytes = std::fs::metadata(&target)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok((target, bytes))
}

/// Moves the job's audio into the library and records the transcript. Returns
/// the path to play and whether the library row was written; playback falls
/// back to the job cache if the database cannot take the row.
#[allow(clippy::too_many_arguments)]
fn save_to_library(
    library: &Library,
    id: &str,
    title: &str,
    source_kind: &str,
    duration: Option<f64>,
    text: &str,
    words: &[Word],
    waveform: &[u8],
    audio: &Path,
) -> (PathBuf, bool) {
    let audio_file = format!("{id}.wav");
    let (target, bytes) = match persist_audio(audio, &library.audio_dir, id) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("library: {error}");
            return (audio.to_path_buf(), false);
        }
    };
    match library.save(
        id,
        title,
        source_kind,
        duration,
        text,
        words,
        waveform,
        &audio_file,
        bytes,
    ) {
        Ok(()) => (target, true),
        Err(error) => {
            eprintln!("library: {error}");
            match std::fs::rename(&target, audio) {
                Ok(()) => (audio.to_path_buf(), false),
                Err(_) => (target, false),
            }
        }
    }
}

fn run_pipeline(
    app: &AppHandle,
    control: &JobControl,
    id: &str,
    dir: &Path,
    source: &Source,
) -> Result<(), String> {
    let tools = resolve_tools(app);

    let (title, metadata_duration, input, source_kind) = match source {
        Source::Url(url) => {
            emit_progress(app, id, "metadata", None);
            check_cancel(control)?;
            let (title, duration) = fetch_metadata(&tools, url)?;
            check_cancel(control)?;

            emit_progress(app, id, "download", Some(0.0));
            download(&tools, url, dir, app, id, control)?;
            check_cancel(control)?;
            (title, duration, dir.join("audio.wav"), "url")
        }
        Source::File(path) => {
            let title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Recording")
                .to_string();
            (title, None, path.clone(), "file")
        }
    };

    emit_progress(app, id, "convert", None);
    let audio = convert(&tools, &input, dir, control)?;
    check_cancel(control)?;

    let (text, words, audio_duration) = transcribe(&tools, &audio, app, id, control)?;
    check_cancel(control)?;

    let duration = audio_duration.or(metadata_duration);
    let waveform = wav_peaks(&audio, 2000).unwrap_or_else(|error| {
        eprintln!("waveform: {error}");
        Vec::new()
    });

    let mut audio = audio;
    let mut saved = false;
    if let Some(state) = app.try_state::<AppState>()
        && let Some(library) = state.library.as_ref()
    {
        let (path, stored) = save_to_library(
            library,
            id,
            &title,
            source_kind,
            duration,
            &text,
            &words,
            &waveform,
            &audio,
        );
        if path != audio {
            let _ = std::fs::remove_dir_all(dir);
            audio = path;
        }
        saved = stored;
    }

    let audio_url = app
        .try_state::<AppState>()
        .and_then(|state| state.media.as_ref().map(|media| media.serve(&audio, id)))
        .unwrap_or_default();

    app.emit(
        "job:result",
        JobResult {
            job_id: id.to_string(),
            title,
            duration,
            audio_path: audio.to_string_lossy().into_owned(),
            audio_url,
            waveform,
            text,
            words,
            saved,
        },
    )
    .map_err(|e| format!("Could not send the transcript to the app: {e}"))?;
    emit_progress(app, id, "done", Some(1.0));
    Ok(())
}

fn fetch_metadata(tools: &Tools, url: &str) -> Result<(String, Option<f64>), String> {
    let mut cmd = Command::new(&tools.yt_dlp);
    cmd.args([
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-warnings",
        "-J",
        url,
    ]);
    let (stdout, stderr, status) = run_capture(&mut cmd)?;
    if !status.success() {
        return Err(format!(
            "yt-dlp could not read this video.\n{}",
            tail(&stderr.lines().map(str::to_string).collect::<Vec<_>>())
        ));
    }
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("yt-dlp returned metadata the app could not read: {e}"))?;
    if value.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        return Err("That link is a playlist. Paste a single video link.".into());
    }
    if value
        .get("is_live")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return Err("Live streams are not supported. Try a finished video.".into());
    }
    let title = value
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let duration = value.get("duration").and_then(|d| d.as_f64());
    Ok((title, duration))
}

fn download(
    tools: &Tools,
    url: &str,
    dir: &Path,
    app: &AppHandle,
    id: &str,
    control: &JobControl,
) -> Result<(), String> {
    let template = dir.join("audio.%(ext)s");
    let mut cmd = Command::new(&tools.yt_dlp);
    cmd.args([
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-warnings",
        "--no-colors",
        "--newline",
        "--progress-template",
        "download:%(progress._percent_str)s",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "wav",
    ]);
    prepend_tool_path(&mut cmd, tools);
    cmd.arg("-o").arg(&template).arg(url);

    let (status, stderr) = run_streaming(&mut cmd, control, &mut |line| {
        if let Some(rest) = line.strip_prefix("download:") {
            if let Ok(percent) = rest.trim().trim_end_matches('%').trim().parse::<f64>() {
                emit_progress(app, id, "download", Some(percent / 100.0));
            }
        }
    })?;
    if !status.success() {
        return Err(format!("Download failed.\n{}", tail(&stderr)));
    }
    emit_progress(app, id, "download", Some(1.0));

    if !dir.join("audio.wav").is_file() {
        let found = std::fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("audio.") && !name.ends_with(".part"))
            });
        match found {
            Some(path) => std::fs::rename(&path, dir.join("audio.wav"))
                .map_err(|e| format!("Could not prepare the downloaded audio: {e}"))?,
            None => return Err("The download finished but no audio file was produced.".into()),
        }
    }
    Ok(())
}

fn convert(
    tools: &Tools,
    input: &Path,
    dir: &Path,
    control: &JobControl,
) -> Result<PathBuf, String> {
    let output = dir.join("audio16.wav");
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&output);
    let (status, stderr) = run_streaming(&mut cmd, control, &mut |_| {})?;
    if !status.success() {
        return Err(format!(
            "Could not convert the audio to 16 kHz mono.\n{}",
            tail(&stderr)
        ));
    }
    Ok(output)
}

/// Peak amplitudes for the player's waveform, one byte per bucket.
fn wav_peaks(path: &Path, buckets: usize) -> Result<Vec<u8>, String> {
    let mut file =
        File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .len();

    let mut riff = [0u8; 12];
    file.read_exact(&mut riff)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("Not a WAV file".into());
    }

    let mut offset = 12u64;
    loop {
        if offset + 8 > len {
            return Err("The WAV file has no audio data".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as u64;
        if &header[0..4] == b"data" {
            return peaks_from_pcm(&mut file, size.min(len - offset - 8), buckets)
                .map_err(|e| format!("Could not read the waveform: {e}"));
        }
        offset += 8 + size + (size & 1);
    }
}

fn peaks_from_pcm(reader: &mut impl Read, bytes: u64, buckets: usize) -> std::io::Result<Vec<u8>> {
    let buckets = buckets.max(1);
    let samples = bytes / 2;
    let per_bucket = (samples / buckets as u64).max(1);
    let mut peaks = Vec::with_capacity(buckets);
    let mut buffer = [0u8; 8192];
    let mut seen = 0u64;
    let mut bucket_end = per_bucket;
    let mut loudest = 0u16;
    let mut remaining = samples * 2;

    while remaining >= 2 {
        let take = buffer.len().min(remaining as usize) & !1;
        reader.read_exact(&mut buffer[..take])?;
        remaining -= take as u64;
        for pair in buffer[..take].as_chunks::<2>().0 {
            let sample = i16::from_le_bytes(*pair).unsigned_abs();
            loudest = loudest.max(sample);
            seen += 1;
            if seen >= bucket_end {
                peaks.push((u32::from(loudest.min(32767)) * 255 / 32767) as u8);
                loudest = 0;
                bucket_end += per_bucket;
                if peaks.len() == buckets {
                    return Ok(peaks);
                }
            }
        }
    }
    if seen > 0 && peaks.len() < buckets {
        peaks.push((u32::from(loudest) * 255 / 32767) as u8);
    }
    Ok(peaks)
}

fn transcribe(
    tools: &Tools,
    audio: &Path,
    app: &AppHandle,
    id: &str,
    control: &JobControl,
) -> Result<(String, Vec<Word>, Option<f64>), String> {
    let mut cmd = Command::new(&tools.node);
    cmd.current_dir(&tools.sidecar)
        .arg("server.mjs")
        .arg(audio)
        .env("DAL_APP_ID", DAL_APP_ID);

    let mut result: Option<(String, Vec<Word>, Option<f64>)> = None;
    let mut sidecar_error: Option<String> = None;

    let (status, stderr) = run_streaming(&mut cmd, control, &mut |line| {
        let Ok(event) = serde_json::from_str::<SidecarEvent>(line) else {
            return;
        };
        match event.kind.as_str() {
            "progress" => {
                let stage = if event.phase.as_deref() == Some("model") {
                    "model"
                } else {
                    "transcribe"
                };
                emit_progress(app, id, stage, event.fraction);
            }
            "result" => {
                if let (Some(text), Some(words)) = (event.text, event.words) {
                    result = Some((text, words, event.duration));
                }
            }
            "error" => sidecar_error = event.message,
            _ => {}
        }
    })?;

    if let Some(message) = sidecar_error {
        return Err(message);
    }
    if !status.success() {
        return Err(format!(
            "The speech model stopped with an error.\n{}",
            tail(&stderr)
        ));
    }
    result.ok_or_else(|| {
        format!(
            "The speech model returned no transcript.\n{}",
            tail(&stderr)
        )
    })
}

fn jobs_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("jobs"))
}

fn cleanup_jobs(app: &AppHandle) {
    if let Some(dir) = jobs_dir(app) {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            cleanup_jobs(app.handle());
            let media = MediaServer::start()
                .map_err(|error| eprintln!("Playback server unavailable: {error}"))
                .ok();
            let library = Library::open(app.handle())
                .map_err(|error| eprintln!("Transcript library unavailable: {error}"))
                .ok();
            app.manage(AppState {
                control: JobControl::default(),
                media,
                library,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_tools,
            latest_yt_dlp_version,
            update_yt_dlp,
            file_info,
            start_job,
            cancel_job,
            save_text,
            list_library,
            load_transcript,
            delete_transcript,
            save_analysis,
            save_speaker_names
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.control.cancel.store(true, Ordering::SeqCst);
                kill_current(&state.control);
            }
            cleanup_jobs(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "yt-transcript-{name}-{}-{}.tmp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn waveform_peaks_follow_the_pcm_data() {
        let path = temp_path("peaks");
        let samples = [0i16, 1000, -32768, 2000, -100, 300, 400, 500];
        std::fs::write(&path, wav_bytes(&samples)).unwrap();
        let peaks = wav_peaks(&path, 4).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(peaks.len(), 4);
        assert_eq!(peaks[0], (1000 * 255 / 32767) as u8);
        assert_eq!(peaks[1], 255);
        assert_eq!(peaks[3], (500 * 255 / 32767) as u8);
    }

    #[test]
    fn waveform_peaks_survive_odd_reads() {
        struct Trickle {
            data: Vec<u8>,
            position: usize,
        }
        impl Read for Trickle {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.position >= self.data.len() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.data[self.position];
                self.position += 1;
                Ok(1)
            }
        }

        let mut data = Vec::new();
        for sample in [1000i16, -2000, 3000, -4000] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let mut reader = Trickle { data, position: 0 };
        let peaks = peaks_from_pcm(&mut reader, 8, 2).unwrap();
        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks[0], (2000 * 255 / 32767) as u8);
        assert_eq!(peaks[1], (4000 * 255 / 32767) as u8);
    }

    #[test]
    fn media_files_are_checked_before_a_job() {
        let audio = temp_path("clip").with_extension("wav");
        std::fs::write(&audio, wav_bytes(&[1i16; 4])).unwrap();
        let info = media_file(&audio).unwrap();
        assert_eq!(info.name, audio.file_name().unwrap().to_str().unwrap());
        assert_eq!(info.size, 52);

        let notes = temp_path("notes").with_extension("txt");
        std::fs::write(&notes, b"hello").unwrap();
        assert!(media_file(&notes).is_err());
        assert!(media_file(&temp_path("missing").with_extension("mp3")).is_err());

        let _ = std::fs::remove_file(&audio);
        let _ = std::fs::remove_file(&notes);
    }

    fn sample_words() -> Vec<Word> {
        vec![
            Word {
                text: "hello".into(),
                start: 0.0,
                end: 0.4,
            },
            Word {
                text: "world".into(),
                start: 0.4,
                end: 0.9,
            },
        ]
    }

    #[test]
    fn library_round_trips_a_transcript_and_deletes_its_audio() {
        let base = temp_path("library");
        let audio_dir = base.join("library");
        let library = Library::open_at(base.join("library.db"), audio_dir.clone()).unwrap();
        std::fs::create_dir_all(&audio_dir).unwrap();
        let audio = audio_dir.join("job-1.wav");
        std::fs::write(&audio, wav_bytes(&[1i16, 2, 3])).unwrap();

        library
            .save(
                "job-1",
                "A test recording",
                "file",
                Some(12.5),
                "hello world",
                &sample_words(),
                &[10, 200, 30],
                "job-1.wav",
                6,
            )
            .unwrap();

        let items = library.list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A test recording");
        assert_eq!(items[0].word_count, 2);
        assert_eq!(items[0].speaker_count, None);
        assert_eq!(items[0].audio_bytes, 6);

        let saved = library.get("job-1").unwrap();
        assert_eq!(saved.words.len(), 2);
        assert_eq!(saved.waveform, vec![10, 200, 30]);
        assert_eq!(saved.segments, None);
        assert!(saved.audio_path.ends_with("job-1.wav"));

        // A new connection sees the same row: the library survives a restart.
        drop(library);
        let library = Library::open_at(base.join("library.db"), audio_dir.clone()).unwrap();
        assert_eq!(library.list().unwrap().len(), 1);

        let segments = vec![Segment {
            speaker: Some(1),
            start: 0.0,
            end: 0.9,
            text: "hello world".into(),
            words: sample_words(),
        }];
        library.update_analysis("job-1", &segments, Some(2)).unwrap();
        library
            .update_speaker_names(
                "job-1",
                &HashMap::from([("1".to_string(), "Ada".to_string())]),
            )
            .unwrap();

        let saved = library.get("job-1").unwrap();
        assert_eq!(saved.segments.unwrap()[0].speaker, Some(1));
        assert_eq!(saved.speaker_count, Some(2));
        assert_eq!(saved.speaker_names.get("1").map(String::as_str), Some("Ada"));

        library.delete("job-1").unwrap();
        assert!(!audio.exists());
        assert!(library.list().unwrap().is_empty());
        assert!(library.get("job-1").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn audio_moves_out_of_the_job_cache() {
        let base = temp_path("persist");
        let jobs = base.join("jobs").join("job-2");
        let audio_dir = base.join("library");
        std::fs::create_dir_all(&jobs).unwrap();
        std::fs::create_dir_all(&audio_dir).unwrap();
        let source = jobs.join("audio16.wav");
        let bytes = wav_bytes(&[7i16; 8]);
        std::fs::write(&source, &bytes).unwrap();

        let (target, size) = persist_audio(&source, &audio_dir, "job-2").unwrap();
        assert!(!source.exists());
        assert_eq!(target, audio_dir.join("job-2.wav"));
        assert_eq!(size, bytes.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn media_server_serves_byte_ranges() {
        let bytes = wav_bytes(&[1i16; 50]);
        let path = temp_path("media");
        std::fs::write(&path, &bytes).unwrap();
        let server = MediaServer::start().unwrap();
        server.serve(&path, "test-job");

        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(b"GET /audio HTTP/1.1\r\nHost: localhost\r\nRange: bytes=10-19\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();

        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&response[..split]);
        let body = &response[split + 4..];
        assert!(head.starts_with("HTTP/1.1 206"));
        assert!(head.contains("Content-Range: bytes 10-19/"));
        assert_eq!(body, &bytes[10..20]);

        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(b"GET /audio HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-\r\n\r\n")
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
}
