# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface is a React web UI rendered inside a Tauri 2 webview (WebKitGTK on
Linux, WKWebView on macOS, WebView2 on Windows). The design language is a web
one; the shell is a desktop app window.

## Users

*Inferred from the README and the shipped UI; the repository states the
mechanism but not the audience.*

People who watch long spoken-word video and need the words: journalists
pulling quotes from an interview, students working through a lecture, podcast
producers captioning an episode, researchers indexing a talk. They are at a
desk, often with headphones on, and they want the text of something they
cannot easily read or caption by hand.

## Product Purpose

Paste a YouTube link or choose a local video/audio file, get a transcript with
speaker labels and word-level timestamps, produced entirely on the user's own
machine. Success is a clean, readable, exportable transcript that never
required a cloud transcription service.

## Positioning

Local-first transcription with speaker labels. The differentiator is not
quality of the text but the privacy and the labeling: the audio is downloaded
or read in place, transcribed on the machine, and kept in a local library that
never leaves it, and the output knows who said what.

## Operating Context

- Single-source jobs: one finished YouTube video or one local video/audio file
  at a time. No playlists, no live streams, no multi-file queues.
- The wait is real. A first run downloads a 350 MB speech model (Voz) and a
  32 MB speaker model (Who); later runs are cached. Transcription of a long
  video takes minutes, so the pipeline state is part of the product, not
  decoration.
- The window stays interactive during a job: diarization runs in a web worker,
  so the user can cancel, read, or leave the app open.
- Links need `yt-dlp`; all jobs need `ffmpeg`. Both can live on the machine or
  be installed into the app's own data folder from Settings. Local file jobs do
  not need `yt-dlp`.
- Transcripts are read for long stretches, then copied or exported as SRT,
  VTT, or plain text.
- Finished transcripts and their audio are kept in a local library, so a user
  can come back to yesterday's interview without transcribing it again. The
  library is reachable from the top bar and the newest three sit on the idle
  screen.
- Users often read along while listening. The player stays at the top of the
  window and the transcript marks the passage and word being spoken.
- English only for now.

## Capabilities and Constraints

- Two inputs, one composer: paste a YouTube link or choose a local video/audio
  file. Files are read in place and never uploaded.
- Local speech-to-text with word-level timestamps (80 ms resolution).
- Speaker labeling for up to four speakers; can be switched off in Settings,
  in which case exports omit speaker prefixes.
- Exports: SRT, VTT, TXT, plus copy-to-clipboard.
- Local library: every finished transcript and its audio are saved in SQLite
  under the app data folder, with the speaker labels and names. Open one from
  the Library drawer or the idle screen; delete one and its audio is deleted
  too. Storage is shown per recording and in total.
- Waveform playback: play/pause, seek by waveform or word, a sticky player, and a transcript that follows the current passage and word. The audio is served to the webview over a loopback-only HTTP port with byte ranges because WebKitGTK cannot play Tauri's asset protocol media.
- Settings drawer: speaker-labeling switch, yt-dlp version check and update.
- The pipeline is visible as four stages: Download (links only), Prepare,
  Transcribe, Speakers. File jobs begin at Prepare.
- Missing tools are detected at startup and reported in-app.
- Model weights are source-available, not MIT. The footer attribution
  ("Powered by Desert Ant Labs") satisfies the attribution requirement and
  must stay.

## Brand Commitments

- Name: **YT Transcript** (productName and window title in
  `src-tauri/tauri.conf.json`).
- Voice: plain, factual, tool-like. The existing copy names the action
  ("Transcribe", "Update yt-dlp") and states facts (model sizes, deletion,
  licensing). No marketing claims, no urgency, no exclamation.
- The privacy promise is factual and load-bearing: "Audio never leaves this
  machine", "Nothing is uploaded", "Models run on this machine". The library is
  local: its database and audio live in the app data folder and are deleted
  only when the user deletes them.
- Footer attribution to Desert Ant Labs for Voz and Who is required.

## Evidence on Hand

- `README.md` — product truth, pipeline, requirements, licensing, privacy.
- `src/lib/merge.ts` — the transcript model: `Word`, `Turn`, `Segment`,
  `Cue`, plus the caption formatters.
- `src/App.tsx` — the single screen: composer, pipeline, result, settings
  drawer, export actions.
- `src-tauri/src/lib.rs` — the Rust pipeline, the SQLite library, and the job
  event contract.
- No screenshots, testimonials, benchmarks, or press. The app is young and
  private; future work must not invent them.

## Product Principles

1. **The text is the product.** Every pixel that is not the transcript is
   chrome, and chrome gets out of the way.
2. **Say what is happening.** A multi-minute local job needs honest progress:
   which stage, how far, and what is still downloading.
3. **Nothing leaves the machine.** State it plainly once, then let the
   interface prove it by staying quiet and local.
4. **One screen, no detours.** Paste, wait, read, export. Settings live in a
   drawer, not in a separate route.
5. **Never fabricate.** Real titles, real durations, real word counts. No
   invented samples dressed as results.

## Accessibility & Inclusion

- `prefers-reduced-motion` is honored for every animation.
- Focus is visible on every control; the settings drawer traps focus on open
  and restores it on close, and closes on Escape.
- Body text must meet 4.5:1 against its ground; placeholder and meta text
  are held to the same bar.
