fn main() {
    // screencapturekit crate requires linking to libswift_Concurrency.dylib
    // On macOS 15+, it's in the dyld shared cache at /usr/lib/swift/
    // The crate's build script adds @rpath references, but we need to ensure
    // the linker can resolve them. Adding /usr/lib/swift as rpath covers modern macOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    // Load repo-root .env (gitignored) so secrets stay out of source. Exposes
    // GOOGLE_FREE_TTS_KEY to the crate via option_env!. Missing .env is fine —
    // the Google Free provider degrades to "not configured".
    load_env_secret("GOOGLE_FREE_TTS_KEY");

    tauri_build::build()
}

/// Read `KEY=VALUE` for `key` from ../.env and re-export it as a compile-time env var.
fn load_env_secret(key: &str) {
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed={}", key);
    // An explicitly-set process env var wins over .env (useful for CI).
    if std::env::var(key).is_ok() {
        return;
    }
    if let Ok(content) = std::fs::read_to_string("../.env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key {
                    let val = v.trim().trim_matches('"').trim_matches('\'');
                    // Skip empty values so option_env! yields None (clean "not configured")
                    // rather than Some("") which would issue a request with a blank key.
                    if !val.is_empty() {
                        println!("cargo:rustc-env={}={}", key, val);
                    }
                    return;
                }
            }
        }
    }
}
