use std::path::Path;
use std::process::Command;

use tauri::AppHandle;

use crate::{
    contracts::{SidecarEvent, Word},
    events::emit_progress,
    job_control::JobControl,
    process::{run_streaming, tail},
    thermal::JobThermalGuard,
    tools::Tools,
};

const DAL_APP_ID: &str = "app.syllen.desktop";

pub(super) fn transcribe(
    tools: &Tools,
    audio: &Path,
    app: &AppHandle,
    id: &str,
    control: &JobControl,
    cpu_threads: usize,
    thermal_guard: &JobThermalGuard,
) -> Result<(String, Vec<Word>, Option<f64>), String> {
    let mut cmd = Command::new(&tools.node);
    cmd.current_dir(&tools.sidecar)
        .arg("server.mjs")
        .arg(audio)
        .env("DAL_APP_ID", DAL_APP_ID)
        .env("SYLLEN_CPU_THREADS", cpu_threads.to_string());
    let mut result: Option<(String, Vec<Word>, Option<f64>)> = None;
    let mut sidecar_error: Option<String> = None;
    let (status, stderr) = run_streaming(&mut cmd, control, thermal_guard, &mut |line| {
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
