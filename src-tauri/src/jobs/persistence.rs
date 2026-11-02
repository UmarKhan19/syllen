use std::path::{Path, PathBuf};

use crate::{contracts::Word, library::Library};

fn persist_audio(source: &Path, audio_dir: &Path, id: &str) -> Result<(PathBuf, u64), String> {
    // shortcut: library audio is the 16 kHz mono WAV (about 115 MB/hour); compress it when libraries get large.
    let target = audio_dir.join(format!("{id}.wav"));
    if std::fs::rename(source, &target).is_err() {
        std::fs::copy(source, &target)
            .map_err(|e| format!("Could not save the audio in the library: {e}"))?;
        let _ = std::fs::remove_file(source);
    }
    let bytes = std::fs::metadata(&target)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok((target, bytes))
}

/// Moves the job's audio into the library and records the transcript. Returns
/// the path to play and whether the library row was written; playback falls
/// back to the job cache if the database cannot take the row.
#[allow(clippy::too_many_arguments)]
pub(super) fn save_to_library(
    library: &Library,
    id: &str,
    title: &str,
    source_kind: &str,
    duration: Option<f64>,
    text: &str,
    words: &[Word],
    waveform: &[u8],
    audio: &Path,
) -> (PathBuf, bool) {
    let audio_file = format!("{id}.wav");
    let (target, bytes) = match persist_audio(audio, &library.audio_dir, id) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("library: {error}");
            return (audio.to_path_buf(), false);
        }
    };
    match library.save(
        id,
        title,
        source_kind,
        duration,
        text,
        words,
        waveform,
        &audio_file,
        bytes,
    ) {
        Ok(()) => (target, true),
        Err(error) => {
            eprintln!("library: {error}");
            match std::fs::rename(&target, audio) {
                Ok(()) => (audio.to_path_buf(), false),
                Err(_) => (target, false),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn wav_bytes(samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "yt-transcript-{name}-{}-{}.tmp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn audio_moves_out_of_the_job_cache() {
        let base = temp_path("persist");
        let jobs = base.join("jobs").join("job-2");
        let audio_dir = base.join("library");
        std::fs::create_dir_all(&jobs).unwrap();
        std::fs::create_dir_all(&audio_dir).unwrap();
        let source = jobs.join("audio16.wav");
        let bytes = wav_bytes(&[7i16; 8]);
        std::fs::write(&source, &bytes).unwrap();
        let (target, size) = persist_audio(&source, &audio_dir, "job-2").unwrap();
        assert!(!source.exists());
        assert_eq!(target, audio_dir.join("job-2.wav"));
        assert_eq!(size, bytes.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&base);
    }
}
