use screencapturekit::prelude::*;
use screencapturekit::stream::delegate_trait::ErrorHandler;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use super::TARGET_SAMPLE_RATE;

/// Audio handler that receives CMSampleBuffer callbacks from ScreenCaptureKit
/// and sends PCM data through a channel.
struct AudioHandler {
    sender: mpsc::SyncSender<Vec<u8>>,
    is_capturing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
        match output_type {
            SCStreamOutputType::Audio => {
                if let Some(audio_buffer_list) = sample.audio_buffer_list() {
                    // ScreenCaptureKit with stereo config may deliver audio as:
                    // - 2 separate mono buffers (deinterleaved L/R), OR
                    // - 1 interleaved stereo buffer
                    // We only need ONE channel for speech, so take just the first buffer
                    let mut iter = audio_buffer_list.into_iter();
                    if let Some(audio_buffer) = iter.next() {
                        let raw_data = audio_buffer.data();

                        if raw_data.is_empty() {
                            return;
                        }

                        // Interpret raw bytes as f32 samples (mono — first channel only)
                        let f32_samples: &[f32] = unsafe {
                            std::slice::from_raw_parts(
                                raw_data.as_ptr() as *const f32,
                                raw_data.len() / 4,
                            )
                        };

                        // Downsample 48kHz -> 16kHz (factor of 3)
                        let source_rate = 48000u32;
                        let ratio = source_rate / TARGET_SAMPLE_RATE; // 3

                        let downsampled: Vec<f32> = f32_samples
                            .iter()
                            .step_by(ratio as usize)
                            .copied()
                            .collect();

                        // Convert f32 [-1.0, 1.0] to i16 PCM s16le
                        let pcm_s16: Vec<u8> = downsampled
                            .iter()
                            .flat_map(|&sample| {
                                let clamped = sample.clamp(-1.0, 1.0);
                                let s16 = (clamped * 32767.0) as i16;
                                s16.to_le_bytes()
                            })
                            .collect();

                        if !pcm_s16.is_empty() {
                            if let Err(error) = self.sender.try_send(pcm_s16) {
                                if let mpsc::TrySendError::Full(_) = error {
                                    if let Ok(mut last_error) = self.last_error.lock() {
                                        *last_error = Some(
                                            "系统声音采集积压，已停止以避免翻译过期音频".into(),
                                        );
                                    }
                                }
                                self.is_capturing.store(false, Ordering::Release);
                            }
                        }
                    }
                }
            }
            _ => {
                // Ignore video frames
            }
        }
    }
}

/// System audio capture using ScreenCaptureKit
/// Captures all system audio output and converts to PCM s16le 16kHz mono.
pub struct SystemAudioCapture {
    is_capturing: Arc<AtomicBool>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    /// Start capturing system audio.
    /// Returns a receiver that yields PCM s16le 16kHz mono audio chunks.
    pub fn start(&self) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err("Already capturing".to_string());
        }
        self.stop();
        *self.last_error.lock().map_err(|e| e.to_string())? = None;

        // Get available displays
        let content = SCShareableContent::get().map_err(|e| {
            format!(
                "Failed to get shareable content (Screen Recording permission needed): {}",
                e
            )
        })?;

        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or("No displays found".to_string())?;

        // Create content filter for the main display
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        // Request mono explicitly so buffer layout never doubles the PCM timeline.
        // Configure: audio only, 48kHz mono (ScreenCaptureKit native rate)
        // Downsampling to 16kHz mono happens in AudioHandler
        let config = SCStreamConfiguration::new()
            .with_width(2) // minimal video (required by API)
            .with_height(2)
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true) // Prevent TTS audio feedback loop
            .with_sample_rate(48000)
            .with_channel_count(1);

        // Create channel for audio data
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(100);

        let handler = AudioHandler {
            sender,
            is_capturing: self.is_capturing.clone(),
            last_error: self.last_error.clone(),
        };
        let error_flag = self.is_capturing.clone();
        let last_error = self.last_error.clone();
        let delegate = ErrorHandler::new(move |error| {
            if let Ok(mut last_error) = last_error.lock() {
                *last_error = Some(format!("系统声音采集已停止：{error}"));
            }
            error_flag.store(false, Ordering::Release);
        });

        // Create and start the stream
        let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);
        stream
            .add_output_handler(handler, SCStreamOutputType::Audio)
            .ok_or_else(|| "无法注册系统声音采集回调".to_string())?;

        self.is_capturing.store(true, Ordering::SeqCst);
        if let Err(error) = stream.start_capture() {
            self.is_capturing.store(false, Ordering::Release);
            return Err(format!("Failed to start system audio capture: {error}"));
        }

        // Keep the stream alive in a background thread
        let is_capturing = self.is_capturing.clone();
        let worker = std::thread::spawn(move || {
            while is_capturing.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = stream.stop_capture();
        });
        *self.worker.lock().map_err(|e| e.to_string())? = Some(worker);

        Ok(receiver)
    }

    /// Stop capturing
    pub fn stop(&self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }

    pub fn take_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .ok()
            .and_then(|mut error| error.take())
    }
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
