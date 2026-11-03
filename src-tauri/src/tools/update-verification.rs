use openpgp::{
    Cert, KeyHandle,
    parse::{
        Parse,
        stream::{DetachedVerifierBuilder, MessageLayer, MessageStructure, VerificationHelper},
    },
    policy::StandardPolicy,
};
use sequoia_openpgp as openpgp;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const TRUSTED_FINGERPRINT: &str = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";
const MANIFEST_LIMIT: usize = 64 * 1024;
const SIGNATURE_LIMIT: usize = 16 * 1024;
const ASSET_LIMIT: usize = 64 * 1024 * 1024;
const MIN_ASSET_SIZE: usize = 1_000_000;

// yt-dlp documents this key for verifying SHA2-256SUMS.sig:
// https://github.com/yt-dlp/yt-dlp#release-files
// https://github.com/yt-dlp/yt-dlp/blob/master/public.key
const PUBLIC_KEY: &[u8] = include_bytes!("update-fixtures/yt-dlp-public.key");

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct UpdateGuard;

impl UpdateGuard {
    fn acquire() -> Result<Self, String> {
        UPDATE_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| "A yt-dlp update is already in progress.".to_string())
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::Release);
    }
}

fn valid_release_tag(tag: &str) -> bool {
    let parts: Vec<_> = tag.split('.').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
}

fn verify_manifest(manifest: &[u8], signature: &[u8], public_key: &[u8]) -> Result<(), String> {
    verify_manifest_with_fingerprint(manifest, signature, public_key, TRUSTED_FINGERPRINT)
}

fn verify_manifest_with_fingerprint(
    manifest: &[u8],
    signature: &[u8],
    public_key: &[u8],
    fingerprint: &str,
) -> Result<(), String> {
    let key = Cert::from_bytes(public_key)
        .map_err(|_| "Could not parse the pinned yt-dlp signing key.".to_string())?;
    if key.fingerprint().to_hex().to_uppercase() != fingerprint {
        return Err("The yt-dlp signing key fingerprint does not match the pinned key.".into());
    }
    let helper = PinnedKeyHelper {
        key,
        fingerprint: fingerprint.to_string(),
    };
    let policy = StandardPolicy::new();
    let mut verifier = DetachedVerifierBuilder::from_bytes(signature)
        .map_err(|_| "GitHub returned a missing or malformed release signature.".to_string())?
        .with_policy(&policy, None, helper)
        .map_err(|_| "Could not initialize yt-dlp release signature verification.".to_string())?;
    verifier
        .verify_bytes(manifest)
        .map_err(|_| "The yt-dlp release checksum signature is invalid.".to_string())
}

struct PinnedKeyHelper {
    key: Cert,
    fingerprint: String,
}

impl VerificationHelper for PinnedKeyHelper {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        Ok(vec![self.key.clone()])
    }

    fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
        let mut valid = 0;
        for layer in structure.iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                for result in results {
                    let checksum = result
                        .as_ref()
                        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                    if checksum.ka.cert().fingerprint().to_hex().to_uppercase() == self.fingerprint
                    {
                        valid += 1;
                    }
                }
            }
        }
        if valid == 1 {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "expected exactly one signature from the pinned certificate"
            ))
        }
    }
}

fn manifest_hash(manifest: &[u8], asset: &str) -> Result<[u8; 32], String> {
    let text = std::str::from_utf8(manifest)
        .map_err(|_| "The signed yt-dlp checksum manifest is not UTF-8.".to_string())?;
    let mut found = None;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(hash) = fields.next() else { continue };
        let Some(name) = fields.next() else {
            return Err("The signed yt-dlp checksum manifest has a malformed line.".into());
        };
        if fields.next().is_some()
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("The signed yt-dlp checksum manifest has a malformed line.".into());
        }
        if name.trim_start_matches('*') == asset {
            if found.is_some() {
                return Err(
                    "The signed yt-dlp checksum manifest repeats the selected asset.".into(),
                );
            }
            let mut digest = [0; 32];
            let (pairs, _) = hash.as_bytes().as_chunks::<2>();
            for (i, pair) in pairs.iter().enumerate() {
                digest[i] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
            }
            found = Some(digest);
        }
    }
    found.ok_or_else(|| format!("The signed yt-dlp checksum manifest does not contain {asset}."))
}

fn hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err("The signed yt-dlp checksum manifest has a malformed hash.".into()),
    }
}

fn verify_asset(manifest: &[u8], asset: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < MIN_ASSET_SIZE || bytes.len() > ASSET_LIMIT {
        return Err(format!(
            "The yt-dlp download size is invalid ({} bytes).",
            bytes.len()
        ));
    }
    let expected = manifest_hash(manifest, asset)?;
    verify_digest(expected, bytes)
}

fn verify_digest(expected: [u8; 32], bytes: &[u8]) -> Result<(), String> {
    let actual = Sha256::digest(bytes);
    if actual[..] != expected[..] {
        return Err("The yt-dlp download does not match its signed SHA-256 checksum.".into());
    }
    Ok(())
}

fn verify_before_install<T>(
    manifest: &[u8],
    signature: &[u8],
    public_key: &[u8],
    asset: &str,
    bytes: &[u8],
    install: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    verify_manifest(manifest, signature, public_key)?;
    verify_asset(manifest, asset, bytes)?;
    install()
}

async fn fetch(
    client: &reqwest::Client,
    url: String,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub returned an error: {e}"))?;
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err("GitHub response exceeds the permitted download size.".into());
    }
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Could not read the GitHub download: {e}"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("GitHub response exceeds the permitted download size.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn https_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

pub(super) async fn release_tag() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .user_agent("yt-transcript/0.1")
        .build()
        .map_err(|e| format!("Could not start the update check: {e}"))?;
    let response = client
        .get("https://github.com/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !response.status().is_redirection() {
        return Err(format!(
            "GitHub did not redirect to a release (HTTP {}).",
            response.status()
        ));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "GitHub returned no release location.".to_string())?;
    let url = reqwest::Url::parse(location)
        .or_else(|_| reqwest::Url::parse(&format!("https://github.com{location}")))
        .map_err(|_| "GitHub returned an invalid release location.".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err("GitHub returned an unexpected release location.".into());
    }
    let tag = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    if !url.path().starts_with("/yt-dlp/yt-dlp/releases/tag/") || !valid_release_tag(tag) {
        return Err("GitHub returned an unexpected release tag.".into());
    }
    Ok(tag.to_string())
}

fn reserve_temp(dir: &Path, suffix: &str) -> Result<(PathBuf, fs::File), String> {
    for _ in 0..100 {
        let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".yt-dlp-{}-{seq}.{suffix}", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(format!(
                    "Could not create a private updater temporary file: {e}"
                ));
            }
        }
    }
    Err("Could not reserve an updater temporary file.".into())
}

pub(super) async fn update(app: &AppHandle, asset: &str) -> Result<String, String> {
    let _guard = UpdateGuard::acquire()?;
    let client = reqwest::Client::builder()
        .redirect(https_redirects())
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent("yt-transcript/0.1")
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;
    let tag = release_tag().await?;
    let base = format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}");
    let manifest = fetch(
        &client,
        format!("{base}/SHA2-256SUMS"),
        MANIFEST_LIMIT,
        Duration::from_secs(30),
    )
    .await?;
    let signature = fetch(
        &client,
        format!("{base}/SHA2-256SUMS.sig"),
        SIGNATURE_LIMIT,
        Duration::from_secs(30),
    )
    .await?;
    let bytes = fetch(
        &client,
        format!("{base}/{asset}"),
        ASSET_LIMIT,
        Duration::from_secs(5 * 60),
    )
    .await?;
    verify_before_install(&manifest, &signature, PUBLIC_KEY, asset, &bytes, || {
        install_verified(app, &bytes)
    })?;
    Ok(tag)
}

fn install_verified(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?
        .join("bin");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let exe_suffix = if cfg!(windows) { "exe" } else { "bin" };
    let (temp, mut file) = reserve_temp(&dir, exe_suffix)?;
    let _cleanup = TempCleanup(temp.clone());
    file.write_all(bytes)
        .map_err(|e| format!("Could not write the verified download: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Could not flush the verified download: {e}"))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not make the verified download executable: {e}"))?;
    }
    let target = dir.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    });
    #[cfg(windows)]
    let backup = dir.join(format!(".yt-dlp-old-{}", std::process::id()));
    #[cfg(windows)]
    if target.exists() {
        fs::rename(&target, &backup)
            .map_err(|e| format!("Could not preserve the existing yt-dlp: {e}"))?;
    }
    if let Err(error) = fs::rename(&temp, &target) {
        #[cfg(windows)]
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!(
            "Could not install the verified yt-dlp binary: {error}"
        ));
    }
    #[cfg(windows)]
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|e| format!("Updated yt-dlp but could not remove its backup: {e}"))?;
    }
    Ok(())
}

struct TempCleanup(PathBuf);

impl Drop for TempCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &[u8] = include_bytes!("update-fixtures/SHA2-256SUMS");
    const SIGNATURE: &[u8] = include_bytes!("update-fixtures/SHA2-256SUMS.sig");

    #[test]
    fn signed_manifest_authenticates_expected_yt_dlp_hash() {
        verify_manifest(MANIFEST, SIGNATURE, PUBLIC_KEY).unwrap();
        assert_eq!(
            manifest_hash(MANIFEST, "yt-dlp").unwrap(),
            hex_bytes("e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3")
        );
    }

    #[test]
    fn tampered_manifest_and_wrong_key_are_rejected() {
        let mut tampered = MANIFEST.to_vec();
        tampered[0] ^= 1;
        assert!(verify_manifest(&tampered, SIGNATURE, PUBLIC_KEY).is_err());
        let mut tampered_signature = SIGNATURE.to_vec();
        tampered_signature[0] ^= 1;
        assert!(verify_manifest(MANIFEST, &tampered_signature, PUBLIC_KEY).is_err());
        assert!(verify_manifest_with_fingerprint(MANIFEST, SIGNATURE, PUBLIC_KEY, "00").is_err());
        assert!(verify_manifest(MANIFEST, b"", PUBLIC_KEY).is_err());
    }

    #[test]
    fn missing_asset_and_changed_asset_are_rejected() {
        assert!(manifest_hash(MANIFEST, "not-a-release-asset").is_err());
        let duplicate = [
            MANIFEST,
            b"e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  yt-dlp\n",
        ]
        .concat();
        assert!(manifest_hash(&duplicate, "yt-dlp").is_err());
        let abc_hash =
            hex_bytes("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(verify_digest(abc_hash, b"abd").is_err());
        verify_digest(abc_hash, b"abc").unwrap();
    }

    #[test]
    fn invalid_signature_or_digest_never_reaches_install() {
        let mut called = false;
        let result = verify_before_install(
            MANIFEST,
            b"bad signature",
            PUBLIC_KEY,
            "yt-dlp",
            b"asset",
            || {
                called = true;
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err(),
            "Could not initialize yt-dlp release signature verification."
        );
        assert!(!called);

        let bytes = vec![b'x'; MIN_ASSET_SIZE];
        let result =
            verify_before_install(MANIFEST, SIGNATURE, PUBLIC_KEY, "yt-dlp", &bytes, || {
                called = true;
                Ok(())
            });
        assert_eq!(
            result.unwrap_err(),
            "The yt-dlp download does not match its signed SHA-256 checksum."
        );
        assert!(!called);
    }

    #[test]
    fn release_tags_are_strict_and_filename_is_not_a_path() {
        assert!(valid_release_tag("2026.10.26"));
        assert!(!valid_release_tag("latest"));
        assert!(!valid_release_tag("2026.10.26/../../x"));
    }

    fn hex_bytes(text: &str) -> [u8; 32] {
        let mut bytes = [0; 32];
        let (pairs, _) = text.as_bytes().as_chunks::<2>();
        for (i, pair) in pairs.iter().enumerate() {
            bytes[i] = (hex_nibble(pair[0]).unwrap() << 4) | hex_nibble(pair[1]).unwrap();
        }
        bytes
    }
}
