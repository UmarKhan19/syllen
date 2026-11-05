mod orchestration;
mod persistence;
mod sidecar;
mod stages;

use std::{
    path::PathBuf,
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, State};

use crate::{
    AppState,
    contracts::{JobStarted, ResourcePreset},
    events::emit_error,
    media_file::media_file,
    process::kill_current,
};

pub(super) use crate::job_control::JobControl;

enum Source {
    Url(String),
    File(PathBuf),
}

fn validate_video_url(value: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| "Paste a valid HTTPS video URL.".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("Only HTTPS video URLs are supported.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Video URLs must not contain a username or password.".into());
    }
    Ok(url.into())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn check_cancel(control: &JobControl) -> Result<(), String> {
    if control.cancel.load(Ordering::SeqCst) {
        Err("Cancelled".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(super) fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    path: Option<String>,
    resource_preset: Option<ResourcePreset>,
    thermal_guard_enabled: Option<bool>,
) -> Result<JobStarted, String> {
    let source = match (url, path) {
        (Some(url), None) => {
            let url = validate_video_url(url.trim())?;
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
    let available = std::thread::available_parallelism().map_or(1, usize::from);
    let cpu_threads = resource_preset.unwrap_or_default().cpu_threads(available);
    let thermal_guard_enabled = thermal_guard_enabled.unwrap_or(true);

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
        let outcome = orchestration::run_pipeline(
            &app_handle,
            &control,
            &thread_id,
            &dir,
            &source,
            cpu_threads,
            thermal_guard_enabled,
        );
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

#[cfg(test)]
mod tests {
    use super::validate_video_url;
    use crate::contracts::ResourcePreset;

    #[test]
    fn resource_presets_resolve_odd_even_and_single_core_counts() {
        for (preset, n, expected) in [
            (ResourcePreset::Performance, 8, 8),
            (ResourcePreset::Balanced, 8, 4),
            (ResourcePreset::Balanced, 5, 2),
            (ResourcePreset::Balanced, 1, 1),
            (ResourcePreset::Battery, 8, 1),
        ] {
            assert_eq!(preset.cpu_threads(n), expected);
        }
        assert!(serde_json::from_str::<ResourcePreset>("\"invalid\"").is_err());
        assert!(serde_json::from_str::<ResourcePreset>("\"balanced\"").is_ok());
        assert!(serde_json::from_str::<ResourcePreset>("null").is_err());
    }

    #[test]
    fn accepts_only_well_formed_https_urls_without_credentials() {
        assert_eq!(
            validate_video_url("HTTPS://example.com/watch?v=1").unwrap(),
            "https://example.com/watch?v=1"
        );
        for url in [
            "http://example.com/video",
            "file:///etc/passwd",
            "https://",
            "https://user@example.com/video",
            "https://user:password@example.com/video",
        ] {
            assert!(validate_video_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_video_url("https://example.com/--exec").is_ok());
    }
}

#[tauri::command]
pub(super) fn cancel_job(state: State<'_, AppState>) {
    state.control.cancel.store(true, Ordering::SeqCst);
    kill_current(&state.control);
}

pub(super) fn cleanup_jobs(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let dir = cache.join("jobs");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
}
