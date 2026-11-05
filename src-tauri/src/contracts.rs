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
    pub(super) cpu_threads: usize,
    pub(super) thermal_guard_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThermalStatus {
    pub(super) available: bool,
    pub(super) temperature_c: Option<f64>,
    pub(super) pause_at_c: Option<f64>,
    pub(super) resume_at_c: Option<f64>,
    pub(super) cool_dwell_seconds: u64,
    pub(super) reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ThermalState {
    Monitoring,
    Cooling,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThermalEvent {
    pub(super) job_id: String,
    pub(super) state: ThermalState,
    pub(super) status: ThermalStatus,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ResourcePreset {
    Performance,
    #[default]
    Balanced,
    Battery,
}

impl ResourcePreset {
    pub(super) fn cpu_threads(self, available: usize) -> usize {
        match self {
            Self::Performance => available,
            Self::Balanced => (available / 2).max(1),
            Self::Battery => 1,
        }
    }
}

#[cfg(test)]
mod resource_tests {
    use super::JobResult;

    #[test]
    fn job_result_exposes_the_resolved_cpu_threads_in_camel_case() {
        let value = serde_json::to_value(JobResult {
            job_id: "job".into(),
            title: "title".into(),
            duration: None,
            audio_path: "audio.wav".into(),
            audio_url: "".into(),
            waveform: Vec::new(),
            text: String::new(),
            words: Vec::new(),
            saved: false,
            cpu_threads: 3,
            thermal_guard_enabled: true,
        })
        .unwrap();
        assert_eq!(value["cpuThreads"], 3);
        assert!(value.get("cpu_threads").is_none());
        assert_eq!(value["thermalGuardEnabled"], true);
    }

    #[test]
    fn thermal_status_and_events_use_the_shared_camel_case_contract() {
        let status = super::ThermalStatus {
            available: true,
            temperature_c: Some(45.0),
            pause_at_c: Some(90.0),
            resume_at_c: Some(80.0),
            cool_dwell_seconds: 15,
            reason: None,
        };
        let status_value = serde_json::to_value(&status).unwrap();
        assert_eq!(status_value["temperatureC"], 45.0);
        assert_eq!(status_value["pauseAtC"], 90.0);
        assert_eq!(status_value["resumeAtC"], 80.0);
        assert_eq!(status_value["coolDwellSeconds"], 15);
        let event = serde_json::to_value(super::ThermalEvent {
            job_id: "job-1".into(),
            state: super::ThermalState::Cooling,
            status,
        })
        .unwrap();
        assert_eq!(event["jobId"], "job-1");
        assert_eq!(event["state"], "cooling");
        assert_eq!(event["status"]["temperatureC"], 45.0);
    }
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
