<p align="center">
  <img src="banner.png?v=2" alt="My Translator — Real-time speech translation and bilingual captions">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/jintianzhouyine/my-translator/releases/latest"><img src="https://img.shields.io/github/v/release/jintianzhouyine/my-translator?color=green&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="Built with Tauri">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Windows-x64-blue?logo=windows" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/github/stars/jintianzhouyine/my-translator?style=flat&color=yellow" alt="Repository stars">
</p>

# My Translator

A Tauri 2 desktop tool for **live bilingual captions, translated speech for two-way calls, and audio file translation**. Capture system audio or your microphone and use your own cloud service credentials for recognition and translation, or try experimental local translation on Apple Silicon.

Install the app on your own computer to read translated captions of the other person's speech or send your translated voice into a meeting through a virtual microphone. The app interface is currently primarily Chinese; project documentation is available in Chinese and English.

[Download](https://github.com/jintianzhouyine/my-translator/releases/latest) · [Documentation](docs/README.en.md) · [Report an issue](https://github.com/jintianzhouyine/my-translator/issues)

## Download and installation

Current release installers target:

| Computer | Installer |
| --- | --- |
| Mac with Apple Silicon (M-series) | `MyTranslator_<version>_aarch64.dmg` |
| Windows with 64-bit Intel / AMD | `MyTranslator_<version>_x64-setup.exe` |

Use the release's `SHA256SUMS` to verify installers. The in-app update check reads this repository's published releases and directs you to download manually; new releases are built manually through GitHub Actions. The older Windows ARM64 installer remains in [v0.10.0](https://github.com/jintianzhouyine/my-translator/releases/tag/v0.10.0). New Windows ARM64 and Mac Intel installers are not currently provided.

macOS installers are ad-hoc signed and not notarized; Windows installers do not have a publisher certificate signature. See the [macOS guide](docs/installation_guide.en.md) or [Windows guide](docs/installation_guide_win.en.md) for installation and permissions.

## Features

### Live captions

- Capture system audio, the microphone, or both.
- Show translations only or enable bilingual captions with source and translated text, stacked or in two columns.
- Use an always-on-top window, compact mode, font size and color controls, and auto-scroll that lets you read earlier text without jumping back down.
- Save and browse local session history; hiding source text does not delete received transcripts.

See [live bilingual captions](docs/live-subtitles.en.md). Source text availability depends on the selected engine's recognition output.

### Qwen two-way calls

Uses Bailian's `qwen3.8-livetranslate-flash-realtime` with an independent session in each direction:

```text
Your speech → recognition and translation → translated speech → virtual microphone → meeting participant
Their speech → capture meeting audio → recognition and translation → local source and translated captions
```

- Choose separate languages for what the other person hears and what you read. Input language is detected automatically.
- Independently control **original microphone audio, translated speech, and each volume** in the top-right of the Live page.
- Set the virtual input as the system default microphone, then restore recorded audio devices on pause, stop, failed startup, or normal exit. After a forced process exit, recovery is attempted at the next launch.
- Automatic pairing supports BlackHole on macOS and standard VB-CABLE names on Windows, including A/B/C/D; other devices can use manual routing.
- Turn off two-way calling for captions only, without a virtual microphone.

Supply your own Bailian API key, workspace ID, and matching Beijing or Singapore region. Two-way calling uses two separately metered sessions and generates speech directly without a separate TTS provider. Install virtual audio drivers separately and configure the meeting application to use the corresponding input or the system default microphone. See [Qwen setup and audio routing](docs/qwen-duplex.en.md).

### Terminology import

Maintain separate dictionaries for each Qwen direction. Import Excel (`.xlsx`), CSV, TSV, TXT, or JSON files; preview before merging, overwriting conflicts, or replacing a dictionary. Swap the two columns for the reverse direction. Each direction supports up to 1,000 entries.

An [Excel example](docs/examples/qwen-terms.xlsx) is included. Dictionaries provide preferred translations to the model rather than guaranteeing exact replacements; see [terminology and import instructions](docs/qwen-duplex.en.md#terminology-dictionaries).

### Audio file translation and subtitle playback

- Select a local recording to generate source text, translations, and timed subtitles using your saved Qwen realtime configuration.
- Split automatically, set custom split points, or import files you have already split.
- Process up to two requests concurrently in accelerated mode, with intermediate text, automatic retries for transient errors, and individual retry or skip controls for failed parts.
- Click a translation to play its original audio range, then export translated, source, or bilingual SRT / VTT / TXT.

Desktop automatic decoding requires locally installed FFmpeg / ffprobe, which are not bundled. Automatic decoding accepts a source file up to 16 GiB and 24 hours; each manually imported part is limited to 100 MiB and 30 minutes. Alignment is at speech-segment level, and actual timing and translation depend on the service response. See [audio file translation](docs/audio-file-translation.en.md).

### Translation engines and text-to-speech

| Engine | Use in this app | Requirements |
| --- | --- | --- |
| Qwen LiveTranslate | Two-way call speech, local captions, audio file translation | Bailian key, workspace, region; virtual audio device for outgoing calls |
| Soniox | Streaming recognition and text translation, bilingual conversations, context and terminology | Soniox API key |
| OpenAI Realtime | One-way streaming text captions; voice playback is disabled in the current UI | OpenAI API key |
| Local MLX (experimental) | On-device recognition and translation | Apple Silicon, Python environment, and local models |

Language coverage, source transcripts, and speech capabilities vary by engine. Qwen's call-routing features do not apply to every engine. Cloud usage is billed to your service account; actual pricing, language support, and latency depend on the provider and usage.

Soniox and local text translation can use a separate TTS provider. Options include Edge, Google, ElevenLabs, and offline Piper voices via sherpa-onnx. Download offline voice models first; the existing catalog is primarily Vietnamese and English. A separate Text-to-Speech (`文本朗读`) page also plays pasted text. See the [TTS guide](docs/tts_guide.en.md).

## Data and privacy

- Cloud modes connect directly to the service you configure. Audio, terminology, and required context are sent to that provider, without a relay server operated by this project.
- API keys and settings are stored locally. Do not commit keys or private recordings to the repository.
- File selection and splitting happen locally. Corresponding audio is sent when you start translation; exports and session history are saved locally.
- Local MLX translation and Piper speech can run on-device once their models and runtime are ready. Cloud modes require internet access.

## Run from source

Requires Node.js 20+, Rust stable, and the platform's Tauri native build tools. macOS needs Xcode Command Line Tools; Windows needs MSVC C++ build tools and WebView2.

```bash
git clone https://github.com/jintianzhouyine/my-translator.git
cd my-translator
npm ci
```

On Windows x64, also prepare the speech libraries before building:

```powershell
./scripts/prepare-windows-x64.ps1
```

After setup, start the app:

```bash
npm run dev
```

Use `npm run build` to package and `npm test` to run application JavaScript tests. Run native tests with `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`. The browser preview, `npm run dev:web`, does not provide native audio capture or routing.

LeanSpec records requirements and acceptance checks: run `lean-spec board` from the repository root. Contributor instructions are in [AGENTS.md](AGENTS.md) and [specs/README.md](specs/README.md), currently in Chinese. See [manual builds and releases](docs/releasing.en.md). Automated tests do not replace end-to-end validation with a real cloud account, virtual devices, and meeting software.

## Documentation

See the [documentation index](docs/README.en.md) for Chinese and English editions.

- [macOS installation](docs/installation_guide.en.md) · [Windows installation](docs/installation_guide_win.en.md)
- [Qwen two-way calls](docs/qwen-duplex.en.md) · [Live bilingual captions](docs/live-subtitles.en.md)
- [Audio file translation](docs/audio-file-translation.en.md) · [Text-to-speech](docs/tts_guide.en.md)
- [Builds and releases](docs/releasing.en.md) · [Historical changelog](docs/project-changelog.en.md)
- [Historical benchmarks](benchmarks/README.en.md)

## Star History

<a href="https://www.star-history.com/?repos=jintianzhouyine%2Fmy-translator&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&legend=top-left" />
    <img alt="Star history for jintianzhouyine/my-translator" src="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&legend=top-left" />
  </picture>
</a>

## Credits and license

This project builds on [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator). It is distributed under the [MIT license](LICENSE), retaining the original copyright and license notice.
