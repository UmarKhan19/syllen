Updater verification fixtures
=============================

The key is yt-dlp's documented release-signing key, pinned in code by the full
fingerprint `AC0CBBE6848D6A873464AF4E57CF65933B5A7581`. yt-dlp documents the
SHA-256 manifest and detached signature format and links to this key at
https://github.com/yt-dlp/yt-dlp#release-files and
https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/public.key.

`SHA2-256SUMS` and `.sig` are the official assets for release `2026.10.26`:
https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS
https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS.sig

The tests keep only the signed manifest and detached signature. They assert the
known `yt-dlp` hash from the manifest and test SHA-256 matching with the small
`abc` vector, so no release executable is checked in. Production resolves one
release tag and fetches the manifest, signature, and selected binary from it.
