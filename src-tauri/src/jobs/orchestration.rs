use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};

use crate::{
    AppState,
    contracts::JobResult,
    events::emit_progress,
    job_control::JobControl,
    tools::resolve_tools,
    waveform::wav_peaks,
};

use super::{Source, check_cancel, persistence::save_to_library, sidecar::transcribe, stages::{convert, download, fetch_metadata}};

pub(super) fn run_pipeline(
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
            let title = path.file_stem().and_then(|v| v.to_str())
                .filter(|v| !v.trim().is_empty()).unwrap_or("Recording").to_string();
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
        eprintln!("waveform: {error}"); Vec::new()
    });
    let mut audio = audio;
    let mut saved = false;
    if let Some(state) = app.try_state::<AppState>()
        && let Some(library) = state.library.as_ref()
    {
        let (path, stored) = save_to_library(library, id, &title, source_kind, duration, &text, &words, &waveform, &audio);
        if path != audio { let _ = std::fs::remove_dir_all(dir); audio = path; }
        saved = stored;
    }
    let audio_url = app.try_state::<AppState>()
        .and_then(|state| state.media.as_ref().map(|media| media.serve(&audio, id)))
        .unwrap_or_default();
    app.emit("job:result", JobResult {
        job_id: id.to_string(), title, duration,
        audio_path: audio.to_string_lossy().into_owned(), audio_url,
        waveform, text, words, saved,
    }).map_err(|e| format!("Could not send the transcript to the app: {e}"))?;
    emit_progress(app, id, "done", Some(1.0));
    Ok(())
}
