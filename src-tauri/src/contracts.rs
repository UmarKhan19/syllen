use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Word {
    pub(super) text: String,
    pub(super) start: f64,
    pub(super) end: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Segment {
    pub(super) speaker: Option<u32>,
    pub(super) start: f64,
    pub(super) end: f64,
    pub(super) text: String,
    pub(super) words: Vec<Word>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProgressEvent {
    pub(super) job_id: String,
    pub(super) stage: String,
    pub(super) percent: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobResult {
    pub(super) job_id: String,
    pub(super) title: String,
    pub(super) duration: Option<f64>,
    pub(super) audio_path: String,
    pub(super) audio_url: String,
    pub(super) waveform: Vec<u8>,
    pub(super) text: String,
    pub(super) words: Vec<Word>,
    pub(super) saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibraryItem {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) created_at: i64,
    pub(super) duration: Option<f64>,
    pub(super) word_count: i64,
    pub(super) speaker_count: Option<i64>,
    pub(super) audio_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SavedTranscript {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) created_at: i64,
    pub(super) duration: Option<f64>,
    pub(super) audio_path: String,
    pub(super) audio_url: String,
    pub(super) waveform: Vec<u8>,
    pub(super) text: String,
    pub(super) words: Vec<Word>,
    pub(super) segments: Option<Vec<Segment>>,
    pub(super) speaker_count: Option<u32>,
    pub(super) speaker_names: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ErrorEvent {
    pub(super) job_id: String,
    pub(super) message: String,
}

#[derive(Serialize)]
pub(super) struct JobStarted {
    pub(super) job_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileInfo {
    pub(super) name: String,
    pub(super) size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolsStatus {
    pub(super) yt_dlp: bool,
    pub(super) yt_dlp_version: Option<String>,
    pub(super) ffmpeg: bool,
    pub(super) ffprobe: bool,
    pub(super) node: bool,
    pub(super) sidecar: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateResult {
    pub(super) ok: bool,
    pub(super) message: String,
    pub(super) version: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct SidecarEvent {
    #[serde(rename = "type")]
    pub(super) kind: String,
    #[serde(default)]
    pub(super) phase: Option<String>,
    #[serde(default)]
    pub(super) fraction: Option<f64>,
    #[serde(default)]
    pub(super) text: Option<String>,
    #[serde(default)]
    pub(super) words: Option<Vec<Word>>,
    #[serde(default)]
    pub(super) duration: Option<f64>,
    #[serde(default)]
    pub(super) message: Option<String>,
}
