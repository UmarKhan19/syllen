mod contracts;
mod events;
#[path = "job-control.rs"]
mod job_control;
mod jobs;
mod library;
#[path = "library-commands.rs"]
mod library_commands;
#[path = "media-file.rs"]
mod media_file;
#[path = "media-server.rs"]
mod media_server;
mod process;
#[path = "text-export.rs"]
mod text_export;
mod tools;
mod waveform;

use job_control::JobControl;
use library::Library;
use media_server::MediaServer;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent};

pub(crate) struct AppState {
    control: JobControl,
    media: Option<MediaServer>,
    library: Option<Library>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            jobs::cleanup_jobs(app.handle());
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
            tools::check_tools,
            tools::latest_yt_dlp_version,
            tools::update_yt_dlp,
            media_file::file_info,
            jobs::start_job,
            jobs::cancel_job,
            text_export::save_text,
            library_commands::list_library,
            library_commands::load_transcript,
            library_commands::delete_transcript,
            library_commands::save_analysis,
            library_commands::save_speaker_names,
            library_commands::save_word_corrections
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.control.cancel.store(true, Ordering::SeqCst);
                process::kill_current(&state.control);
            }
            jobs::cleanup_jobs(app_handle);
        }
    });
}
