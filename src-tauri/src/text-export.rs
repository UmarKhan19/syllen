use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn valid_export_name(name: &str, extension: &str) -> bool {
    matches!(extension, "srt" | "vtt" | "txt")
        && name.ends_with(&format!(".{extension}"))
        && name.len() > extension.len() + 1
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.chars().any(|character| {
            character.is_control() || ['<', '>', ':', '"', '|', '?', '*'].contains(&character)
        })
}

#[tauri::command]
pub(super) async fn export_text(
    app: tauri::AppHandle,
    name: String,
    extension: String,
    contents: String,
) -> Result<Option<String>, String> {
    if !valid_export_name(&name, &extension) {
        return Err("Invalid export filename".into());
    }
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let file = dialog
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .blocking_save_file();
    let Some(file) = file else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| format!("Could not resolve export path: {error}"))?;
    std::fs::write(&path, contents)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_name_validation_rejects_paths_and_unknown_extensions() {
        for (name, extension) in [
            ("../secret.txt", "txt"),
            ("folder/a.srt", "srt"),
            ("report.txt:evil.srt", "srt"),
            ("report?.srt", "srt"),
            (".srt", "srt"),
            ("x.exe", "exe"),
        ] {
            assert!(!super::valid_export_name(name, extension));
        }
        for extension in ["srt", "vtt", "txt"] {
            assert!(super::valid_export_name(
                &format!("my-transcript.{extension}"),
                extension
            ));
        }
        assert!(!super::valid_export_name("my-transcript.txt", "srt"));
    }
}
