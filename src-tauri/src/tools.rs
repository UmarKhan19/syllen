use crate::contracts::{ToolsStatus, UpdateResult};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

pub(super) struct Tools {
    pub(super) node: PathBuf,
    pub(super) yt_dlp: PathBuf,
    pub(super) ffmpeg: PathBuf,
    pub(super) sidecar: PathBuf,
}

fn version_of(program: &Path) -> Option<String> {
    Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty())
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
pub(super) fn tool_path(app: &AppHandle, name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    resource_path(app, &exe).unwrap_or_else(|| PathBuf::from(&exe))
}
fn sidecar_dir(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar")
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(dir) = app.path().resource_dir() {
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
        .filter(|p| p.is_file())
}
pub(super) fn resolve_tools(app: &AppHandle) -> Tools {
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
pub(super) async fn check_tools(app: AppHandle) -> ToolsStatus {
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
pub(super) async fn update_yt_dlp(app: AppHandle) -> Result<UpdateResult, String> {
    let asset = yt_dlp_asset().ok_or("Automatic yt-dlp updates are not available on this platform. Install yt-dlp yourself and put it in PATH.")?;
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
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty());
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
pub(super) async fn latest_yt_dlp_version() -> Result<String, String> {
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
        .and_then(|v| v.to_str().ok())
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
