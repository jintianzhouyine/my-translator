use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::TARGET_SAMPLE_RATE;

/// System audio capture using WASAPI loopback on Windows.
/// Captures all system audio output and converts to PCM s16le 16kHz mono.
///
/// Note: uses the "legacy" WASAPI loopback path (same as v0.5.1). This captures
/// ALL system audio including our own TTS output. Earlier attempts to use the
/// Application Loopback API (ALAC) for self-exclusion were reverted in v0.5.3
/// because the implementation caused runtime crashes on Windows. Self-exclusion
/// will be revisited once it can be properly tested on a real Windows machine.
pub struct SystemAudioCapture {
    is_capturing: Mutex<Arc<AtomicBool>>,
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Mutex::new(Arc::new(AtomicBool::new(false))),
        }
    }

    /// Start capturing system audio via WASAPI loopback.
    /// Returns a receiver that yields PCM s16le 16kHz mono audio chunks.
    pub fn start(&self) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        let mut current = self.is_capturing.lock().map_err(|e| e.to_string())?;
        if current.load(Ordering::Acquire) {
            return Err("Already capturing".to_string());
        }

        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        // A fresh flag prevents a stopped worker from reviving when Start is
        // pressed again before the OS has finished releasing the old device.
        let is_capturing = Arc::new(AtomicBool::new(true));
        *current = is_capturing.clone();
        std::thread::spawn(move || {
            run_legacy_loopback(sender, is_capturing.clone());
            is_capturing.store(false, Ordering::Release);
        });

        Ok(receiver)
    }

    /// Stop capturing
    pub fn stop(&self) {
        if let Ok(current) = self.is_capturing.lock() {
            current.store(false, Ordering::Release);
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing
            .lock()
            .map(|current| current.load(Ordering::Acquire))
            .unwrap_or(false)
    }
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows API imports
// ─────────────────────────────────────────────────────────────────────────────

use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy WASAPI loopback path (captures all system audio)
// ─────────────────────────────────────────────────────────────────────────────

fn run_legacy_loopback(sender: mpsc::Sender<Vec<u8>>, is_capturing: Arc<AtomicBool>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[wasapi] Failed to create device enumerator: {}", e);
                    CoUninitialize();
                    return;
                }
            };

        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[wasapi] Failed to get default audio endpoint: {}", e);
                CoUninitialize();
                return;
            }
        };

        let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[wasapi] Failed to activate audio client: {}", e);
                CoUninitialize();
                return;
            }
        };

        let mix_format_ptr = match audio_client.GetMixFormat() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[wasapi] Failed to get mix format: {}", e);
                CoUninitialize();
                return;
            }
        };
        let mix_format = &*mix_format_ptr;

        let source_rate = mix_format.nSamplesPerSec;
        let source_channels = mix_format.nChannels as u32;
        let bits_per_sample = mix_format.wBitsPerSample;

        if let Err(e) = audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000, // 1 second buffer in 100ns units
            0,
            mix_format_ptr,
            None,
        ) {
            eprintln!(
                "[wasapi] Failed to initialize audio client in loopback mode: {}",
                e
            );
            CoUninitialize();
            return;
        }

        eprintln!("[wasapi] Using WASAPI loopback (legacy path)");

        let capture_client: IAudioCaptureClient = match audio_client.GetService() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[wasapi] Failed to get capture client: {}", e);
                CoUninitialize();
                return;
            }
        };

        if let Err(e) = audio_client.Start() {
            eprintln!("[wasapi] Failed to start audio client: {}", e);
            CoUninitialize();
            return;
        }

        // Defensive: skip capture entirely if channel count is zero.
        if source_channels == 0 {
            eprintln!("[wasapi] Unexpected mix format with zero channels — aborting");
            let _ = audio_client.Stop();
            CoUninitialize();
            return;
        }

        while is_capturing.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));

            let packet_size = match capture_client.GetNextPacketSize() {
                Ok(size) => size,
                Err(error) => {
                    eprintln!("[wasapi] Audio device stopped responding: {error}");
                    break;
                }
            };

            if packet_size == 0 {
                continue;
            }

            let mut buffer_ptr = std::ptr::null_mut();
            let mut num_frames = 0u32;
            let mut flags = 0u32;

            if let Err(error) =
                capture_client.GetBuffer(&mut buffer_ptr, &mut num_frames, &mut flags, None, None)
            {
                eprintln!("[wasapi] Failed to read audio buffer: {error}");
                break;
            }

            if num_frames > 0 && !buffer_ptr.is_null() {
                let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;

                if !is_silent {
                    let pcm_data = convert_to_pcm_s16_16k(
                        buffer_ptr,
                        num_frames,
                        source_rate,
                        source_channels,
                        bits_per_sample,
                    );

                    if !pcm_data.is_empty() {
                        if sender.send(pcm_data).is_err() {
                            break; // Receiver dropped
                        }
                    }
                }
            }

            if let Err(error) = capture_client.ReleaseBuffer(num_frames) {
                eprintln!("[wasapi] Failed to release audio buffer: {error}");
                break;
            }
        }

        // Cleanup: stop, drop COM objects, then CoUninitialize.
        let _ = audio_client.Stop();

        // Explicitly drop COM interface pointers BEFORE CoUninitialize.
        // Otherwise Rust's drop order would call Release() after COM is torn down.
        drop(capture_client);
        drop(audio_client);
        drop(device);
        drop(enumerator);

        CoUninitialize();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM conversion helper
// ─────────────────────────────────────────────────────────────────────────────

/// Convert raw WASAPI buffer to PCM s16le 16kHz mono
unsafe fn convert_to_pcm_s16_16k(
    buffer_ptr: *mut u8,
    num_frames: u32,
    source_rate: u32,
    source_channels: u32,
    bits_per_sample: u16,
) -> Vec<u8> {
    let frame_count = num_frames as usize;

    // WASAPI shared-mode mix format is typically 32-bit IEEE float.
    // We only handle that case; anything else returns empty (silent) data.
    if bits_per_sample != 32 || source_channels == 0 {
        return Vec::new();
    }

    let ptr = buffer_ptr as *const f32;
    let total_samples = frame_count * source_channels as usize;
    let f32_samples = std::slice::from_raw_parts(ptr, total_samples);

    // Take first channel only (mono)
    let mono: Vec<f32> = f32_samples
        .chunks(source_channels as usize)
        .map(|frame| frame[0])
        .collect();

    if mono.is_empty() || source_rate == 0 {
        return Vec::new();
    }

    // Downsample to 16kHz
    let ratio = source_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (mono.len() as f64 / ratio) as usize;

    let mut pcm_bytes: Vec<u8> = Vec::with_capacity(output_len * 2);

    for i in 0..output_len {
        let src_idx = (i as f64 * ratio) as usize;
        if src_idx >= mono.len() {
            break;
        }
        let sample = mono[src_idx].clamp(-1.0, 1.0);
        let s16 = (sample * 32767.0) as i16;
        pcm_bytes.extend_from_slice(&s16.to_le_bytes());
    }

    pcm_bytes
}
