use std::path::Path;

use crate::contracts::FileInfo;

// Keep in step with MEDIA_EXTENSIONS in src/app.tsx.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "wmv", "flv", "ts", "m2ts", "3gp",
    "3g2", "ogv", "mp3", "m4a", "m4b", "wav", "flac", "ogg", "oga", "opus", "aac", "wma", "aiff",
    "aif", "amr", "au", "caf", "ac3",
];

pub(super) fn media_file(path: &Path) -> Result<FileInfo, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "That file could not be read. Choose it again.".to_string())?;
    if !metadata.is_file() { return Err("Choose a video or audio file, not a folder.".into()); }
    if metadata.len() == 0 { return Err("That file is empty.".into()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !MEDIA_EXTENSIONS.contains(&extension.as_str()) { return Err("That file type is not supported. Choose a video or audio file.".into()); }
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("Recording").to_string();
    Ok(FileInfo { name, size: metadata.len() })
}

#[tauri::command]
pub(super) fn file_info(path: String) -> Result<FileInfo, String> { media_file(Path::new(&path)) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yt-transcript-{name}-{}-{}.tmp", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
    }

    fn wav_bytes() -> Vec<u8> {
        let mut bytes = b"RIFF\x2c\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\x08\0\0\0".to_vec();
        bytes.extend_from_slice(&[1; 8]);
        bytes
    }

    #[test]
    fn media_files_are_checked_before_a_job() {
        let audio = temp_path("clip").with_extension("wav");
        std::fs::write(&audio, wav_bytes()).unwrap();
        let info = media_file(&audio).unwrap();
        assert_eq!(info.name, audio.file_name().unwrap().to_str().unwrap());
        assert_eq!(info.size, 52);
        let notes = temp_path("notes").with_extension("txt");
        std::fs::write(&notes, b"hello").unwrap();
        assert!(media_file(&notes).is_err());
        assert!(media_file(&temp_path("missing").with_extension("mp3")).is_err());
        let _ = std::fs::remove_file(&audio);
        let _ = std::fs::remove_file(&notes);
    }
}
