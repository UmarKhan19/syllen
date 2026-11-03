# AGENTS.md

## Verify changes

Run from the repo root:

| What | Command |
|---|---|
| Frontend typecheck and build | `npm run build` |
| Frontend lint | `npm run lint` |
| Check frontend formatting (non-writing) | `npm run format:check` |
| Format frontend source (writes files) | `npm run format` |
| Frontend unit tests | `npm test` |
| Rust formatting check | `cd src-tauri && cargo fmt --all -- --check` |
| Rust lint | `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings` |
| Rust tests | `cd src-tauri && cargo test` |
| Optional pre-push suite | `npm run prepush` |

`npm run build` runs `tsc` before `vite build`, so it is the typecheck. `tsconfig.json`
is strict and enables `noUnusedLocals` and `noUnusedParameters`. Biome handles frontend
linting and formatting for `src/`, `scripts/`, the Vite config, app HTML, and the Node
sidecar. Its explicit file allowlist excludes build output and dependencies. `format:check`
is the non-writing check; `format` writes. CI runs these frontend checks and Rust fmt,
clippy, and tests on pull requests and pushes to `main`. VS Code uses Biome for supported
frontend files and rust-analyzer/rustfmt for Rust; install the recommended workspace
extensions. Tests need no models, network, sidecar install, or app launch. CI does not
exercise the native app or a full transcription run.

Pre-commit reconstructs the index in a temporary directory, including staged Rust modules
and rustfmt config, so checks use staged bytes even when the working tree differs. Gitleaks
scans complete changed staged blobs in an isolated directory. Hooks do not format or stage
files. Install Gitleaks separately; the hook fails closed if it is missing. Husky uses a
relative hook path that may be shared by linked worktrees. Typecheck,
frontend tests, clippy, and Rust tests remain opt-in with `SYLLEN_RUN_PREPUSH=1 git push`.

## Map and ownership

| Path | Owns |
|---|---|
| `src/app.tsx` | App composition, saved-transcript navigation, 31-entry media picker list, and top-level UI state |
| `src/features/transcription/` | Source form and job progress; job pipeline IPC/events; diarization client, worker, protocol, and WAV parsing |
| `src/features/library/` | Library drawer and IPC, saved transcript loading, date labels |
| `src/features/settings/` | Settings drawer and settings IPC/state |
| `src/features/transcript/` | Transcript rendering/workspace, session and correction state, word-correction popover/placement, export actions |
| `src/features/playback/` | Player bar and playback state |
| `src/icons.tsx` | Shared app icons |
| `src/lib/transcript.ts`, `captions.ts` | Shared transcript model/merge and caption cue/export helpers |
| `src/lib/wire-types.ts` | TypeScript mirror of the Rust wire types |
| `src/lib/format-bytes.ts` | Shared byte-size formatting |
| `src/lib/format-bytes.test.ts`, `src/lib/transcript.test.ts`, `src/lib/captions.test.ts`, `src/lib/tauri-security-config.test.ts` | Tests for shared helpers and Tauri security configuration |
| `src/features/transcription/wav.test.ts`, `src/features/library/date-label.test.ts`, `src/features/transcript/word-correction-position.test.ts`, `src/features/transcript/transcript-export.test.ts` | Tests colocated with feature helpers |
| `src-tauri/src/lib.rs` | App state, Tauri command registration, setup and exit cleanup |
| `src-tauri/tests/asset-protocol-scope.rs` | Asset protocol glob scope regression test |
| `src-tauri/src/tools.rs`, `events.rs`, `text-export.rs` | Tool resolution/status/update, job event emission, and text export command |
| `src-tauri/src/jobs.rs` and `src-tauri/src/jobs/*.rs` | Job start/cancel/cache lifecycle, pipeline orchestration, source stages, sidecar protocol, and audio persistence |
| `src-tauri/src/job-control.rs`, `process.rs` | Job control state and subprocess management |
| `src-tauri/src/media-file.rs`, `waveform.rs` | Media file validation and waveform generation |
| `src-tauri/src/library.rs` | SQLite schema and CRUD, library audio directory, row and audio deletion |
| `src-tauri/src/library-commands.rs` | Library Tauri commands |
| `src-tauri/src/media-server.rs` | Loopback HTTP audio server with Range support |
| `src-tauri/src/contracts.rs` | Serde structs shared by the Rust modules; the wire shapes |
| `src-tauri/sidecar/server.mjs` | One Node process per job; Voz transcription, NDJSON on stdout |

Keep React feature code under `src/features/<feature>/` and shared code under
`src/lib/`. Use kebab-case for authored source files and folders; keep React component
and type identifiers PascalCase and Rust module identifiers snake_case. Framework-
required filenames are exceptions. Rust files with hyphens use `#[path]` module
attributes. `app.tsx` composes feature views and hooks; those modules own feature IPC
and state. `lib.rs` remains app setup and command registration.

## Contracts to keep in sync

- Types are mirrored by hand. `src/lib/wire-types.ts` mirrors the `Serialize` structs in
  `src-tauri/src/contracts.rs`. Most wire types use camelCase through
  `#[serde(rename_all = "camelCase")]`; change both sides together. No bindings are
  generated. `JobStarted` returns `job_id`; the frontend does not use that value.
- Media extensions are hand-synced: `MEDIA_EXTENSIONS` in `src/app.tsx` (file picker)
  and in `src-tauri/src/media-file.rs` (backend check) must stay identical, 31 entries today.
- Tauri commands are the IPC surface: `check_tools`, `latest_yt_dlp_version`,
  `update_yt_dlp`, `file_info`, `start_job`, `cancel_job`, `export_text`,
  `list_library`, `load_transcript`, `delete_transcript`, `save_analysis`,
  `save_speaker_names`, `save_word_corrections`. Register a new one in
  `generate_handler!` in `lib.rs` and call it from the owning `src/features/` hook or view.
  `export_text` receives a suggested filename, format and contents; Rust owns the save dialog and file write.
- Events: `job:progress`, `job:error`, `job:result`. Their payloads are
  `ProgressEvent`, `ErrorEvent`, and `JobResult` in `contracts.rs`; `use-job-pipeline.ts`
  listens for them.
- Chrome geometry is measured, not styled: the popover reads `data-app-topbar` on the
  App header and `data-reading-dock` on the dock, so those attributes must survive any
  markup change.
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
- Playback: `media-server.rs` serves only the current WAV over `127.0.0.1` with Range
  support. Seeking depends on it because WebKitGTK cannot play from `asset://`.

## Tests

- `npm test` runs Vitest's default `*.test.*` discovery, including helper tests in
  `src/lib/` and `src/features/` plus `scripts/sidecar-notices.test.mjs`. Export tests
  assert the IPC payload carries no destination path; config tests pin CSP and asset scope.
- `cargo test` runs Rust tests colocated with their modules: library persistence and
  deletion, waveform peaks and short reads, media byte ranges, media-file validation,
  export filename validation, asset scope glob matches, yt-dlp arguments, and audio
  persistence. They use `temp_path()` under the system temp dir and clean up after themselves.
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
