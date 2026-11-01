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
    contracts::JobStarted,
    events::emit_error,
    media_file::media_file,
    process::kill_current,
};

pub(super) use crate::job_control::JobControl;

enum Source {
    Url(String),
    File(PathBuf),
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn check_cancel(control: &JobControl) -> Result<(), String> {
    if control.cancel.load(Ordering::SeqCst) { Err("Cancelled".into()) } else { Ok(()) }
}

#[tauri::command]
pub(super) fn start_job(
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
        let outcome = orchestration::run_pipeline(&app_handle, &control, &thread_id, &dir, &source);
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
