//! SQLite transcript storage and the corresponding saved audio files.

use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};

use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, Manager};

use crate::{
    contracts::{LibraryItem, SavedTranscript, Segment, Word},
    events::now_millis,
};

fn segments_words(segments: &[Segment]) -> Vec<Word> {
    segments
        .iter()
        .flat_map(|segment| segment.words.iter().cloned())
        .collect()
}

fn join_words(words: &[Word]) -> String {
    // Keep punctuation spacing in step with src/lib/transcript.ts::joinWords.
    words.iter().fold(String::new(), |mut text, word| {
        if !text.is_empty()
            && !word.text.chars().all(|c| {
                matches!(
                    c,
                    '.' | ',' | '!' | '?' | ';' | ':' | '…' | ')' | '»' | '"' | '\''
                )
            })
        {
            text.push(' ');
        }
        text.push_str(&word.text);
        text
    })
}

fn validate_word_edits(expected: &[Word], corrected: &[Word]) -> Result<(), String> {
    if expected.is_empty() || expected.len() != corrected.len() || expected.len() > 1_000_000 {
        return Err("The correction does not match the transcript word count.".into());
    }
    for (before, after) in expected.iter().zip(corrected) {
        if !before.start.is_finite()
            || !before.end.is_finite()
            || before.start != after.start
            || before.end != after.end
        {
            return Err("Word corrections cannot change timestamps.".into());
        }
        if after.text.trim().is_empty()
            || after.text != after.text.trim()
            || after.text.chars().count() > 512
            || after.text.chars().any(char::is_control)
        {
            return Err(
                "Each correction must contain up to 512 characters without control characters."
                    .into(),
            );
        }
    }
    Ok(())
}

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
        let segments_json = serde_json::to_string(segments)
            .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        let words_json: String = tx
            .query_row("SELECT words FROM transcripts WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| format!("Could not read the transcript words: {e}"))?
            .ok_or_else(|| "That transcript is no longer in the library.".to_string())?;
        let words: Vec<Word> = serde_json::from_str(&words_json)
            .map_err(|e| format!("The saved words are unreadable: {e}"))?;
        if segments_words(segments) != words {
            return Err("The transcript changed before speaker labels could be saved.".into());
        }
        tx.execute(
            "UPDATE transcripts SET segments = ?2, speaker_count = ?3 WHERE id = ?1",
            params![id, segments_json, speaker_count.map(|value| value as i64)],
        )
        .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Could not save the speaker labels: {e}"))?;
        Ok(())
    }

    pub(super) fn update_words(
        &self,
        id: &str,
        expected: &[Word],
        corrected: &[Word],
    ) -> Result<(), String> {
        validate_word_edits(expected, corrected)?;
        let mut conn = self.conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Could not save the corrections: {e}"))?;
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT words, segments FROM transcripts WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("Could not read the transcript: {e}"))?;
        let Some((words_json, segments_json)) = row else {
            return Err("That transcript is no longer in the library.".into());
        };
        let current: Vec<Word> = serde_json::from_str(&words_json)
            .map_err(|e| format!("The saved words are unreadable: {e}"))?;
        if current != expected {
            return Err(
                "This transcript changed elsewhere. Reload it before saving corrections.".into(),
            );
        }
        let next_segments = segments_json
            .map(|json| {
                let mut segments: Vec<Segment> = serde_json::from_str(&json)
                    .map_err(|e| format!("The saved speaker labels are unreadable: {e}"))?;
                if segments_words(&segments) != current {
                    return Err(
                        "The saved speaker labels no longer match the transcript words."
                            .to_string(),
                    );
                }
                let mut index = 0;
                for segment in &mut segments {
                    for word in &mut segment.words {
                        word.text.clone_from(&corrected[index].text);
                        index += 1;
                    }
                    segment.text = join_words(&segment.words);
                }
                serde_json::to_string(&segments)
                    .map_err(|e| format!("Could not save the speaker labels: {e}"))
            })
            .transpose()?;
        let words_json = serde_json::to_string(corrected)
            .map_err(|e| format!("Could not save the corrected words: {e}"))?;
        let text = join_words(corrected);
        let changed = tx
            .execute(
                "UPDATE transcripts SET text = ?2, words = ?3, segments = ?4 WHERE id = ?1",
                params![id, text, words_json, next_segments],
            )
            .map_err(|e| format!("Could not save the corrections: {e}"))?;
        if changed != 1 {
            return Err("That transcript is no longer in the library.".into());
        }
        tx.commit()
            .map_err(|e| format!("Could not save the corrections: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn words() -> Vec<Word> {
        vec![
            Word {
                text: "hello".into(),
                start: 0.0,
                end: 0.4,
            },
            Word {
                text: "world".into(),
                start: 0.4,
                end: 0.9,
            },
        ]
    }

    #[test]
    fn library_round_trips_a_transcript_and_deletes_its_audio() {
        let base = temp_path("library");
        let audio_dir = base.join("library");
        let library = Library::open_at(base.join("library.db"), audio_dir.clone()).unwrap();
        std::fs::create_dir_all(&audio_dir).unwrap();
        let audio = audio_dir.join("job-1.wav");
        std::fs::write(&audio, wav_bytes(&[1i16, 2, 3])).unwrap();
        library
            .save(
                "job-1",
                "A test recording",
                "file",
                Some(12.5),
                "hello world",
                &words(),
                &[10, 200, 30],
                "job-1.wav",
                6,
            )
            .unwrap();
        let items = library.list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A test recording");
        assert_eq!(items[0].word_count, 2);
        assert_eq!(items[0].speaker_count, None);
        assert_eq!(items[0].audio_bytes, 6);
        let saved = library.get("job-1").unwrap();
        assert_eq!(saved.words.len(), 2);
        assert_eq!(saved.waveform, vec![10, 200, 30]);
        assert_eq!(saved.segments, None);
        assert!(saved.audio_path.ends_with("job-1.wav"));
        drop(library);
        let library = Library::open_at(base.join("library.db"), audio_dir).unwrap();
        assert_eq!(library.list().unwrap().len(), 1);
        let segments = vec![Segment {
            speaker: Some(1),
            start: 0.0,
            end: 0.9,
            text: "hello world".into(),
            words: words(),
        }];
        library
            .update_analysis("job-1", &segments, Some(2))
            .unwrap();
        library
            .update_speaker_names(
                "job-1",
                &HashMap::from([("1".to_string(), "Ada".to_string())]),
            )
            .unwrap();
        let saved = library.get("job-1").unwrap();
        assert_eq!(saved.segments.unwrap()[0].speaker, Some(1));
        assert_eq!(saved.speaker_count, Some(2));
        assert_eq!(
            saved.speaker_names.get("1").map(String::as_str),
            Some("Ada")
        );
        library.delete("job-1").unwrap();
        assert!(!audio.exists());
        assert!(library.list().unwrap().is_empty());
        assert!(library.get("job-1").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn word_corrections_update_all_text_atomically_and_preserve_saved_metadata() {
        let base = temp_path("word-corrections");
        let library = Library::open_at(base.join("library.db"), base.join("library")).unwrap();
        let original = words();
        library
            .save(
                "correct-me",
                "Interview",
                "file",
                Some(12.0),
                "hello world",
                &original,
                &[4, 5],
                "correct-me.wav",
                9,
            )
            .unwrap();
        let segments = vec![Segment {
            speaker: Some(1),
            start: 0.0,
            end: 0.9,
            text: "hello world".into(),
            words: original.clone(),
        }];
        library
            .update_analysis("correct-me", &segments, Some(2))
            .unwrap();
        library
            .update_speaker_names("correct-me", &HashMap::from([("1".into(), "Ada".into())]))
            .unwrap();
        let mut corrected = original.clone();
        corrected[0].text = "Hello,".into();
        corrected[1].text = "dear listener.".into();
        library
            .update_words("correct-me", &original, &corrected)
            .unwrap();
        let saved = library.get("correct-me").unwrap();
        assert_eq!(saved.text, "Hello, dear listener.");
        assert_eq!(saved.words, corrected);
        let segments = saved.segments.unwrap();
        assert_eq!(segments[0].text, saved.text);
        assert_eq!(segments[0].speaker, Some(1));
        assert_eq!(segments[0].start, 0.0);
        assert_eq!(segments[0].end, 0.9);
        assert_eq!(segments[0].words[0].start, 0.0);
        assert_eq!(segments[0].words[1].end, 0.9);
        assert_eq!(saved.speaker_count, Some(2));
        assert_eq!(
            saved.speaker_names.get("1").map(String::as_str),
            Some("Ada")
        );
        assert_eq!(saved.waveform, vec![4, 5]);
        assert_eq!(library.list().unwrap()[0].word_count, 2);
        let mut stale = original.clone();
        stale[1].text = "world!".into();
        assert!(
            library
                .update_words("correct-me", &original, &stale)
                .is_err()
        );
        let after_stale = library.get("correct-me").unwrap();
        assert_eq!(after_stale.words, corrected);
        assert_eq!(after_stale.text, "Hello, dear listener.");
        let stale_segments = vec![Segment {
            speaker: Some(1),
            start: 0.0,
            end: 0.9,
            text: "hello world".into(),
            words: original,
        }];
        assert!(
            library
                .update_analysis("correct-me", &stale_segments, Some(2))
                .is_err()
        );
        let after_stale = library.get("correct-me").unwrap();
        assert_eq!(after_stale.words, corrected);
        assert_eq!(after_stale.text, "Hello, dear listener.");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn word_corrections_keep_the_flat_word_index_inside_two_saved_segments() {
        let base = temp_path("word-correction-segments");
        let library = Library::open_at(base.join("library.db"), base.join("library")).unwrap();
        let words = vec![
            Word {
                text: "Hello".into(),
                start: 0.0,
                end: 0.4,
            },
            Word {
                text: "there.".into(),
                start: 0.4,
                end: 0.9,
            },
            Word {
                text: "café".into(),
                start: 1.0,
                end: 1.3,
            },
            Word {
                text: "today?".into(),
                start: 1.3,
                end: 1.8,
            },
        ];
        library
            .save(
                "two-segments",
                "Two segments",
                "file",
                Some(2.0),
                "Hello there. café today?",
                &words,
                &[1],
                "two-segments.wav",
                1,
            )
            .unwrap();
        let segments = vec![
            Segment {
                speaker: Some(0),
                start: 0.0,
                end: 0.9,
                text: "Hello there.".into(),
                words: words[..2].to_vec(),
            },
            Segment {
                speaker: Some(1),
                start: 1.0,
                end: 1.8,
                text: "café today?".into(),
                words: words[2..].to_vec(),
            },
        ];
        library
            .update_analysis("two-segments", &segments, Some(2))
            .unwrap();
        let mut corrected = words.clone();
        corrected[1].text = "there, indeed.".into();
        corrected[2].text = "café…".into();
        library
            .update_words("two-segments", &words, &corrected)
            .unwrap();
        let saved = library.get("two-segments").unwrap();
        assert_eq!(saved.text, "Hello there, indeed. café… today?");
        let segments = saved.segments.unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Hello there, indeed.");
        assert_eq!(segments[1].text, "café… today?");
        assert_eq!(segments[0].speaker, Some(0));
        assert_eq!(segments[1].speaker, Some(1));
        assert_eq!((segments[0].start, segments[0].end), (0.0, 0.9));
        assert_eq!((segments[1].start, segments[1].end), (1.0, 1.8));
        assert_eq!(segments[1].words[0].start, words[2].start);
        assert_eq!(segments[1].words[1].end, words[3].end);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn word_corrections_validate_before_writing_and_support_rows_without_analysis() {
        let base = temp_path("word-corrections-legacy");
        let library = Library::open_at(base.join("library.db"), base.join("library")).unwrap();
        let original = words();
        library
            .save(
                "legacy",
                "Old",
                "file",
                None,
                "hello world",
                &original,
                &[1],
                "legacy.wav",
                3,
            )
            .unwrap();
        let mut invalid = original.clone();
        invalid[0].start += 0.1;
        assert!(library.update_words("legacy", &original, &invalid).is_err());
        invalid = original.clone();
        invalid[0].text = "  ".into();
        assert!(library.update_words("legacy", &original, &invalid).is_err());
        invalid = original.clone();
        invalid.push(invalid[1].clone());
        assert!(library.update_words("legacy", &original, &invalid).is_err());
        assert!(
            library
                .update_words("missing", &original, &original)
                .is_err()
        );
        assert_eq!(library.get("legacy").unwrap().words, original);
        let mut corrected = original.clone();
        corrected[1].text = "世界 🌍".into();
        library
            .update_words("legacy", &original, &corrected)
            .unwrap();
        let saved = library.get("legacy").unwrap();
        assert_eq!(saved.text, "hello 世界 🌍");
        assert_eq!(saved.words, corrected);
        assert!(saved.segments.is_none());
        assert_eq!(library.list().unwrap()[0].word_count, 2);
        let _ = std::fs::remove_dir_all(base);
    }
}
