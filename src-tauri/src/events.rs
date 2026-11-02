use crate::contracts::{ErrorEvent, ProgressEvent};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub(super) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(super) fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, percent: Option<f64>) {
    let _ = app.emit(
        "job:progress",
        ProgressEvent {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            percent: percent.map(|p| p.clamp(0.0, 1.0)),
        },
    );
}

pub(super) fn emit_error(app: &AppHandle, job_id: &str, message: &str) {
    let _ = app.emit(
        "job:error",
        ErrorEvent {
            job_id: job_id.to_string(),
            message: message.to_string(),
        },
    );
}
