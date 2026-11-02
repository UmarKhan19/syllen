use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

/// Peak amplitudes for the player's waveform, one byte per bucket.
pub(super) fn wav_peaks(path: &Path, buckets: usize) -> Result<Vec<u8>, String> {
    let mut file =
        File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .len();
    let mut riff = [0u8; 12];
    file.read_exact(&mut riff)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("Not a WAV file".into());
    }
    let mut offset = 12u64;
    loop {
        if offset + 8 > len {
            return Err("The WAV file has no audio data".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as u64;
        if &header[0..4] == b"data" {
            return peaks_from_pcm(&mut file, size.min(len - offset - 8), buckets)
                .map_err(|e| format!("Could not read the waveform: {e}"));
        }
        offset += 8 + size + (size & 1);
    }
}

fn peaks_from_pcm(reader: &mut impl Read, bytes: u64, buckets: usize) -> std::io::Result<Vec<u8>> {
    let buckets = buckets.max(1);
    let samples = bytes / 2;
    let per_bucket = (samples / buckets as u64).max(1);
    let mut peaks = Vec::with_capacity(buckets);
    let mut buffer = [0u8; 8192];
    let mut seen = 0u64;
    let mut bucket_end = per_bucket;
    let mut loudest = 0u16;
    let mut remaining = samples * 2;
    while remaining >= 2 {
        let take = buffer.len().min(remaining as usize) & !1;
        reader.read_exact(&mut buffer[..take])?;
        remaining -= take as u64;
        for pair in buffer[..take].as_chunks::<2>().0 {
            loudest = loudest.max(i16::from_le_bytes(*pair).unsigned_abs());
            seen += 1;
            if seen >= bucket_end {
                peaks.push((u32::from(loudest.min(32767)) * 255 / 32767) as u8);
                loudest = 0;
                bucket_end += per_bucket;
                if peaks.len() == buckets {
                    return Ok(peaks);
                }
            }
        }
    }
    if seen > 0 && peaks.len() < buckets {
        peaks.push((u32::from(loudest) * 255 / 32767) as u8);
    }
    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "yt-transcript-peaks-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn waveform_peaks_follow_the_pcm_data() {
        let path = temp_path();
        let samples = [0i16, 1000, -32768, 2000, -100, 300, 400, 500];
        std::fs::write(&path, wav_bytes(&samples)).unwrap();
        let peaks = wav_peaks(&path, 4).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(peaks.len(), 4);
        assert_eq!(peaks[0], (1000 * 255 / 32767) as u8);
        assert_eq!(peaks[1], 255);
        assert_eq!(peaks[3], (500 * 255 / 32767) as u8);
    }

    #[test]
    fn waveform_peaks_survive_odd_reads() {
        struct Trickle {
            data: Vec<u8>,
            position: usize,
        }
        impl Read for Trickle {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.position >= self.data.len() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.data[self.position];
                self.position += 1;
                Ok(1)
            }
        }
        let mut data = Vec::new();
        for sample in [1000i16, -2000, 3000, -4000] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let mut reader = Trickle { data, position: 0 };
        let peaks = peaks_from_pcm(&mut reader, 8, 2).unwrap();
        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks[0], (2000 * 255 / 32767) as u8);
        assert_eq!(peaks[1], (4000 * 255 / 32767) as u8);
    }
}
