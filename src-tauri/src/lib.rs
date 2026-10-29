use http_range::HttpRange;
use serde::{Deserialize, Serialize};
use std::{
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

#[derive(Clone, Default)]
struct JobControl {
    child: Arc<Mutex<Option<Child>>>,
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

struct AppState {
    control: JobControl,
    media: Option<MediaServer>,
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

#[derive(Clone, Serialize, Deserialize)]
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

#[tauri::command]
fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<JobStarted, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Paste a full video URL starting with http:// or https://".into());
    }
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
        let outcome = run_pipeline(&app_handle, &control, &thread_id, &dir, &url);
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

fn run_pipeline(
    app: &AppHandle,
    control: &JobControl,
    id: &str,
    dir: &Path,
    url: &str,
) -> Result<(), String> {
    let tools = resolve_tools(app);

    emit_progress(app, id, "metadata", None);
    check_cancel(control)?;
    let (title, metadata_duration) = fetch_metadata(&tools, url)?;
    check_cancel(control)?;

    emit_progress(app, id, "download", Some(0.0));
    download(&tools, url, dir, app, id, control)?;
    check_cancel(control)?;

    emit_progress(app, id, "convert", None);
    let audio = convert(&tools, dir, control)?;
    check_cancel(control)?;

    let (text, words, audio_duration) = transcribe(&tools, &audio, app, id, control)?;
    check_cancel(control)?;

    let audio_url = app
        .try_state::<AppState>()
        .and_then(|state| state.media.as_ref().map(|media| media.serve(&audio, id)))
        .unwrap_or_default();
    let waveform = wav_peaks(&audio, 2000).unwrap_or_else(|error| {
        eprintln!("waveform: {error}");
        Vec::new()
    });

    app.emit(
        "job:result",
        JobResult {
            job_id: id.to_string(),
            title,
            duration: audio_duration.or(metadata_duration),
            audio_path: audio.to_string_lossy().into_owned(),
            audio_url,
            waveform,
            text,
            words,
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

fn convert(tools: &Tools, dir: &Path, control: &JobControl) -> Result<PathBuf, String> {
    let input = dir.join("audio.wav");
    let output = dir.join("audio16.wav");
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&input)
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
            app.manage(AppState {
                control: JobControl::default(),
                media,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_tools,
            latest_yt_dlp_version,
            update_yt_dlp,
            start_job,
            cancel_job,
            save_text
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
