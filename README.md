<p align="center">
  <img src="banner.png?v=2" alt="My Translator — Real-time Speech Translation">
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/jintianzhouyine/my-translator?color=green&label=release" alt="Latest Release">
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="Built with Tauri">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-10%2F11-blue?logo=windows" alt="Windows">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/github/stars/jintianzhouyine/my-translator?style=flat&color=yellow" alt="Stars">
</p>

**My Translator** is a real-time speech translation desktop app built with Tauri. It captures audio directly from your system or microphone, transcribes it, and displays translations in a minimal overlay — with no intermediary server involved.

> 📖 Installation guides: [macOS (EN)](docs/installation_guide.md) · [macOS (VI)](docs/installation_guide_vi.md) · [Windows (EN)](docs/installation_guide_win.md) · [Windows (VI)](docs/installation_guide_win_vi.md)

### ⬇️ Which build do I download?

This fork publishes macOS Apple Silicon and Windows ARM64 installers. Grab the matching file from the [latest release](https://github.com/jintianzhouyine/my-translator/releases/latest):

| Your machine | File |
|---|---|
| **Mac Apple Silicon** (M1/M2/M3/M4) | `MyTranslator_<ver>_aarch64.dmg` |
| **Windows ARM64** | `MyTranslator_<ver>_arm64-setup.exe` |

> On a Mac, check  → **About This Mac** → *Chip*: **Apple M-series** → `aarch64`, **Intel** → `x64`. Macs from late 2020 on are almost all Apple Silicon.
> This fork uses manual downloads from Releases; automatic update packages are not published. `SHA256SUMS` contains installer checksums. See the release notes for setup requirements.

---

## How It Works

```
                                    ┌── ☁️  Soniox  (text)              ──┐
System Audio / Mic → 16kHz PCM ─────┼── ⚡ OpenAI Realtime (text+🔊)      ─┼─→ Overlay UI
                                    ├── 🌏 Qwen3.8 LiveTranslate (text + speech) │
                                    └── 🖥️  Local MLX  (text, offline)   ─┘
                                                                            ↓ (optional, text engines)
                                                  TTS (Edge / Google / ElevenLabs) → 🔊
```

Four translation engines, pick what fits your call:

| Feature | Detail |
|---------|--------|
| **Engines** | ☁️ Soniox · ⚡ OpenAI Realtime · 🌏 Qwen LiveTranslate Flash · 🖥️ Local MLX |
| **Latency** | ~2 s (Soniox / OpenAI) · Qwen3.8 depends on network and turn detection; not yet benchmarked here · ~10 s (Local) |
| **Languages** | 70+ source → any target (Soniox), 13 targets (OpenAI), 60 text / 29 speech targets (Qwen), JA/EN/ZH/KO → VI/EN (Local) |
| **Cost** | ~$0.12/hr (Soniox) · ~$4/hr (OpenAI, includes voice) · Qwen billed by usage, with two sessions for duplex calls · Free (Local) |
| **TTS** | Optional TTS for Soniox / Local; Qwen3.8 generates outgoing translated speech directly |
| **Platform** | macOS (ARM + Intel) · Windows · Local mode = Apple Silicon only |
| **Signed** | macOS ad-hoc signature, not notarized; Windows installer has no publisher certificate |
| **Updates** | Download new versions manually from this fork's Releases |

> 📊 Detailed head-to-head: [**OpenAI Realtime vs Soniox benchmark**](docs/benchmark_openai_vs_soniox.md) — speed, quality, cost, and translation-mechanism comparison from a 5-min real-world test.

---

## Features

### 📖 Dual Panel View

Two display modes:
- **Single** (default) — Translation text only, clean and focused
- **Dual** — Source | Translation side-by-side, each panel scrolls independently

Toggle with the panel button (bottom-right on hover).

### 🔄 Smart Scroll

Auto-scroll only when you're at the bottom. Scroll up to read old content without being yanked back down.

### 🔤 Quick Font Size

A- / A+ floating controls (bottom-right on hover). Font size adjustable up to 140px — great for presentations.

### 🔄 Two-Way Translation

Translate conversations between two languages simultaneously — ideal for bilingual meetings.

- **One-way**: Source language → Target language (e.g., Japanese → Vietnamese)
- **Two-way**: Language A ↔ Language B (e.g., Vietnamese ↔ Japanese) — the app detects who is speaking and translates to the other language automatically

**Setup for video calls** (Zoom, Google Meet, MS Teams):
1. Audio Source: **Both** (System + Mic)
2. Translation Type: **Two-way**
3. Set Language A and Language B

> **Note**: TTS narration is automatically disabled in two-way mode to prevent audio feedback loops (TTS output → mic recapture → re-translation).

### 🎙️ TTS Narration

Read translations aloud in one-way mode — 3 providers:

| | Edge TTS ⭐ | Google Chirp 3 HD | ElevenLabs |
|-|-------------|-------------------|------------|
| **Cost** | Free | Free 1M chars/mo | ~$5/mo+ |
| **Quality** | ★★★★☆ Neural | ★★★★★ Near-human | ★★★★★ Premium |
| **Vietnamese** | ✅ 2 voices | ✅ 6 voices | ✅ Yes |
| **Setup** | None | Google Cloud API key | API key |
| **Speed control** | ✅ | ✅ 0.5x–2.0x | ❌ |

TTS is **OFF by default** — toggle with the TTS button or `⌘ T`.

> 📖 TTS guide: [English](docs/tts_guide.md) · [Tiếng Việt](docs/tts_guide_vi.md)

### 📖 Custom Translation Terms

Define how domain-specific words should be translated:

```
Original sin = Tội nguyên tổ
Christ = Kitô
Pneumonia = Viêm phổi
```

Add terms in Settings → Translation → Translation terms. Great for religious, medical, or technical content.

### ⚡ OpenAI Realtime Mode

Single-call streaming translation via OpenAI's `gpt-realtime-translate` (May 2026 GA). Returns **translated text *and* translated speech audio** over one WebSocket — no separate TTS step, lower end-to-end latency, more idiomatic output. Trade-off: **~$4/hr**, charged to your own OpenAI account. 13 target languages: en, es, pt, fr, de, it, ru, hi, id, vi, ja, ko, zh.

Two-way mode and the custom TTS toggle are unavailable while OpenAI Realtime is selected (audio is native).

### 🌏 Qwen3.8 LiveTranslate Duplex Mode

Uses `qwen3.8-livetranslate-flash-realtime` with two independent sessions:

- Your microphone → translated speech → an explicitly selected virtual audio output → the meeting application's microphone.
- Meeting audio → original and translated captions on your own computer.

Input language is detected automatically. Configure separate target languages and terminology dictionaries for each direction. Caption-only mode does not capture your microphone or require a virtual audio device. Native speech output does not need a separate TTS provider.

Import terminology from Excel (`.xlsx`) using the first two columns for source terms and translations. Select a worksheet, preview merge or replacement, resolve conflicts, and optionally swap columns for the opposite direction. CSV, TSV, TXT and JSON are also supported. Files are read locally, and each direction supports up to 1,000 terms. An [Excel example](docs/examples/qwen-terms.xlsx) is included.

The **音频翻译** tab translates local audio files into text and timed subtitles using the saved Qwen configuration. Accelerated mode divides recordings into requests of up to two minutes and runs two requests concurrently, preserving the original timeline; sequential mode is also available. Intermediate translations appear as they arrive. Transient failures retry up to twice, and failed requests can be retried or skipped individually without restarting completed parts. Click a translated segment to play its original audio range, then export translated, original or bilingual SRT/VTT/TXT. Desktop decoding uses locally installed FFmpeg / ffprobe (up to 16 GiB / 24 hours per source). You can adjust split points or import files you have already split if automatic decoding fails; each manually imported file is limited to 100 MiB / 30 minutes and keeps its file boundary. Actual speed depends on network and provider limits. See the [audio file translation guide](docs/audio-file-translation.md).

Supply a Bailian API key, workspace ID and matching Beijing or Singapore region. Duplex uses two billable sessions. Virtual audio drivers must be installed separately and selected in your meeting application; Windows ARM64 requires a compatible driver. See the [Chinese setup and verification guide](docs/qwen-duplex.md). Live provider access and end-to-end calls still require validation with your account and devices.

### 🖥️ Local Mode (Apple Silicon only)

Experimental offline mode using MLX + Whisper + Gemma — runs 100% on-device. JA/EN/ZH/KO → VI/EN.

---

## Privacy

**Your audio never touches our servers — because there are none.**

- App connects **directly** to APIs you configure — no relay, no middleman
- **You own your API keys** — stored locally, never transmitted elsewhere
- **No account, no telemetry, no analytics** — zero tracking
- Transcripts saved as `.md` files locally, per session

---

## Tech Stack

- **[Tauri 2](https://tauri.app/)** — Rust backend + WebView frontend
- **[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)** — macOS system audio
- **[WASAPI](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi)** — Windows system audio
- **[cpal](https://github.com/RustAudio/cpal)** — Cross-platform microphone
- **[Soniox](https://soniox.com)** — Real-time STT + translation
- **[OpenAI Realtime Translate](https://platform.openai.com/docs/guides/realtime)** — `gpt-realtime-translate` (text + native voice)
- **[MLX](https://github.com/ml-explore/mlx)** — On-device Whisper + Gemma for offline mode
- **[Piper](https://github.com/rhasspy/piper) via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — Local offline neural TTS (on-device, no network)
- **[Edge TTS](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/index-text-to-speech)** — Free neural TTS (default)
- **[Google Cloud TTS](https://cloud.google.com/text-to-speech)** — Chirp 3 HD (near-human quality)
- **[ElevenLabs](https://elevenlabs.io)** — Premium TTS

---

## Build from Source

```bash
git clone https://github.com/jintianzhouyine/my-translator.git
cd my-translator
npm install
npm run tauri build
```

Requires: Rust (stable), Node.js 18+, macOS 13+ or Windows 10+.

---

## Development Specifications

This project uses LeanSpec to track feature requirements, design decisions and acceptance checks.
See [the spec workflow](specs/README.md) and [project instructions](AGENTS.md).
Run `lean-spec board` from the repository root to view current work.

---

## Star History

<a href="https://www.star-history.com/?repos=phuc-nt%2Fmy-translator&type=date&legend=top-left">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&theme=dark&legend=top-left" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
  <img alt="Star History Chart" src="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT
