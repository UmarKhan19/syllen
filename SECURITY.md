# Security policy

## Supported versions

Only the latest released version of Syllen gets security fixes. Older versions are not patched. If you report a problem, check it against the latest release first, or against `main` if you build from source.

## Report a vulnerability privately

Use GitHub's private advisory form:

https://github.com/UmarKhan19/syllen/security/advisories/new

Do not open a public issue for a vulnerability. The advisory is visible to the repository maintainers and to GitHub, not to the public.

Include:

- App version, OS, and architecture.
- What an attacker could do, and what they need to start.
- The smallest steps to reproduce it.
- Error text or logs with private paths, recordings, and transcript text removed.

Do not attach a private recording or transcript. A synthetic file with the same properties is enough for most reports.

There is no guaranteed response time and no response SLA. This is a volunteer project with one maintainer, and reports are read in the order they arrive. If the report holds up, the fix ships in the next release and the advisory credits you unless you ask otherwise.

## Scope

In scope:

- The Rust, TypeScript, and sidecar code in this repository.
- The library database and audio files in app data, and the loopback audio server in `src-tauri/src/media.rs`.
- The bundled Tauri configuration and capabilities.
- How Syllen bundles, invokes, or configures Voz, Who, `onnxruntime`, `yt-dlp`, `ffmpeg`, or Tauri, including the version it pins.
- How the app downloads, verifies, or updates a dependency, and what it sends over the network or how it checks the responses.

Out of scope:

- A defect inside a dependency that also reproduces with that project's own build. Report it upstream with the version and steps. The Voz and Who SDKs and models are Desert Ant Labs' and follow their license and support terms, linked from [README.md](README.md#licenses-and-attribution).
- Transcription accuracy, wrong speaker labels, and model quality. Those are bugs, not vulnerabilities.
- An attacker who already has your user account, your files, or your machine.

## What the app does not have

Syllen has no server, no accounts, no API keys, no analytics, and no crash reporting. Audio and transcripts stay on the machine, so most reports will be about local files, the local audio server, or a downloaded dependency.
