use crate::contracts::{ToolsStatus, UpdateResult};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

#[path = "tools/update-verification.rs"]
mod update_verification;

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
    let version = update_verification::update(&app, asset).await?;
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
    update_verification::release_tag().await
}
