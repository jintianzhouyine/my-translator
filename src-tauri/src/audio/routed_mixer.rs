//! Two independent mono timelines mixed at the output device's sample rate.
//! This module is hardware-independent so routing/mute behavior can be tested
//! without opening a microphone or invoking a cloud service.

use serde::Deserialize;
use std::collections::VecDeque;

const MICROPHONE_RATE: u32 = 16_000;
const TRANSLATION_RATE: u32 = 24_000;
const MAX_ORIGINAL_SAMPLES: usize = MICROPHONE_RATE as usize * 120 / 1000;
const MAX_TRANSLATED_SAMPLES: usize = TRANSLATION_RATE as usize * 30;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSettings {
    pub original_enabled: bool,
    pub original_volume: f32,
    pub translated_enabled: bool,
    pub translated_volume: f32,
}

impl Default for MixSettings {
    fn default() -> Self {
        Self {
            original_enabled: false,
            original_volume: 1.0,
            translated_enabled: true,
            translated_volume: 1.0,
        }
    }
}

impl MixSettings {
    fn validate(&self) -> Result<(), String> {
        for gain in [self.original_volume, self.translated_volume] {
            if !gain.is_finite() || !(0.0..=1.0).contains(&gain) {
                return Err("原声和译音的音量必须在 0% 到 100% 之间".into());
            }
        }
        Ok(())
    }
    fn original_audible(&self) -> bool {
        self.original_enabled && self.original_volume > 0.0
    }
    fn translated_audible(&self) -> bool {
        self.translated_enabled && self.translated_volume > 0.0
    }
}

struct SourceQueue {
    samples: VecDeque<f32>,
    phase: f64,
    source_rate: u32,
}

impl SourceQueue {
    fn new(source_rate: u32) -> Self {
        Self {
            samples: VecDeque::new(),
            phase: 0.0,
            source_rate,
        }
    }
    fn clear(&mut self) {
        self.samples.clear();
        self.phase = 0.0;
    }
    fn push(&mut self, pcm: &[u8]) {
        self.samples.extend(
            pcm.chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
        );
    }
    fn next_sample(&mut self, device_rate: u32) -> f32 {
        let index = self.phase.floor() as usize;
        if index + 1 >= self.samples.len() {
            return 0.0;
        }
        let fraction = (self.phase - index as f64) as f32;
        let sample = self.samples[index] * (1.0 - fraction) + self.samples[index + 1] * fraction;
        self.phase += self.source_rate as f64 / device_rate as f64;
        let consumed = (self.phase.floor() as usize).min(self.samples.len() - 1);
        self.samples.drain(..consumed);
        self.phase -= consumed as f64;
        sample
    }
}

pub struct PlaybackMixer {
    original: SourceQueue,
    translated: SourceQueue,
    settings: MixSettings,
    device_rate: u32,
}

impl PlaybackMixer {
    pub fn new(settings: MixSettings) -> Result<Self, String> {
        settings.validate()?;
        Ok(Self {
            original: SourceQueue::new(MICROPHONE_RATE),
            translated: SourceQueue::new(TRANSLATION_RATE),
            settings,
            device_rate: TRANSLATION_RATE,
        })
    }
    pub fn set_device_rate(&mut self, rate: u32) {
        debug_assert!(rate > 0);
        self.device_rate = rate;
    }
    pub fn set_mix(&mut self, settings: MixSettings) -> Result<(), String> {
        settings.validate()?;
        // A muted interval must never be replayed when a channel is re-enabled.
        if !settings.original_audible() {
            self.original.clear();
        }
        if !settings.translated_audible() {
            self.translated.clear();
        }
        self.settings = settings;
        Ok(())
    }
    pub fn clear(&mut self) {
        self.original.clear();
        self.translated.clear();
    }
    pub fn push_original(&mut self, pcm: &[u8]) -> Result<(), String> {
        if pcm.len() % 2 != 0 {
            return Err("原声 PCM 数据长度无效".into());
        }
        if !self.settings.original_audible() {
            return Ok(());
        }
        // Mic monitoring prioritizes current speech over accumulated old samples.
        // Bound allocations even when a capture backend delivers an unusually big packet.
        let keep_bytes = (MAX_ORIGINAL_SAMPLES * 2).min(pcm.len());
        let pcm = &pcm[pcm.len() - keep_bytes..];
        let excess =
            (self.original.samples.len() + pcm.len() / 2).saturating_sub(MAX_ORIGINAL_SAMPLES);
        if excess > 0 {
            self.original.samples.drain(..excess);
            self.original.phase = 0.0;
        }
        self.original.push(pcm);
        Ok(())
    }
    /// Returns true when old translated audio was discarded to keep playback bounded.
    pub fn push_translated(&mut self, pcm: &[u8]) -> Result<bool, String> {
        if pcm.len() % 2 != 0 {
            return Err("译音 PCM 数据长度无效".into());
        }
        if !self.settings.translated_audible() {
            return Ok(false);
        }
        // Cloud speech may arrive faster than real time, especially for long
        // sentences. Permit that burst and retain the newest audio if it exceeds
        // the bound, without stopping the device or changing microphone audio.
        let keep_bytes = (MAX_TRANSLATED_SAMPLES * 2).min(pcm.len());
        let discarded_input = pcm.len() > keep_bytes;
        let pcm = &pcm[pcm.len() - keep_bytes..];
        let excess =
            (self.translated.samples.len() + pcm.len() / 2).saturating_sub(MAX_TRANSLATED_SAMPLES);
        if excess > 0 {
            self.translated.samples.drain(..excess);
        }
        let discarded = discarded_input || excess > 0;
        if discarded {
            self.translated.phase = 0.0;
        }
        self.translated.push(pcm);
        Ok(discarded)
    }
    pub fn next_sample(&mut self) -> f32 {
        let original = self.original.next_sample(self.device_rate) * self.settings.original_volume;
        let translated =
            self.translated.next_sample(self.device_rate) * self.settings.translated_volume;
        // Enabled flags are enforced on write and by clearing on mute; clamping
        // prevents integer wraparound or out-of-range float output when both talk.
        (original + translated).clamp(-1.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(value: i16, count: usize) -> Vec<u8> {
        value.to_le_bytes().repeat(count)
    }
    fn both() -> MixSettings {
        MixSettings {
            original_enabled: true,
            ..MixSettings::default()
        }
    }

    #[test]
    fn default_never_passes_the_microphone_to_output() {
        let mut mixer = PlaybackMixer::new(MixSettings::default()).unwrap();
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        assert!(mixer.original.samples.is_empty());
        assert_eq!(mixer.next_sample(), 0.0);
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        assert_eq!(mixer.next_sample(), 0.5);
    }
    #[test]
    fn mixes_simultaneously_with_independent_volume_and_clipping() {
        let settings = MixSettings {
            original_volume: 0.5,
            translated_volume: 0.25,
            ..both()
        };
        let mut mixer = PlaybackMixer::new(settings).unwrap();
        mixer.set_device_rate(48_000);
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        assert_eq!(mixer.next_sample(), 0.375);
        mixer.set_mix(both()).unwrap();
        assert_eq!(mixer.next_sample(), 1.0);
        mixer.clear();
        mixer.push_original(&pcm(i16::MIN, 3)).unwrap();
        mixer.push_translated(&pcm(i16::MIN, 3)).unwrap();
        assert_eq!(mixer.next_sample(), -1.0);
    }
    #[test]
    fn independent_mute_discards_pending_and_future_audio_until_reenabled() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(8_192, 240)).unwrap();
        mixer
            .set_mix(MixSettings {
                translated_enabled: false,
                ..both()
            })
            .unwrap();
        mixer.push_translated(&pcm(8_192, 240)).unwrap();
        assert_eq!(mixer.next_sample(), 0.5);
        mixer.set_mix(both()).unwrap();
        assert_eq!(mixer.next_sample(), 0.5); // no stale translation
        mixer
            .set_mix(MixSettings {
                original_enabled: false,
                ..both()
            })
            .unwrap();
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(8_192, 240)).unwrap();
        assert_eq!(mixer.next_sample(), 0.25);
        mixer.set_mix(both()).unwrap();
        assert_eq!(mixer.next_sample(), 0.25); // no stale microphone
    }
    #[test]
    fn zero_volume_is_mute_and_hot_gain_changes_apply_to_pending_audio() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        mixer
            .set_mix(MixSettings {
                original_volume: 0.0,
                translated_volume: 0.0,
                ..both()
            })
            .unwrap();
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        mixer.set_mix(both()).unwrap();
        assert_eq!(mixer.next_sample(), 0.0);
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        mixer
            .set_mix(MixSettings {
                translated_volume: 0.5,
                ..both()
            })
            .unwrap();
        assert_eq!(mixer.next_sample(), 0.25);
    }
    #[test]
    fn mic_and_translation_overflow_keep_recent_audio_with_independent_bounds() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer
            .push_original(&pcm(8_192, MAX_ORIGINAL_SAMPLES))
            .unwrap();
        mixer
            .push_original(&pcm(16_384, MAX_ORIGINAL_SAMPLES + 100))
            .unwrap();
        assert_eq!(mixer.original.samples.len(), MAX_ORIGINAL_SAMPLES);
        assert_eq!(mixer.next_sample(), 0.5);
        assert!(!mixer
            .push_translated(&pcm(0, MAX_TRANSLATED_SAMPLES))
            .unwrap());
        assert!(mixer.push_translated(&pcm(0, 1)).unwrap());
        assert_eq!(mixer.translated.samples.len(), MAX_TRANSLATED_SAMPLES);
    }

    #[test]
    fn a_normal_long_sentence_burst_is_kept_in_full() {
        let mut mixer = PlaybackMixer::new(MixSettings::default()).unwrap();
        let count = TRANSLATION_RATE as usize * 12;
        assert!(!mixer.push_translated(&pcm(8_192, count)).unwrap());
        assert_eq!(mixer.translated.samples.len(), count);
        assert_eq!(mixer.next_sample(), 0.25);
    }

    #[test]
    fn translation_overflow_discards_oldest_samples_and_preserves_original_audio() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer.set_device_rate(48_000);
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer
            .push_translated(&pcm(8_192, MAX_TRANSLATED_SAMPLES))
            .unwrap();
        assert_eq!(mixer.next_sample(), 0.75);
        let original_samples = mixer.original.samples.clone();
        let original_phase = mixer.original.phase;
        assert!(mixer.push_translated(&pcm(16_384, 10)).unwrap());
        assert_eq!(mixer.translated.samples.len(), MAX_TRANSLATED_SAMPLES);
        assert_eq!(mixer.translated.phase, 0.0);
        assert_eq!(mixer.translated.samples.front(), Some(&0.25));
        assert_eq!(mixer.translated.samples.back(), Some(&0.5));
        assert_eq!(mixer.original.samples, original_samples);
        assert_eq!(mixer.original.phase, original_phase);
        assert_eq!(mixer.next_sample(), 0.75);
    }

    #[test]
    fn an_oversized_packet_keeps_only_its_newest_thirty_seconds() {
        let mut mixer = PlaybackMixer::new(MixSettings::default()).unwrap();
        mixer.push_translated(&pcm(16_384, 100)).unwrap();
        let mut packet = pcm(i16::MIN, 10);
        packet.extend(pcm(8_192, MAX_TRANSLATED_SAMPLES));
        assert!(mixer.push_translated(&packet).unwrap());
        assert_eq!(mixer.translated.samples.len(), MAX_TRANSLATED_SAMPLES);
        assert!(mixer
            .translated
            .samples
            .iter()
            .all(|sample| *sample == 0.25));
        assert_eq!(mixer.next_sample(), 0.25);
        mixer
            .set_mix(MixSettings {
                translated_enabled: false,
                ..MixSettings::default()
            })
            .unwrap();
        assert!(!mixer.push_translated(&packet).unwrap());
        assert!(mixer.translated.samples.is_empty());
    }
    #[test]
    fn invalid_pcm_and_gain_are_rejected_without_changing_mix() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        assert!(mixer.push_original(&[0]).is_err());
        assert!(mixer.push_translated(&[0]).is_err());
        for gain in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            assert!(mixer
                .set_mix(MixSettings {
                    original_volume: gain,
                    ..both()
                })
                .is_err());
            assert!(PlaybackMixer::new(MixSettings {
                translated_volume: gain,
                ..both()
            })
            .is_err());
        }
        assert_eq!(mixer.settings.original_volume, 1.0);
    }
    #[test]
    fn clear_removes_both_queues_and_fractional_positions() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer.set_device_rate(44_100);
        mixer.push_original(&pcm(16_384, 160)).unwrap();
        mixer.push_translated(&pcm(16_384, 240)).unwrap();
        mixer.next_sample();
        mixer.clear();
        assert_eq!(mixer.next_sample(), 0.0);
        assert_eq!(mixer.original.phase, 0.0);
        assert_eq!(mixer.translated.phase, 0.0);
    }
    #[test]
    fn resamples_both_timelines_to_the_same_wall_clock_duration() {
        for output_rate in [16_000, 24_000, 44_100, 48_000] {
            let mut mixer = PlaybackMixer::new(both()).unwrap();
            mixer.set_device_rate(output_rate);
            mixer.push_original(&pcm(8_192, 1_600)).unwrap();
            mixer.push_translated(&pcm(8_192, 2_400)).unwrap();
            let frames = (0..output_rate / 10)
                .map(|_| mixer.next_sample())
                .collect::<Vec<_>>();
            assert!(frames[..frames.len() - 4]
                .iter()
                .all(|&sample| sample == 0.5));
            assert_eq!(mixer.next_sample(), 0.0);
            assert!(mixer.original.samples.len() <= 1);
            assert!(mixer.translated.samples.len() <= 1);
        }
    }
    #[test]
    fn translation_interpolates_across_network_chunks_and_silences_underflow() {
        let mut mixer = PlaybackMixer::new(MixSettings::default()).unwrap();
        mixer.set_device_rate(48_000);
        mixer.push_translated(&[0, 0, 0, 64]).unwrap();
        assert_eq!(mixer.next_sample(), 0.0);
        assert_eq!(mixer.next_sample(), 0.25);
        assert_eq!(mixer.next_sample(), 0.0);
        mixer.push_translated(&[0, 0]).unwrap();
        assert_eq!(mixer.next_sample(), 0.5);
        assert_eq!(mixer.next_sample(), 0.25);
    }

    #[test]
    fn original_underflow_never_repeats_audio_or_stalls_translation() {
        let mut mixer = PlaybackMixer::new(both()).unwrap();
        mixer.set_device_rate(16_000);
        mixer.push_original(&pcm(16_384, 10)).unwrap();
        mixer.push_translated(&pcm(8_192, 240)).unwrap();
        for _ in 0..9 {
            assert_eq!(mixer.next_sample(), 0.75);
        }
        for _ in 0..100 {
            assert_eq!(mixer.next_sample(), 0.25);
        }
        // Only the interpolation boundary sample remains; a packet cannot replay.
        assert_eq!(mixer.original.samples.len(), 1);
        mixer.push_original(&pcm(0, 10)).unwrap();
        assert_eq!(mixer.next_sample(), 0.75);
        assert_eq!(mixer.next_sample(), 0.25);
    }
}
