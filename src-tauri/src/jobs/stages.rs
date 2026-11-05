use std::{
    path::{Path, PathBuf},
    process::Command,
};

use tauri::AppHandle;

use crate::{
    events::emit_progress,
    job_control::JobControl,
    process::{run_capture, run_streaming, tail},
    thermal::JobThermalGuard,
    tools::Tools,
};

fn yt_dlp_postprocessor_args(cpu_threads: usize) -> [String; 2] {
    [
        format!(
            "ExtractAudio+ffmpeg_i:-threads {cpu_threads} -filter_threads {cpu_threads} -filter_complex_threads {cpu_threads}"
        ),
        format!(
            "ExtractAudio+ffmpeg_o:-threads {cpu_threads} -af aformat=sample_fmts=s16,aresample=16000 -ac 1 -ar 16000"
        ),
    ]
}

fn configure_ffmpeg_conversion(cmd: &mut Command, input: &Path, output: &Path, cpu_threads: usize) {
    let threads = cpu_threads.to_string();
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        &threads,
        "-filter_threads",
        &threads,
        "-filter_complex_threads",
        &threads,
        "-i",
    ])
    .arg(input)
    .args([
        "-threads",
        &threads,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
    ])
    .arg(output);
}

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
        "--",
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

#[allow(clippy::too_many_arguments)]
pub(super) fn download(
    tools: &Tools,
    url: &str,
    dir: &Path,
    app: &AppHandle,
    id: &str,
    control: &JobControl,
    cpu_threads: usize,
    thermal_guard: &JobThermalGuard,
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
    for args in yt_dlp_postprocessor_args(cpu_threads) {
        cmd.args(["--postprocessor-args", &args]);
    }
    prepend_tool_path(&mut cmd, tools);
    cmd.arg("-o").arg(&template).arg("--").arg(url);
    let (status, stderr) = run_streaming(&mut cmd, control, thermal_guard, &mut |line| {
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
    cpu_threads: usize,
    thermal_guard: &JobThermalGuard,
) -> Result<PathBuf, String> {
    let output = dir.join("audio16.wav");
    let mut cmd = Command::new(&tools.ffmpeg);
    configure_ffmpeg_conversion(&mut cmd, input, &output, cpu_threads);
    let (status, stderr) = run_streaming(&mut cmd, control, thermal_guard, &mut |_| {})?;
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
        let [input, output] = yt_dlp_postprocessor_args(3);
        assert!(input.starts_with(
            "ExtractAudio+ffmpeg_i:-threads 3 -filter_threads 3 -filter_complex_threads 3"
        ));
        assert!(output.starts_with("ExtractAudio+ffmpeg_o:-threads 3 -af "));
        assert!(output.contains("aformat=sample_fmts=s16,aresample=16000"));
        assert!(output.ends_with("-ac 1 -ar 16000"));
    }

    #[test]
    fn ffmpeg_decoder_filters_and_encoder_are_thread_capped_in_position() {
        let mut command = Command::new("ffmpeg");
        configure_ffmpeg_conversion(
            &mut command,
            Path::new("input.wav"),
            Path::new("out.wav"),
            3,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let input = args.iter().position(|arg| arg == "-i").unwrap();
        let encoder_threads = args.iter().rposition(|arg| arg == "-threads").unwrap();
        assert!(
            args[..input]
                .windows(2)
                .any(|pair| pair == ["-threads", "3"])
        );
        assert!(
            args[..input]
                .windows(2)
                .any(|pair| pair == ["-filter_threads", "3"])
        );
        assert_eq!(args[encoder_threads], "-threads");
        assert_eq!(args[encoder_threads + 1], "3");
    }
}
