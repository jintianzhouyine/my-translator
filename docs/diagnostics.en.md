# Diagnostic logs

[中文](diagnostics.md) · [English](diagnostics.en.md) · [Documentation](README.en.md)

Open **设置 → 关于 → 诊断日志 → 打开日志目录** (Settings → About → Diagnostic logs → Open log folder). The app opens Explorer on Windows or Finder on macOS and displays the actual directory for copying.

Logs live in the application's data directory:

- Windows: `%APPDATA%\com.personal.translator\logs`
- macOS: `~/Library/Application Support/com.personal.translator/logs`

Files use the computer's local date, such as `translator-2026-11-17.log`; timestamps include the local time zone. The app retains **today and the previous six dates**. Cleanup runs at startup, on the first write of a new day, when opening the folder, and hourly while the app is running. After the app has been closed, the next launch catches up.

Each daily file is capped at 5 MiB. A single limit notice is appended when the cap is reached; logging resumes in the next day's file. Cleanup only deletes this app's ordinary `translator-YYYY-MM-DD.log` files, leaving unrelated files, directories and symbolic links alone.

Events include application version, operating system, translation start/pause, engine, connection state, retry attempt and predefined error category. `live_paused reason=requested` identifies an intentional pause or activity switch; `reason=auto_failure` identifies an automatic failure stop. `retry_scheduled` records a reconnect attempt. Common categories include `timeout`, `network`, `capture`, `output` and `backpressure`.

Logs do not contain API keys, full settings, transcripts, recordings, audio, file paths or raw provider error messages. Errors are reduced to predefined categories; an unfamiliar error may appear as `unknown`. A logging failure does not interrupt translation.

When reporting an interruption, note its approximate time and share the relevant daily `.log` file. Include the previous day if the issue crossed midnight. Settings files and recordings are not needed.
