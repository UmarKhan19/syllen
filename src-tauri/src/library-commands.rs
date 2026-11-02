use crate::{
    AppState,
    contracts::{LibraryItem, SavedTranscript, Segment, Word},
};
use std::{collections::HashMap, path::PathBuf};
use tauri::State;

#[tauri::command]
pub(super) fn list_library(state: State<'_, AppState>) -> Result<Vec<LibraryItem>, String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .list()
}
#[tauri::command]
pub(super) fn load_transcript(
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
pub(super) fn delete_transcript(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .delete(&id)
}
#[tauri::command]
pub(super) fn save_analysis(
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
pub(super) fn save_speaker_names(
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
#[tauri::command]
pub(super) fn save_word_corrections(
    state: State<'_, AppState>,
    id: String,
    expected_words: Vec<Word>,
    words: Vec<Word>,
) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err("The transcript identifier is invalid.".into());
    }
    state
        .library
        .as_ref()
        .ok_or_else(|| "The transcript library is not available.".to_string())?
        .update_words(&id, &expected_words, &words)
}
