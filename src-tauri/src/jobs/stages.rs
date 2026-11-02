use std::{
    path::{Path, PathBuf},
    process::Command,
};

use tauri::AppHandle;

use crate::{
    events::emit_progress,
    job_control::JobControl,
    process::{run_capture, run_streaming, tail},
    tools::Tools,
};

const YT_DLP_WAV_POSTPROCESSOR_ARGS: [&str; 2] = [
    "--postprocessor-args",
    "ExtractAudio+ffmpeg_o:-af aformat=sample_fmts=s16,aresample=16000 -ac 1 -ar 16000",
];

fn prepend_tool_path(cmd: &mut Command, tools: &Tools) {
    let Some(dir) = tools
        .ffmpeg
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return;
    };
    let probe = if cfg!(windows) {
        dir.join("ffprobe.exe")
    } else {
        dir.join("ffprobe")
    };
    if !probe.is_file() {
        return;
    }
    let current: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Ok(joined) = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(current)) {
        cmd.env("PATH", joined);
    }
}

pub(super) fn fetch_metadata(tools: &Tools, url: &str) -> Result<(String, Option<f64>), String> {
    let mut cmd = Command::new(&tools.yt_dlp);
    cmd.args([
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-warnings",
        "-J",
        url,
    ]);
    let (stdout, stderr, status) = run_capture(&mut cmd)?;
    if !status.success() {
        return Err(format!(
            "yt-dlp could not read this video.\n{}",
            tail(&stderr.lines().map(str::to_string).collect::<Vec<_>>())
        ));
    }
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("yt-dlp returned metadata the app could not read: {e}"))?;
    if value.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        return Err("That link is a playlist. Paste a single video link.".into());
    }
    if value
        .get("is_live")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return Err("Live streams are not supported. Try a finished video.".into());
    }
    let title = value
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let duration = value.get("duration").and_then(|d| d.as_f64());
    Ok((title, duration))
}

pub(super) fn download(
    tools: &Tools,
    url: &str,
    dir: &Path,
    app: &AppHandle,
    id: &str,
    control: &JobControl,
) -> Result<(), String> {
    let template = dir.join("audio.%(ext)s");
    let mut cmd = Command::new(&tools.yt_dlp);
    cmd.args([
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-warnings",
        "--no-colors",
        "--newline",
        "--progress-template",
        "download:%(progress._percent_str)s",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "wav",
    ]);
    cmd.args(YT_DLP_WAV_POSTPROCESSOR_ARGS);
    prepend_tool_path(&mut cmd, tools);
    cmd.arg("-o").arg(&template).arg(url);
    let (status, stderr) = run_streaming(&mut cmd, control, &mut |line| {
        if let Some(rest) = line.strip_prefix("download:")
            && let Ok(percent) = rest.trim().trim_end_matches('%').trim().parse::<f64>()
        {
            emit_progress(app, id, "download", Some(percent / 100.0));
        }
    })?;
    if !status.success() {
        return Err(format!("Download failed.\n{}", tail(&stderr)));
    }
    emit_progress(app, id, "download", Some(1.0));
    if !dir.join("audio.wav").is_file() {
        let found = std::fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("audio.") && !name.ends_with(".part"))
            });
        match found {
            Some(path) => std::fs::rename(&path, dir.join("audio.wav"))
                .map_err(|e| format!("Could not prepare the downloaded audio: {e}"))?,
            None => return Err("The download finished but no audio file was produced.".into()),
        }
    }
    Ok(())
}

pub(super) fn convert(
    tools: &Tools,
    input: &Path,
    dir: &Path,
    control: &JobControl,
) -> Result<PathBuf, String> {
    let output = dir.join("audio16.wav");
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&output);
    let (status, stderr) = run_streaming(&mut cmd, control, &mut |_| {})?;
    if !status.success() {
        return Err(format!(
            "Could not convert the audio to 16 kHz mono.\n{}",
            tail(&stderr)
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yt_dlp_wav_filter_preserves_pcm16_before_resampling() {
        assert_eq!(YT_DLP_WAV_POSTPROCESSOR_ARGS[0], "--postprocessor-args");
        assert!(YT_DLP_WAV_POSTPROCESSOR_ARGS[1].starts_with("ExtractAudio+ffmpeg_o:-af "));
        assert!(
            YT_DLP_WAV_POSTPROCESSOR_ARGS[1].contains("aformat=sample_fmts=s16,aresample=16000")
        );
        assert!(YT_DLP_WAV_POSTPROCESSOR_ARGS[1].ends_with("-ac 1 -ar 16000"));
    }
}
