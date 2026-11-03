use glob::{MatchOptions, Pattern};

#[test]
fn asset_scope_matches_only_library_and_per_job_wav_files() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let scopes = config["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .unwrap();
    let patterns = scopes
        .iter()
        .map(|scope| {
            let scope = scope.as_str().unwrap();
            Pattern::new(
                &scope
                    .replace("$APPDATA", "/APPDATA")
                    .replace("$APPCACHE", "/APPCACHE"),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let options = MatchOptions {
        require_literal_separator: true,
        require_literal_leading_dot: true,
        ..Default::default()
    };
    let is_allowed = |path: &str| {
        let path = std::path::Path::new(path);
        patterns
            .iter()
            .any(|pattern| pattern.matches_path_with(path, options))
    };

    assert!(is_allowed("/APPDATA/library/transcript.wav"));
    assert!(is_allowed("/APPCACHE/jobs/job-1/audio.wav"));
    assert!(!is_allowed("/APPDATA/library/library.db"));
    assert!(!is_allowed("/APPDATA/library/nested/transcript.wav"));
    assert!(!is_allowed("/APPCACHE/jobs/job-1/tool"));
    assert!(!is_allowed("/APPCACHE/jobs/job-1/nested/audio.wav"));
}
