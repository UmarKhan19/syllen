# AGENTS.md

## Verify changes

Run from the repo root:

| What | Command |
|---|---|
| Frontend typecheck and build | `npm run build` |
| Frontend unit tests | `npm test` |
| Rust tests | `cd src-tauri && cargo test` |
| Rust compile check | `cd src-tauri && cargo check --all-targets` |

`npm run build` runs `tsc` before `vite build`, so it is the typecheck. `tsconfig.json`
is strict and enables `noUnusedLocals` and `noUnusedParameters`. There is no lint or
format script: the repo has no ESLint, Prettier, rustfmt, or clippy config. Tests need
no models, network, sidecar install, or app launch.

## Map and ownership

| Path | Owns |
|---|---|
| `src/App.tsx` | App coordinator: state, every `invoke` and `listen` call, job progress, settings, library and export actions |
| `src/transcript.tsx` | Transcript rendering, paragraphs, timecodes, inline speaker rename |
| `src/player.tsx` | Playback bar, waveform, seek |
| `src/lib/merge.ts` | Word-to-speaker merge, passages, caption cues, SRT/VTT/TXT export |
| `src/lib/wav.ts` | WAV to Float32 samples for Who |
| `src/lib/who.ts`, `who-worker.ts`, `who-protocol.ts` | Diarization worker and its messages |
| `src/lib/types.ts` | TypeScript mirror of the Rust wire types |
| `src/lib/dateLabel.ts` | Library date labels |
| `src-tauri/src/lib.rs` | Tauri commands, tool resolution, job pipeline, audio move into the library (`persist_audio`, `save_to_library`), cancellation, cleanup, Rust tests |
| `src-tauri/src/library.rs` | SQLite schema and CRUD, library audio directory, row and audio deletion |
| `src-tauri/src/media.rs` | Loopback HTTP audio server with Range support |
| `src-tauri/src/contracts.rs` | Serde structs shared by the Rust modules; the wire shapes |
| `src-tauri/sidecar/server.mjs` | One Node process per job; Voz transcription, NDJSON on stdout |

`App.tsx` owns IPC and job coordination; `transcript.tsx` and `player.tsx` own their
local interaction and playback state. Put reusable logic in `src/lib/` as pure
functions, the pattern `merge.ts` and `wav.ts` follow. Extend these files and their
helpers, and add a focused module when it gives new behavior a coherent owner. Avoid
arbitrary fragmentation and generic wrappers.

## Contracts to keep in sync

- Types are mirrored by hand. `src/lib/types.ts` mirrors the `Serialize` structs in
  `src-tauri/src/contracts.rs`. Most wire types use camelCase through
  `#[serde(rename_all = "camelCase")]`; change both sides together. No bindings are
  generated. `JobStarted` is the exception: it returns `job_id` and has no TypeScript
  mirror because `App.tsx` ignores the return value.
- Media extensions are hand-synced: `MEDIA_EXTENSIONS` in `src/App.tsx` (file picker)
  and in `src-tauri/src/lib.rs` (backend check) must stay identical, 31 entries today.
- Tauri commands are the IPC surface: `check_tools`, `latest_yt_dlp_version`,
  `update_yt_dlp`, `file_info`, `start_job`, `cancel_job`, `save_text`,
  `list_library`, `load_transcript`, `delete_transcript`, `save_analysis`,
  `save_speaker_names`. Register a new one in `generate_handler!` in `lib.rs` and call
  it from `App.tsx`.
- Events: `job:progress`, `job:error`, `job:result`. Their payloads are
  `ProgressEvent`, `ErrorEvent`, and `JobResult` in `contracts.rs`; `App.tsx` listens
  for them.
- Sidecar protocol: one process per job, one JSON object per stdout line with
  `type: "progress" | "result" | "error"`. `SidecarEvent` in `contracts.rs` parses it
  and `server.mjs` writes it.
- Persisted user data: SQLite at app data `library.db` with WAL, and WAV files in app
  data `library/`. `library.rs` owns the schema, CRUD, audio directory, and deletion.
  No migration runner exists, so a schema change must include a tested migration that
  keeps existing rows readable. Only the user's delete action removes a library row or
  its audio. Speaker names are a JSON object keyed by the speaker number as a string.
- Job lifecycle: one job at a time. `start_job` deletes the previous `jobs/` dir and
  creates a new one. `check_cancel` runs between stages. `kill_tree` stops the tracked
  streaming child; `run_capture` (metadata) cannot be interrupted mid-call, so a cancel
  lands after that stage. A pipeline error removes the job dir. `run_pipeline` removes
  it only after the audio moves into the library, and keeps it for playback if the
  library save fails. `cleanup_jobs` clears `jobs/` at startup and on `RunEvent::Exit`.
- Playback: `media.rs` serves only the current WAV over `127.0.0.1` with Range
  support. Seeking depends on it because WebKitGTK cannot play from `asset://`.

## Tests

- `npm test` runs `src/lib/*.test.ts`: merge, captions, playback sync, WAV parsing,
  and date labels. These test pure functions.
- `cargo test` runs the tests in `src-tauri/src/lib.rs` under `#[cfg(test)]`: library
  round trip and delete, waveform peaks, media byte ranges, and job cache and file
  checks. They use `temp_path()` under the system temp dir and clean up after
  themselves.
- Nothing covers React components, App wiring, Tauri commands end to end, the sidecar
  protocol, or a full job run. Check those by hand under Xvfb (below) and say what you
  checked in your report.

## Running / testing the app

Never launch the app (or `npm run tauri dev`) on the real display. It steals focus,
creates windows on the user's desktop, and writes to their real library. Always run
it under Xvfb with isolated XDG dirs:

```sh
QC=/tmp/opencode/yt-qc
mkdir -p "$QC"/{data,config,cache}

Xvfb :99 -screen 0 1280x900x24 &
DISPLAY=:99 \
XDG_DATA_HOME="$QC/data" XDG_CONFIG_HOME="$QC/config" XDG_CACHE_HOME="$QC/cache" \
WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  npm run tauri dev
```

- Debug binary loads `devUrl` (localhost:1420), so either run `tauri dev` as above or
  build once with `npx tauri build --debug` and run `src-tauri/target/debug/yt-transcript`
  directly (then no vite needed).
- Screenshot: `DISPLAY=:99 import -window root /tmp/opencode/shot.png`
- Click/type: `DISPLAY=:99 xdotool ...`
- Cleanup when done: `pkill -f 'yt-transcript/node_modules/.bin/(tauri|vite)';
  pkill -f 'target/debug/yt-transcript'; pkill -f 'Xvfb :99'`

If `Xvfb` or `xdotool` is missing, ask the user to install
(`sudo pacman -S xorg-server-xvfb xdotool`). Do not fall back to the real display.

Xvfb has no GPU (software rendering) and no window manager, so GTK native dialogs
may map oddly. For quick CSS/layout checks, running only the frontend
(`npm run dev`) in a browser is fine; for anything touching the backend, use Xvfb.

Known Xvfb artifacts, not app bugs:

- Closing the window (`xdotool windowclose`) kills the process with a GDK
  `BadDrawable` X error, so Tauri's `RunEvent::Exit` cleanup never runs. Audio left
  in `jobs/` is expected; verify the startup sweep instead (restart the app).
- Save dialogs default to the process CWD because `downloadDir()` reads
  `~/.config/user-dirs.dirs`, which the isolated `XDG_CONFIG_HOME` does not have.
  The app's fallback path is working as designed.
