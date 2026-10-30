# YT Transcript

YT Transcript turns a YouTube link or a local video or audio file into a speaker-labeled transcript with word-level timestamps. Speech recognition and speaker labeling run on your machine. Finished transcripts and their audio stay in a local library, and no audio or transcript is uploaded to a transcription service.

Version 0.1.0, tested on Linux. macOS and Windows builds use the same webview APIs and Node SDK but have not been verified on those systems.

## Features

- Speaker-labeled transcript with word timestamps at 80 ms resolution.
- Local library in SQLite. Reopen a transcript, rename its speakers, export it, or delete it with its audio.
- Waveform playback with click-to-seek. The transcript follows the current passage and word, and following can be turned off.
- Export as SRT, VTT, or TXT, or copy the transcript to the clipboard.
- Speaker labeling can be switched off to skip the 32 MB speaker model and the diarization pass.

## Requirements

- Node.js 20 or newer and Rust 1.85 or newer.
- Tauri 2 prerequisites for your OS. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for package names.
- `ffmpeg` and `ffprobe` in `PATH`, or in `src-tauri/resources/bin/`.
- `yt-dlp` for YouTube links. It can live in `PATH`, in `src-tauri/resources/bin/`, or in the app data folder after an update from Settings. Local file jobs do not need it.
- On Linux, GStreamer base and good plugins for audio playback.
- About 380 MB for the two models on first run, plus disk space for the library.

## Run from source

```bash
npm install
npm run sidecar:install
npm run tauri dev
```

`sidecar:install` installs the Voz SDK and `onnxruntime-node` into `src-tauri/sidecar`. The sidecar's npm config skips lifecycle scripts on purpose. `onnxruntime-node`'s postinstall tries to resolve CUDA packages from NuGet and fails on many machines. The CPU binary it needs is already in the npm tarball.

On first use, Voz downloads about 350 MB and Who about 32 MB. Both are cached for later runs.

## Using the app

1. Paste a URL, choose a file with Upload, or drop a file on the window.
2. Select Transcribe. Link jobs show Download, Prepare, Transcribe, and, when labeling is on, Speakers. File jobs start at Prepare.
3. Cancel stops the download, conversion, or transcription. Speaker labeling runs in a background worker and cannot be cancelled once it starts, but the window stays responsive.
4. When the job finishes, the player and transcript appear. Click a timecode or a word to seek. Click a speaker name to rename it; the name applies to every passage and every export.
5. Use Copy, SRT, VTT, or TXT. The Library button lists saved transcripts, and the newest three also appear on the idle screen.

## How it works

```
React + TypeScript (Tauri webview)
        │ invoke / events
        ▼
Rust core: yt-dlp, ffmpeg, SQLite library, loopback audio server
        │ NDJSON over stdout
        ▼
Node sidecar: Voz speech recognition (onnxruntime-node)
```

Who runs in the webview through its browser WASM build, so diarization works without a native module.

The pipeline:

1. Read the video metadata with `yt-dlp`. Live streams are rejected, and playlists are not expanded.
2. Download the best audio with `yt-dlp` and extract it to WAV. Local files skip this step and are read in place.
3. Convert to 16 kHz mono PCM16 WAV with `ffmpeg`.
4. Transcribe with Voz in the Node sidecar. It returns the text, word timestamps, and duration.
5. Compute a 2,000-bucket waveform, move the WAV into the library, and save the transcript, words, and audio size to SQLite.
6. Point the loopback audio server at the saved WAV and send the result to the UI. The player streams it from that URL.
7. The UI labels the speakers with Who in a web worker. The worker parses the WAV into Float32 samples, runs the model, and returns speaker turns. The app assigns each word to the speaker with the largest overlap, groups words into readable passages, and saves the segments and speaker count to the same row.
8. Clean up the job cache once the audio is in the library. The library copy stays until you delete it.

A few implementation choices shape the design:

- The Node sidecar exists because Voz has no Rust binding. It runs one process per job and streams NDJSON events on stdout.
- Who runs in a worker because its WASM bundle and compile would otherwise block the interface. The worker is loaded on first diarization and reused.
- Playback needs a local server because WebKitGTK cannot play media from Tauri's `asset://` protocol. The server binds `127.0.0.1` on a random port, serves only the current WAV, and supports `Range` requests for seeking.

## Data and storage

| Data | Location | Notes |
|---|---|---|
| Library database | app data / `library.db` | SQLite with WAL |
| Saved audio | app data / `library/<job>.wav` | 16 kHz mono PCM16, about 115 MB per hour |
| Job cache | app cache / `jobs/` | Cleared at startup and after a successful save |
| Managed `yt-dlp` | app data / `bin/yt-dlp` | Installed from Settings; the system copy is untouched |
| Models | the SDK model cache (`~/.cache/desert-ant-models` on Linux) and the webview cache | Downloaded on first use |

The app data folder uses the bundle identifier `app.yttranscript.desktop`. Typical locations:

- Linux: data in `~/.local/share/app.yttranscript.desktop`, cache in `~/.cache/app.yttranscript.desktop`
- macOS: data in `~/Library/Application Support/app.yttranscript.desktop`, cache in `~/Library/Caches/app.yttranscript.desktop`
- Windows: data in `%APPDATA%\app.yttranscript.desktop`, cache in `%LOCALAPPDATA%\app.yttranscript.desktop`

The library survives restarts. The job cache does not. Audio is kept as the same uncompressed WAV used for transcription, so a one-hour recording takes roughly 115 MB. The library shows the size of each recording and the total.

## Inputs and exports

URLs: any `http` or `https` URL that `yt-dlp` can read as a single video. YouTube is the tested path. The app does not expand playlists and rejects live streams.

Files: one local video or audio file with one of these extensions.

- Video: `mp4`, `m4v`, `mov`, `mkv`, `webm`, `avi`, `mpg`, `mpeg`, `wmv`, `flv`, `ts`, `m2ts`, `3gp`, `3g2`, `ogv`
- Audio: `mp3`, `m4a`, `m4b`, `wav`, `flac`, `ogg`, `oga`, `opus`, `aac`, `wma`, `aiff`, `aif`, `amr`, `au`, `caf`, `ac3`

The original file is read in place and never modified. One job runs at a time.

English is the only supported language for now. Voz can transcribe other languages, but the app has no language picker and does not detect the language.

Exports:

- SRT with `[Speaker 1]` prefixes.
- VTT with `<v Speaker 1>` voice tags.
- TXT with `[0:00] Speaker 1: text` passages, separated by a blank line.
- Copy uses the TXT format.

Speaker prefixes are omitted when speaker labeling is off. Caption cues split at sentence ends, with character and duration limits, rather than at fixed intervals.

## Settings

- **Speaker labeling** turns Who on or off. Off skips the model download and the diarization pass. The setting is stored in the webview's local storage.
- **yt-dlp** shows the installed version, checks the latest GitHub release, and can download the official standalone binary into the app data folder. The system install is not modified.

Settings apply to the next transcription. They are disabled while a job runs.

## Privacy and network

Audio never leaves the machine. Local files are read in place and never modified. The app has no accounts, API keys, analytics, or crash reporting.

The network is used for:

- The media host, through `yt-dlp`, when you transcribe a URL.
- `github.com/yt-dlp/yt-dlp` when you check for or install a `yt-dlp` update.
- `huggingface.co` and `cdn.jsdelivr.net` on first use, to download model files and the LiteRT runtime.
- Desert Ant Labs' license server when a model loads. The request includes the model ID and revision, SDK version, platform, app ID, and a random installation ID. It does not include audio, text, or the transcript.

Downloaded media lives in the job cache while a job runs. Finished audio moves to the library and stays there until you delete it. Models live in the SDK's cache (`~/.cache/desert-ant-models` on Linux) and the webview cache.

Downloading videos from YouTube may violate its terms of service. Use this for content you have the right to process.

## Limitations

- English only, with no language detection or picker.
- One video or file at a time. No queue. Playlists are not expanded, and live streams are rejected.
- Speaker labels are best effort. Who numbers speakers in order of first appearance, and the transcript has four speaker colors that repeat after four. Short clips can split one voice into two.
- The transcript text is read-only. You can rename speakers, but not edit words or rename a transcript.
- Audio is stored as uncompressed 16 kHz mono WAV, about 115 MB per hour.
- Filler words are kept. There is no filler-word removal pass.
- Linux is tested. macOS and Windows builds have not been verified.

## Build a bundle

```bash
npm run tauri:build
```

The script runs `sidecar:prepare` first. That copies the current Node binary into `src-tauri/sidecar/` and removes the ONNX Runtime binaries for other platforms. Tauri then bundles `src-tauri/sidecar/**` and `src-tauri/resources/bin/*` as resources.

Build on each target OS. The Node binary, ONNX Runtime, and desktop libraries are platform-specific, so cross-compiling a release is not supported.

If `src-tauri/sidecar/node` is missing, the app falls back to `node` in `PATH`.

### Bundling yt-dlp and ffmpeg

Put the binaries in `src-tauri/resources/bin/`:

- Linux and macOS: `yt-dlp`, `ffmpeg`, `ffprobe`
- Windows: `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`

Resolution order for `yt-dlp`: the app data copy from Settings, then `src-tauri/resources/bin/`, then `PATH`. For `ffmpeg` and `ffprobe`: the resources folder, then `PATH`.

If you redistribute ffmpeg, check the license of the build you ship (LGPL or GPL) and include the notices.

## Development

```bash
npm run build        # tsc typecheck, then vite build
npm test             # Vitest: merge, captions, playback sync, WAV parsing, date labels
cd src-tauri
cargo test           # library, waveform, media server, and file checks
```

Project layout:

```
src/                 App coordinator, transcript view, player, styles
src/lib/             pure helpers: merge and captions, WAV parsing, Who worker, date labels, types
src-tauri/src/       lib.rs (commands, tools, job lifecycle), library.rs (SQLite and audio),
                     media.rs (loopback audio server), contracts.rs (wire types)
src-tauri/sidecar/   Node bridge to Voz
```

`src/lib/merge.ts` holds the transcript logic: assigning words to speakers, grouping them into passages, and splitting caption cues. `src-tauri/src/lib.rs` runs the pipeline; `library.rs` stores transcripts and their audio.

`AGENTS.md` maps file ownership, the TypeScript/Rust and sidecar contracts, and the verification commands. The app writes to your real app data folder. For UI work, run it under Xvfb with isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`; `AGENTS.md` has the commands.

More context lives in `PRODUCT.md` (users, principles, constraints) and `DESIGN.md` (visual system, typography, components).

## Troubleshooting

| Problem | Fix |
|---|---|
| "Missing tools: ffmpeg + ffprobe" | Install them, or put the binaries in `src-tauri/resources/bin/`, then reopen Settings. |
| "YouTube links need yt-dlp" | Install it from Settings, or put it in `PATH` or `src-tauri/resources/bin/`. Local files work without it. |
| "Speaker labels unavailable" | The Who model or worker failed. The transcript is saved without labels. Check access to Hugging Face and jsDelivr, then transcribe again. |
| "Playback unavailable" | On Linux, install the GStreamer base and good plugins. The transcript and exports still work. |
| "The speech sidecar is missing" | Run `npm run sidecar:install` in development, or rebuild the bundle with `npm run tauri:build`. |
| Model download fails | The first run needs access to Hugging Face and jsDelivr. Check the network and try again. |

## Licenses and attribution

The application code is MIT. See `LICENSE`.

The models are [Voz](https://huggingface.co/desert-ant-labs/voz) and [Who](https://huggingface.co/desert-ant-labs/who). The Voz and Who SDKs are under the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0). The model weights they download are distributed under the same license unless a model card says otherwise. The license is free below 100,000 monthly active devices per model per platform. It requires attribution, and a commercial license is required above that threshold. It does not allow using the models or their outputs to train a competing on-device model.

The footer text "Powered by Desert Ant Labs Voz and Who" satisfies the attribution requirement and must stay.

`yt-dlp` is Unlicense. `ffmpeg` is LGPL or GPL depending on the build. The three interface fonts are self-hosted under the SIL Open Font License 1.1, with the license texts in `public/fonts/`.
