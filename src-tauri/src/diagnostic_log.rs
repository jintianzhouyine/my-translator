//! Bounded, daily diagnostic logs. Date arithmetic and credential redaction
//! belong to the caller; this module only owns safe file names and disk limits.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 4096;
const LIMIT_MARKER: &[u8] =
    b"[WARN] [diagnostic] Daily log size limit reached; later entries for this day are omitted.\n";

#[derive(Default)]
struct LogState {
    last_cleanup: Option<(String, String)>,
    capped_dates: HashSet<String>,
}

pub struct DiagnosticLog {
    directory: PathBuf,
    max_file_bytes: u64,
    state: Mutex<LogState>,
}

impl DiagnosticLog {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            max_file_bytes: MAX_LOG_FILE_BYTES,
            state: Mutex::new(LogState::default()),
        }
    }

    /// Append one sanitized entry, keeping files on or after `earliest_date`.
    /// The caller supplies local calendar dates: today and today minus six days.
    pub fn write(
        &self,
        date: &str,
        earliest_date: &str,
        timestamp: &str,
        level: &str,
        component: &str,
        message: &str,
    ) -> io::Result<()> {
        require_date(date)?;
        require_date(earliest_date)?;
        if date < earliest_date {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "log date precedes retention boundary",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("diagnostic log lock poisoned"))?;
        fs::create_dir_all(&self.directory)?;
        if state
            .last_cleanup
            .as_ref()
            .map(|(day, cutoff)| (day.as_str(), cutoff.as_str()))
            != Some((date, earliest_date))
        {
            self.cleanup_inner(earliest_date)?;
            state
                .capped_dates
                .retain(|day| day.as_str() >= earliest_date);
            state.last_cleanup = Some((date.to_owned(), earliest_date.to_owned()));
        }
        if state.capped_dates.contains(date) {
            return Ok(());
        }

        let path = self.directory.join(format!("translator-{date}.log"));
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "diagnostic log path is not a regular file",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)?;
        let size = file.metadata()?.len();
        // The marker survives app restarts, so repeated errors cannot append
        // another warning after an already-capped file is reopened.
        let marked = if size >= LIMIT_MARKER.len() as u64 {
            let length = size.min((LIMIT_MARKER.len() + 1) as u64) as usize;
            file.seek(SeekFrom::End(-(length as i64)))?;
            let mut tail = vec![0; length];
            file.read_exact(&mut tail)?;
            // A message quoting this text is not our standalone marker line.
            tail.ends_with(LIMIT_MARKER) && (length == LIMIT_MARKER.len() || tail[0] == b'\n')
        } else {
            false
        };
        if size >= self.max_file_bytes || marked {
            state.capped_dates.insert(date.to_owned());
            return Ok(());
        }

        let level = match level.trim().to_ascii_uppercase().as_str() {
            "TRACE" => "TRACE",
            "DEBUG" => "DEBUG",
            "WARN" | "WARNING" => "WARN",
            "ERROR" => "ERROR",
            _ => "INFO",
        };
        let entry = format!(
            "[{}] [{level}] [{}] {}\n",
            single_line(timestamp, 64),
            single_line(component, 64),
            single_line(message, MAX_MESSAGE_BYTES),
        );
        let reserved_limit = self
            .max_file_bytes
            .saturating_sub(LIMIT_MARKER.len() as u64);
        if size.saturating_add(entry.len() as u64) > reserved_limit {
            if size.saturating_add(LIMIT_MARKER.len() as u64) <= self.max_file_bytes {
                file.write_all(LIMIT_MARKER)?;
            }
            state.capped_dates.insert(date.to_owned());
        } else {
            file.write_all(entry.as_bytes())?;
        }
        Ok(())
    }

    /// Remove only our regular daily log files older than the inclusive cutoff.
    /// Unrelated files, invalid dates, directories and symbolic links are ignored.
    pub fn cleanup(&self, earliest_date: &str) -> io::Result<usize> {
        require_date(earliest_date)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("diagnostic log lock poisoned"))?;
        let removed = self.cleanup_inner(earliest_date)?;
        state
            .capped_dates
            .retain(|day| day.as_str() >= earliest_date);
        Ok(removed)
    }

    fn cleanup_inner(&self, earliest_date: &str) -> io::Result<usize> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(date) = name
                .to_str()
                .and_then(|name| name.strip_prefix("translator-"))
                .and_then(|name| name.strip_suffix(".log"))
            else {
                continue;
            };
            if valid_date(date) && date < earliest_date {
                match fs::remove_file(entry.path()) {
                    Ok(()) => removed += 1,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(removed)
    }
}

fn require_date(date: &str) -> io::Result<()> {
    if valid_date(date) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid log date",
        ))
    }
}

fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: u32 = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    let last_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    year != 0 && day != 0 && day <= last_day
}

fn single_line(text: &str, limit: usize) -> String {
    let mut sanitized = String::with_capacity(text.len().min(limit));
    for character in text.chars() {
        let character = if character.is_control() || matches!(character, '\u{2028}' | '\u{2029}') {
            ' '
        } else {
            character
        };
        if sanitized.len() + character.len_utf8() > limit {
            while sanitized.len() > limit.saturating_sub('…'.len_utf8()) {
                sanitized.pop();
            }
            if limit >= '…'.len_utf8() {
                sanitized.push('…');
            }
            break;
        }
        sanitized.push(character);
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "translator-log-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn daily(&self, date: &str) -> PathBuf {
            self.0.join(format!("translator-{date}.log"))
        }
        fn log_with_limit(&self, limit: u64) -> DiagnosticLog {
            let mut log = DiagnosticLog::new(self.0.clone());
            log.max_file_bytes = limit;
            log
        }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn retention_keeps_seven_dates_across_year_boundary() {
        let dir = TempDirectory::new();
        for date in [
            "2025-12-29",
            "2025-12-30",
            "2025-12-31",
            "2026-01-01",
            "2026-01-02",
            "2026-01-03",
            "2026-01-04",
            "2026-01-05",
            "2026-01-06",
        ] {
            fs::write(dir.daily(date), "saved\n").unwrap();
        }
        let log = DiagnosticLog::new(dir.0.clone());
        assert_eq!(log.cleanup("2025-12-31").unwrap(), 2);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 7);
        assert!(dir.daily("2025-12-31").exists());
        assert!(dir.daily("2026-01-06").exists());
        assert_eq!(log.cleanup("2025-12-31").unwrap(), 0);
    }

    #[test]
    fn first_write_cleans_old_dates_across_leap_month_boundary() {
        let dir = TempDirectory::new();
        for date in [
            "2024-02-28",
            "2024-02-29",
            "2024-03-01",
            "2024-03-02",
            "2024-03-03",
            "2024-03-04",
            "2024-03-05",
        ] {
            fs::write(dir.daily(date), "saved\n").unwrap();
        }
        let log = DiagnosticLog::new(dir.0.clone());
        log.write("2024-03-06", "2024-02-29", "now", "INFO", "app", "started")
            .unwrap();
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 7);
        assert!(!dir.daily("2024-02-28").exists());
        assert!(dir.daily("2024-02-29").exists());
        log.write("2024-03-07", "2024-03-01", "now", "INFO", "app", "next day")
            .unwrap();
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 7);
        assert!(!dir.daily("2024-02-29").exists());
    }

    #[test]
    fn cleanup_ignores_unrelated_files_invalid_dates_and_directories() {
        let dir = TempDirectory::new();
        let names = [
            "notes.log",
            "translator-2020-01-01.log.bak",
            "translator-2023-02-29.log",
            "translator-2020-13-01.log",
            "translator-2020-01-00.log",
            "translator-0000-01-01.log",
            "translator-2020-1-1.log",
            "other-translator-2020-01-01.log",
        ];
        for name in names {
            fs::write(dir.0.join(name), "keep").unwrap();
        }
        fs::create_dir(dir.daily("2020-01-02")).unwrap();
        fs::write(dir.daily("2020-01-01"), "remove").unwrap();
        let log = DiagnosticLog::new(dir.0.clone());
        assert_eq!(log.cleanup("2026-11-11").unwrap(), 1);
        for name in names {
            assert!(dir.0.join(name).is_file());
        }
        assert!(dir.daily("2020-01-02").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_and_write_leave_symbolic_links_and_their_targets_untouched() {
        let dir = TempDirectory::new();
        let target = dir.0.join("private.txt");
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.daily("2020-01-01")).unwrap();
        std::os::unix::fs::symlink(&target, dir.daily("2026-11-17")).unwrap();
        let log = DiagnosticLog::new(dir.0.clone());
        assert_eq!(log.cleanup("2026-11-11").unwrap(), 0);
        assert!(log
            .write("2026-11-17", "2026-11-11", "now", "INFO", "app", "no")
            .is_err());
        assert!(fs::symlink_metadata(dir.daily("2020-01-01"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    }

    #[test]
    fn concurrent_appends_keep_complete_entries_and_preserve_existing_logs() {
        let dir = TempDirectory::new();
        let log = Arc::new(DiagnosticLog::new(dir.0.clone()));
        let threads: Vec<_> = (0..8)
            .map(|thread| {
                let log = log.clone();
                std::thread::spawn(move || {
                    for index in 0..50 {
                        log.write(
                            "2026-11-17",
                            "2026-11-11",
                            "now",
                            "INFO",
                            "worker",
                            &format!("{thread}:{index}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        DiagnosticLog::new(dir.0.clone())
            .write(
                "2026-11-17",
                "2026-11-11",
                "later",
                "INFO",
                "app",
                "reopened",
            )
            .unwrap();
        let text = fs::read_to_string(dir.daily("2026-11-17")).unwrap();
        let lines: HashSet<_> = text.lines().collect();
        assert_eq!(lines.len(), 401);
        for thread in 0..8 {
            for index in 0..50 {
                assert!(lines.contains(format!("[now] [INFO] [worker] {thread}:{index}").as_str()));
            }
        }
        assert!(text.ends_with("[later] [INFO] [app] reopened\n"));
    }

    #[test]
    fn entries_are_single_line_and_unicode_truncation_is_bounded() {
        let dir = TempDirectory::new();
        let log = DiagnosticLog::new(dir.0.clone());
        let message = format!("bad\n[ERROR]\r\0\u{2028}\u{2029}{}", "汉".repeat(3000));
        log.write(
            "2026-11-17",
            "2026-11-11",
            "now\nforged",
            "ERROR\nINFO",
            "capture\r\n",
            &message,
        )
        .unwrap();
        let text = fs::read_to_string(dir.daily("2026-11-17")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.starts_with("[now forged] [INFO] [capture  ] bad [ERROR]"));
        assert!(text.ends_with("…\n"));
        assert!(text.len() <= MAX_MESSAGE_BYTES + 160);
        assert!(!text.trim_end_matches('\n').chars().any(char::is_control));
    }

    #[test]
    fn daily_size_cap_writes_one_marker_even_after_reopening_and_resets_next_day() {
        let dir = TempDirectory::new();
        let log = dir.log_with_limit(512);
        for _ in 0..100 {
            log.write(
                "2026-11-17",
                "2026-11-11",
                "now",
                "ERROR",
                "network",
                &"x".repeat(100),
            )
            .unwrap();
        }
        let before = fs::read(dir.daily("2026-11-17")).unwrap();
        assert!(before.len() <= 512);
        assert!(before.ends_with(LIMIT_MARKER));
        assert_eq!(
            before
                .windows(LIMIT_MARKER.len())
                .filter(|part| *part == LIMIT_MARKER)
                .count(),
            1
        );
        let restarted = dir.log_with_limit(512);
        for _ in 0..10 {
            restarted
                .write(
                    "2026-11-17",
                    "2026-11-11",
                    "now",
                    "ERROR",
                    "network",
                    "again",
                )
                .unwrap();
        }
        assert_eq!(fs::read(dir.daily("2026-11-17")).unwrap(), before);
        restarted
            .write(
                "2026-11-18",
                "2026-11-12",
                "later",
                "INFO",
                "app",
                "next day",
            )
            .unwrap();
        assert!(fs::read_to_string(dir.daily("2026-11-18"))
            .unwrap()
            .contains("next day"));
    }

    #[test]
    fn a_message_quoting_the_limit_warning_does_not_disable_logging() {
        let dir = TempDirectory::new();
        let log = DiagnosticLog::new(dir.0.clone());
        log.write(
            "2026-11-17",
            "2026-11-11",
            "now",
            "INFO",
            "app",
            std::str::from_utf8(LIMIT_MARKER).unwrap().trim_end(),
        )
        .unwrap();
        log.write(
            "2026-11-17",
            "2026-11-11",
            "later",
            "INFO",
            "app",
            "still logging",
        )
        .unwrap();
        assert!(fs::read_to_string(dir.daily("2026-11-17"))
            .unwrap()
            .ends_with("still logging\n"));
    }

    #[test]
    fn invalid_dates_cannot_escape_the_log_directory_or_delete_files() {
        let dir = TempDirectory::new();
        fs::write(dir.daily("2026-11-10"), "keep").unwrap();
        let log = DiagnosticLog::new(dir.0.clone());
        for date in [
            "../../file",
            "2026-02-29",
            "2026-11-00",
            "99999-01-01",
            "汉汉汉a",
        ] {
            assert!(log
                .write(date, "2026-11-11", "now", "INFO", "app", "no")
                .is_err());
            assert!(log.cleanup(date).is_err());
        }
        assert_eq!(fs::read_to_string(dir.daily("2026-11-10")).unwrap(), "keep");
    }
}
