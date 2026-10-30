## What and why

<!-- What changes, and what problem it solves. Link the issue it came from. -->

Closes #

## Testing

<!-- Commands you ran, and what you checked by hand. Component wiring and a full job run have no automated tests. -->

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `cd src-tauri && cargo test`
- [ ] `cd src-tauri && cargo check --all-targets`
- [ ] Ran the app under Xvfb with isolated XDG dirs if the change touches the UI or backend ([AGENTS.md](https://github.com/UmarKhan19/syllen/blob/main/AGENTS.md#running--testing-the-app))

## Data preservation

<!-- Does this touch the SQLite schema, the library audio, the job cache, or any delete path? Say how existing rows stay readable. -->

- [ ] Stored library data is unchanged, or the change includes a migration and a test for existing rows
- [ ] Nothing deletes user audio, transcripts, or speaker names unless the user asked for it
