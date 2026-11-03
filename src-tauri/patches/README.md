# GTK dependency backports

These path patches keep the GTK 0.18 API and package versions unchanged while
backporting the fixes needed by this app. `cargo audit` does not inspect path
patch source, so the vendored source diffs, upstream references, and tests below
are the evidence for these fixes. No advisory is ignored or allowed.

## Source and changes

| Path | Crates.io source | SHA-256 of original crate archive | Change |
| --- | --- | --- | --- |
| `vendor/glib` | [`glib 0.18.5`](https://crates.io/crates/glib/0.18.5) | `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5` | Backport gtk-rs-core [PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit [`b5a4071e439b`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439b) in `VariantStrIter::impl_get`: pass `&mut p` to the C out-parameter. |
| `vendor/glib-macros` | [`glib-macros 0.18.5`](https://crates.io/crates/glib-macros/0.18.5) | `0bb0228f477c0900c880fd78c8759b95c7636dbd7842707f49e132378aa2acdc` | Replace `proc-macro-error` aborts with `syn::Error` compile-error tokens; remove the error-wrapper attributes. |
| `vendor/gtk3-macros` | [`gtk3-macros 0.18.2`](https://crates.io/crates/gtk3-macros/0.18.2) | `52ff3c5b21f14f0736fed6dcfc0bfb4225ebf5725f3c0209edeec181e4d73e9d` | Replace `proc-macro-error` aborts with `syn::Error` compile-error tokens; remove the error-wrapper attribute. |

The vendored crates retain their normalized manifests, source, tests, licenses,
and copyright notices. Their `Cargo.toml.orig` files are omitted so they cannot
contradict the manifests Cargo actually builds. Package versions are not changed.
Only trailing blank lines in the three vendored license files and trailing
whitespace in a `glib-macros` documentation example were normalized; license
wording and Rust code are unchanged.
The original macro crates depended on `proc-macro-error`. A `proc-macro-error2`
port was tried, then removed after RustSec added `RUSTSEC-2026-0173` for that
unmaintained crate. The final port uses `syn::Error`, which both crates already
depend on. Call-site errors become `compile_error!` tokens; parser errors retain
their input spans, and the duplicate `@watch` case combines errors so the
primary error and "Previous `@watch` found here" note both remain. This keeps
the messages and useful source locations without either error-handling crate.

The upstream GTK crate archive excludes the `.ui` fixture referenced by its
compile doctest, so that fixture is restored from
[gtk3-rs](https://github.com/gtk-rs/gtk3-rs/blob/master/gtk3-macros/src/composite_template.ui).

## Verification

Run these from `src-tauri`:

```sh
CARGO_TARGET_DIR=target cargo check --locked
CARGO_TARGET_DIR=target cargo test --manifest-path vendor/glib/Cargo.toml \
  --config 'patch.crates-io.glib.path="vendor/glib"' \
  --config 'patch.crates-io.glib-macros.path="vendor/glib-macros"' \
  variant_iter::tests::test_variant_str_iter
CARGO_TARGET_DIR=target cargo test --manifest-path vendor/glib-macros/Cargo.toml
CARGO_TARGET_DIR=target cargo test --manifest-path vendor/gtk3-macros/Cargo.toml
```

The GLib iterator filter ran 5 tests, all passed. `glib-macros` passed 3 unit
tests, 18 integration tests, and 28 doctests (19 ignored). `gtk3-macros` passed
both doctests, including the invalid-template compile-fail case. The app's
`cargo test --locked` passed 18 unit tests and the asset-scope integration test.

The final `cargo audit --deny warnings` passed on the 518-package lockfile.
`Cargo.lock` contains none of `proc-macro-error`, `proc-macro-error2`, `rsa`,
`cx448`, `crypto-bigint`, or `pgp`. Path-patched packages are not audited by
Cargo Audit, so their source changes still require the regression tests above.
