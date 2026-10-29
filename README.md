# YT Transcript

Paste a YouTube link, get a speaker-labelled transcript on your own machine. Audio is downloaded to a temporary folder, transcribed locally with [Voz](https://huggingface.co/desert-ant-labs/voz), and split into speakers with [Who](https://huggingface.co/desert-ant-labs/who). Nothing is uploaded to a transcription service.

- Speaker-labelled transcript with word timestamps
- Waveform playback with play/pause and seek; the transcript follows the current passage and word
- Export as SRT, VTT, or plain text
- Tauri 2 + React + TypeScript desktop app for Linux, macOS, and Windows

Tested on Linux (Arch, WebKitGTK). The macOS and Windows builds use the same webview APIs and Node SDK but have not been verified on those systems yet.

## What it does

1. Reads the video metadata with `yt-dlp`.
2. Downloads the audio track and converts it to 16 kHz mono WAV with `ffmpeg`.
3. Transcribes it with Voz in a Node sidecar.
4. Labels the speakers with Who in the webview.
5. Serves the WAV to the player over a loopback HTTP port with byte ranges, so the transcript can be read along with the audio.
6. Deletes the downloaded audio when the app closes, or on the next start after a crash.

First run downloads the Voz model (350 MB) and the Who model (32 MB). They are cached for later runs.

## What it does not do yet

- **No filler-word removal.** Uhm is Apple-only and its Linux path needs custom ONNX glue. The transcript keeps "uh" and "um" for now.
- **No Align pass.** Voz already returns word-level timestamps at 80 ms resolution, which is enough for captions. Align is only useful if you need tighter cut points.
- **English only.** Voz supports 25 languages but does not detect them, and a wrong guess produces fluent nonsense. A language picker and automatic routing come later.
- **No playlists or live streams.** Single, finished videos only.
- **Up to four speakers.** Who numbers the four most present voices. On a short single-speaker clip it can split one voice into two; longer conversations are more stable.

## How it works

```
React + TypeScript (Tauri webview)
        │  invoke / events
        ▼
Rust core: yt-dlp · ffmpeg · temp files · job state
        │  NDJSON over stdout
        ▼
Node sidecar: Voz (onnxruntime-node)
```

Who runs in the webview through its browser WASM build, so diarization works on every platform without a native module. The Node sidecar is only needed for Voz, whose SDK has no Rust or Python equivalent.

Who runs in a background worker, loaded on demand: the first diarization pays its 44 MB WASM load and compile, but startup and the rest of the UI never wait for it. The WAV is parsed to samples in that worker, which skips Web Audio's 44.1 kHz decode and keeps the window responsive on long recordings.

Playback needs its own local server. WebKitGTK cannot load audio from Tauri's `asset://` protocol (WebKit bug 146351, still open), so the Rust side binds a random loopback port and serves the one current WAV file with `Range` support. The player streams it, seeks instantly, and the transcript syncs from the word timestamps Voz already returned. The port only listens on `127.0.0.1` and serves only the job's audio.

## Requirements

- Node.js 20 or newer
- Rust 1.85 or newer
- Tauri 2 prerequisites: on Linux `webkit2gtk-4.1`, `libappindicator-gtk3`, `librsvg`; on macOS Xcode Command Line Tools; on Windows WebView2 and the MSVC build tools
- Linux audio playback also needs WebKitGTK's GStreamer plugins (`gstreamer`, `gst-plugins-base`, `gst-plugins-good`)
- `ffmpeg` and `ffprobe` in `PATH`, or dropped into `src-tauri/resources/bin/`
- `yt-dlp` in `PATH` or `src-tauri/resources/bin/`, or installed from the Settings panel

## Run from source

```bash
npm install
npm run sidecar:install
npm run tauri dev
```

`sidecar:install` installs `@desert-ant-labs/voz` and `onnxruntime-node` into `src-tauri/sidecar`. Its `.npmrc` sets `ignore-scripts=true` on purpose: `onnxruntime-node`'s postinstall tries to resolve CUDA packages from NuGet and fails on many machines, while the CPU binary it needs is already in the npm tarball.

## Build a bundle

```bash
npm run sidecar:prepare   # copies the current Node binary and prunes onnxruntime to this platform
npm run tauri build
```

`sidecar:prepare` copies `process.execPath` to `src-tauri/sidecar/node` and removes the other platforms' ONNX Runtime binaries. Tauri bundles `src-tauri/sidecar/**` and `src-tauri/resources/bin/*` as resources. Without the copied Node binary, the app falls back to `node` in `PATH`.

Build on each target OS. The Node binary, ONNX Runtime, and the desktop libraries are platform-specific, so cross-compiling a release is not supported.

### Settings

The gear button opens a drawer with two controls:

- **Speaker labeling.** Turns Who on or off for the next transcription. Off skips the 32 MB model download and the diarization pass; SRT, VTT, and TXT exports then omit speaker prefixes.
- **Update yt-dlp.** Checks the latest release on GitHub and shows **Up to date** or **Update available**. The button downloads the latest official standalone `yt-dlp` into the app data folder (`bin/yt-dlp` or `bin/yt-dlp.exe`) and prefers it over `PATH` and the bundled copy. The system install is not modified, so a pip- or package-managed `yt-dlp` is safe. The check and the update need network access to GitHub.

### Bundling yt-dlp and ffmpeg

Put the binaries in `src-tauri/resources/bin/`:

- Linux/macOS: `yt-dlp`, `ffmpeg`, `ffprobe`
- Windows: `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`

Resolving order for `yt-dlp`: the app data copy from Settings, then `src-tauri/resources/bin/`, then `PATH`. For `ffmpeg`/`ffprobe`: the resources folder, then `PATH`. If you redistribute ffmpeg, check the license of the build you ship (LGPL vs GPL) and include the notices.

## Models and licenses

The app code is MIT (see `LICENSE`). The models and SDKs are not:

- **Voz** weights v0.5.0, SDK 4.2.0. Built on NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0).
- **Who** v0.3.4. Built on Desert Ant Labs' own model.
- Both are under the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0): free under 100,000 monthly active devices per model per platform, attribution required, commercial license above that.
- On load, the SDK requests the current month's model license from Desert Ant Labs. It sends a random install id, the model id and revision, the SDK version, the platform, and the app id. It sends no audio, text, or transcript. Offline, the models still run.
- The footer shows "Powered by Desert Ant Labs", which satisfies the attribution requirement.

`yt-dlp` is Unlicense. `ffmpeg` is LGPL or GPL depending on the build.

## Privacy

The audio never leaves the machine after the download. The network is used for:

- YouTube, through `yt-dlp`, to fetch the audio
- `github.com/yt-dlp/yt-dlp`, when you press Update yt-dlp in Settings
- `huggingface.co` and `cdn.jsdelivr.net`, on first run, to download model files
- Desert Ant Labs' license server, for the monthly model license request

Downloaded audio lives in the app cache (`app_cache_dir/jobs`) and is removed on exit or when the next job starts. Model files live in `~/.cache/desert-ant-models` and the webview's cache.

Downloading videos from YouTube may violate its terms of service. Use this for content you have the right to process.

## Design

The interface is a document surface: one paper ground, black ink, hairline
rules, and colour reserved for the speaker labels. The chrome is set in
[Schibsted Grotesk](https://fonts.google.com/specimen/Schibsted+Grotesk), the
transcript in [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4),
and the timecodes in [Spline Sans Mono](https://fonts.google.com/specimen/Spline+Sans+Mono).
All three are self-hosted in `public/fonts/` under the SIL Open Font License
1.1, and the licence texts ship beside the font files.

## Development

```bash
npm run build        # type-check and build the frontend
npm test             # transcript merge and caption formatting
cd src-tauri && cargo check
```

The interesting frontend logic is in `src/lib/merge.ts`: assigning each word to whoever spoke it, grouping words into readable segments, and splitting captions. The Rust pipeline is in `src-tauri/src/lib.rs`.

## License

MIT for this application. Model weights and the Desert Ant SDKs keep their own license, linked above.
