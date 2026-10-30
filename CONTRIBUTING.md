# Contributing

Bug reports and small fixes are welcome. Open an issue before starting a new feature, a visual redesign, or anything that changes the library schema, the sidecar protocol, or the build. Large pull requests that arrive without a prior issue are likely to be asked to split or wait, and that wastes your time. This is one maintainer working in their own time, so there is no promised response time.

## Reporting a bug

Use the bug report form. Keep the report small and redacted:

- App version, OS, and architecture.
- The input type: a URL host or a file extension. Not the link itself if it is private.
- Whether speaker labeling was on.
- The shortest steps that show the problem, what you expected, and what happened.
- Error text or log lines with user names, file paths, and transcript text removed.

Do not attach private recordings or transcripts to a public issue, pull request, or discussion. If a bug only happens with one file, describe its properties (length, codec, number of speakers) or rebuild a synthetic clip with the same properties. Use [SECURITY.md](SECURITY.md) for anything that should stay private.

## Setup

```bash
npm install
npm run sidecar:install
npm run tauri dev
```

`sidecar:install` downloads the Voz SDK and `onnxruntime-node` into `src-tauri/sidecar`. Details and requirements are in [README.md](README.md#run-from-source).

## Checks before a pull request

```bash
npm run build                      # tsc typecheck, then vite build
npm test                           # Vitest
cd src-tauri && cargo test
cd src-tauri && cargo check --all-targets
```

`npm run build` is the typecheck. There is no lint or format script, and no formatter config to follow.

The app writes to the real app data folder, so do not run it on your normal desktop while testing. Run it under Xvfb with isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`; [AGENTS.md](AGENTS.md#running--testing-the-app) has the commands and the known Xvfb quirks. Say in the pull request what you checked by hand. Component wiring, Tauri commands, and a full job run have no automated tests.

## What to change

Keep a pull request to one topic. Unrelated renames, formatting, and dependency bumps make it harder to review and get split out.

[AGENTS.md](AGENTS.md) maps which file owns what, and lists the contracts that must change together:

- `src/lib/types.ts` mirrors the structs in `src-tauri/src/contracts.rs`.
- `MEDIA_EXTENSIONS` exists in both `src/App.tsx` and `src-tauri/src/lib.rs`.
- A new Tauri command needs registration in `generate_handler!` and a caller in `App.tsx`.
- The sidecar writes one JSON object per line with `type: "progress" | "result" | "error"`.

Put reusable logic in `src/lib/` as pure functions and add a test next to it. A schema change to the library needs a migration that keeps existing rows readable, plus a test.

## Licensing

The application code is MIT. By opening a pull request you agree that your changes are MIT too. There is no CLA and no signed-commit requirement.

Do not add code, models, or assets that the MIT license cannot cover. Voz and Who keep their own license and attribution terms, described in [README.md](README.md#licenses-and-attribution); the footer attribution must stay.

## Conduct

Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). It is short and it is enforced.
