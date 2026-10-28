//! Export file-translation results only to a path selected in the native save dialog.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;

fn validate_export(format: &str, content: &str) -> Result<(), String> {
    if !matches!(format, "srt" | "vtt" | "txt") {
        return Err("仅支持 SRT、VTT 和 TXT 导出格式".into());
    }
    if content.trim().is_empty() {
        return Err("没有可以导出的字幕或翻译文本".into());
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err("导出文本不能超过 10 MiB，请分段导出".into());
    }
    Ok(())
}

fn default_filename(file_name: &str, format: &str) -> String {
    let basename = file_name.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = basename.rsplit_once('.').map_or(basename, |(stem, _)| stem);
    let mut clean = String::new();
    for character in stem.chars() {
        if clean.len() + character.len_utf8() > 160 {
            break;
        }
        if character.is_control() || "<>:\"/\\|?*".contains(character) {
            clean.push('_');
        } else {
            clean.push(character);
        }
    }
    clean = clean.trim_matches([' ', '.']).to_string();
    if clean.is_empty() {
        clean = "音频翻译".into();
    }
    // Windows device names remain reserved even when followed by an extension.
    let first = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((first.starts_with("COM") || first.starts_with("LPT"))
            && first.len() == 4
            && matches!(first.as_bytes()[3], b'1'..=b'9'))
    {
        clean.insert(0, '_');
    }
    format!("{clean}.{format}")
}

fn export_path(mut path: PathBuf, format: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("保存位置无效，请重新选择完整的文件路径".into());
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case(format) => {}
        Some(_) => return Err(format!("请将导出文件保存为 .{format} 扩展名")),
        None => {
            path.set_extension(format);
            // The dialog did not confirm overwriting this suffixed path.
            if path.exists() {
                return Err(format!(
                    "添加 .{format} 扩展名后的文件已存在，请在保存对话框中选择该文件并确认替换"
                ));
            }
        }
    }
    Ok(path)
}

fn write_then_replace(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid export path"))?;
    let temporary = parent.join(format!(
        ".my-translator-export-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        // Same-directory rename commits the complete file. Never remove an old
        // destination to retry a failed replacement (including on Windows).
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn export_audio_file_text(
    app: AppHandle,
    file_name: String,
    format: String,
    content: String,
) -> Result<Option<String>, String> {
    validate_export(&format, &content)?;
    let filename = default_filename(&file_name, &format);
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("导出音频翻译")
            .set_file_name(filename)
            .add_filter(format.to_uppercase(), &[format.as_str()])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = export_path(
            selected
                .into_path()
                .map_err(|error| format!("无法读取保存位置：{error}"))?,
            &format,
        )?;
        write_then_replace(&path, |file| file.write_all(content.as_bytes()))
            .map_err(|error| format!("导出失败，原文件未被提前删除：{error}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("translator-export-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn default_name_is_a_safe_basename_with_the_chosen_extension() {
        assert_eq!(
            default_filename("../../会议录音.mp3", "srt"),
            "会议录音.srt"
        );
        assert_eq!(
            default_filename("C:\\录音\\会议.v2.wav", "vtt"),
            "会议.v2.vtt"
        );
        assert_eq!(default_filename("CON.mp3", "txt"), "_CON.txt");
        assert_eq!(
            default_filename("bad: name?\n.wav", "txt"),
            "bad_ name__.txt"
        );
        assert_eq!(default_filename("..", "srt"), "音频翻译.srt");
        assert!(default_filename(&"长".repeat(200), "srt").len() < 170);
    }

    #[test]
    fn format_and_utf8_byte_limits_are_enforced_before_opening_a_dialog() {
        assert!(validate_export("srt", "1\n00:00:00,000 --> 00:00:01,000\n字幕").is_ok());
        assert!(validate_export("exe", "text").is_err());
        assert!(validate_export("txt", " \n").is_err());
        assert!(validate_export("txt", &"字".repeat(MAX_CONTENT_BYTES / 3 + 1)).is_err());
    }

    #[test]
    fn write_failure_preserves_existing_file_and_cleans_partial_temp_file() {
        let directory = TempDirectory::new();
        let path = directory.0.join("result.srt");
        fs::write(&path, "original").unwrap();
        let result = write_then_replace(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::Other, "simulated disk full"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        write_then_replace(&path, |file| file.write_all("完整字幕".as_bytes())).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "完整字幕");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn suffix_never_silently_overwrites_a_path_the_dialog_did_not_confirm() {
        let directory = TempDirectory::new();
        let base = directory.0.join("result");
        assert_eq!(
            export_path(base.clone(), "srt").unwrap(),
            base.with_extension("srt")
        );
        fs::write(base.with_extension("srt"), "keep").unwrap();
        assert!(export_path(base, "srt").is_err());
        assert!(export_path(directory.0.join("result.txt"), "srt").is_err());
        assert!(export_path(PathBuf::from("relative.srt"), "srt").is_err());
        assert!(export_path(directory.0.join("result.SRT"), "srt").is_ok());
    }
}
