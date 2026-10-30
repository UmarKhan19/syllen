# Third-party notices

Syllen's application code is licensed under MIT. Bundled runtimes and models have
separate terms; this notice does not relicense them.

`npm run tauri:build` puts generated notices in `src-tauri/sidecar/notices/`,
which Tauri bundles with the sidecar. That directory contains exact copies of
this file and `LICENSE`, Node.js and ONNX Runtime notices for the prepared
runtime versions, installed production npm package license/notice files, Rust
crate license/notice files for the build target, and the three font OFLs.
Missing SPDX license texts come from the SPDX License List v3.27.0. The manifest
records package names, versions, source links, and SHA-256 hashes for copied
files. `rust/CARGO-DEPENDENCIES.json` lists the locked Rust dependency closure;
`rust/MPL-2.0-SOURCE-LINKS.txt` links the exact MPL-licensed crate archives.

Vite also emits `dist/licenses/frontend-dependencies.json` with names, versions,
SPDX identifiers, and any license text present in the bundled package. If a
package omits its license text, the matching full SPDX text is in
`src-tauri/sidecar/notices/spdx/`. Tauri bundles `dist` as its frontend, so the
Vite file ships with the app.

The bundled Voz and Who SDKs are separately licensed under the Desert Ant Labs
Source-Available License, not Syllen's MIT license. Their package license files
are copied into `src-tauri/sidecar/notices/npm/`. Credit Desert Ant Labs for Voz
and Who: https://desertant.com. The SDK terms and model terms are separate;
consult the bundled SDK license text and model terms at
https://license.desertant.com/1.0.
