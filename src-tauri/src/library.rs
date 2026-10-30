//! SQLite transcript storage and the corresponding saved audio files.

use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};

use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, Manager};

use crate::{
    contracts::{LibraryItem, SavedTranscript, Segment, Word},
    now_millis,
};

/// Transcripts and their audio live in app data, not the job cache.
/// Jobs write at the end; the UI reads and deletes from the library.
pub(super) struct Library {
    conn: Mutex<Connection>,
    pub(super) audio_dir: PathBuf,
}

impl Library {
    pub(super) fn open(app: &AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data directory: {e}"))?;
        Self::open_at(data.join("library.db"), data.join("library"))
    }

    pub(super) fn open_at(database: PathBuf, audio_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&audio_dir)
            .map_err(|e| format!("Could not create {}: {e}", audio_dir.display()))?;
        let conn = Connection::open(&database)
            .map_err(|e| format!("Could not open the transcript library: {e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("Could not configure the transcript library: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS transcripts (
                 id            TEXT PRIMARY KEY,
                 title         TEXT NOT NULL,
                 source_kind   TEXT NOT NULL,
                 created_at    INTEGER NOT NULL,
                 duration      REAL,
                 text          TEXT NOT NULL,
                 words         TEXT NOT NULL,
                 word_count    INTEGER NOT NULL,
                 segments      TEXT,
                 speaker_count INTEGER,
                 speaker_names TEXT NOT NULL DEFAULT '{}',
                 waveform      BLOB NOT NULL,
                 audio_file    TEXT NOT NULL,
                 audio_bytes   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS transcripts_created
                 ON transcripts (created_at DESC);",
        )
        .map_err(|e| format!("Could not prepare the transcript library: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            audio_dir,
        })
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "The transcript library is unavailable.".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn save(
        &self,
        id: &str,
        title: &str,
        source_kind: &str,
        duration: Option<f64>,
        text: &str,
        words: &[Word],
        waveform: &[u8],
        audio_file: &str,
        audio_bytes: u64,
    ) -> Result<(), String> {
        let words_json =
            serde_json::to_string(words).map_err(|e| format!("Could not save the words: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO transcripts
                 (id, title, source_kind, created_at, duration, text, words,
                  word_count, waveform, audio_file, audio_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                title,
                source_kind,
                now_millis() as i64,
                duration,
                text,
                words_json,
                words.len() as i64,
                waveform,
                audio_file,
                audio_bytes as i64,
            ],
        )
        .map_err(|e| format!("Could not save the transcript: {e}"))?;
        Ok(())
    }

    pub(super) fn list(&self) -> Result<Vec<LibraryItem>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id, title, created_at, duration, word_count,
                        speaker_count, audio_bytes
                 FROM transcripts
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Could not read the library: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    duration: row.get(3)?,
                    word_count: row.get(4)?,
                    speaker_count: row.get(5)?,
                    audio_bytes: row.get(6)?,
                })
            })
            .map_err(|e| format!("Could not read the library: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Could not read the library: {e}"))
    }

    pub(super) fn get(&self, id: &str) -> Result<SavedTranscript, String> {
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT id, title, created_at, duration, text, words, segments,
                        speaker_count, speaker_names, waveform, audio_file
                 FROM transcripts WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<f64>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Vec<u8>>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("Could not read that transcript: {e}"))?;
        let Some((
            id,
            title,
            created_at,
            duration,
            text,
            words,
            segments,
            speaker_count,
            speaker_names,
            waveform,
            audio_file,
        )) = row
        else {
            return Err("That transcript is no longer in the library.".into());
        };
        let words: Vec<Word> = serde_json::from_str(&words)
            .map_err(|e| format!("The saved words are unreadable: {e}"))?;
        let segments: Option<Vec<Segment>> = segments
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| format!("The saved speaker labels are unreadable: {e}"))?;
        let speaker_names: HashMap<String, String> =
            serde_json::from_str(&speaker_names).unwrap_or_default();
        Ok(SavedTranscript {
            id,
            title,
            created_at,
            duration,
            audio_path: self
                .audio_dir
                .join(audio_file)
                .to_string_lossy()
                .into_owned(),
            audio_url: String::new(),
            waveform,
            text,
            words,
            segments,
            speaker_count: speaker_count.map(|value| value as u32),
            speaker_names,
        })
    }

    pub(super) fn update_analysis(
        &self,
        id: &str,
        segments: &[Segment],
        speaker_count: Option<u32>,
    ) -> Result<(), String> {
        let segments = serde_json::to_string(segments)
            .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE transcripts SET segments = ?2, speaker_count = ?3 WHERE id = ?1",
            params![id, segments, speaker_count.map(|value| value as i64)],
        )
        .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        Ok(())
    }

    pub(super) fn update_speaker_names(
        &self,
        id: &str,
        names: &HashMap<String, String>,
    ) -> Result<(), String> {
        let names = serde_json::to_string(names)
            .map_err(|e| format!("Could not save the speaker names: {e}"))?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE transcripts SET speaker_names = ?2 WHERE id = ?1",
            params![id, names],
        )
        .map_err(|e| format!("Could not save the speaker names: {e}"))?;
        Ok(())
    }

    pub(super) fn delete(&self, id: &str) -> Result<(), String> {
        let audio_file: Option<String> = {
            let conn = self.conn()?;
            conn.query_row(
                "SELECT audio_file FROM transcripts WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Could not read that transcript: {e}"))?
        };
        let Some(audio_file) = audio_file else {
            return Err("That transcript is no longer in the library.".into());
        };
        match std::fs::remove_file(self.audio_dir.join(audio_file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete the audio file: {error}")),
        }
        let conn = self.conn()?;
        conn.execute("DELETE FROM transcripts WHERE id = ?1", [id])
            .map_err(|e| format!("Could not delete the transcript: {e}"))?;
        Ok(())
    }
}
