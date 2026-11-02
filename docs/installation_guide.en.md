# macOS Installation and Usage Guide

[简体中文](installation_guide.md) | **English** | [Tiếng Việt (legacy)](installation_guide_vi.md)

This guide covers the current repository's Mac Apple Silicon releases. The app interface is primarily Chinese; Chinese labels below help you locate controls.

## Requirements

- macOS 13 or later on an Apple Silicon (M-series) Mac.
- An internet connection and an API key for your chosen cloud service. Qwen also requires a Model Studio workspace ID and the matching service region.
- Local MLX mode requires Apple Silicon, additional model downloads, and available disk space.
- A separately installed virtual audio device is needed only when sending translated speech into a meeting app. Caption-only mode does not need one.

Cloud services bill usage to your provider account. Check current prices and quotas in the provider console. Configure only the engine you plan to use; you do not need keys for every engine.

## Download and Install

1. Open this repository's [Releases](https://github.com/jintianzhouyine/my-translator/releases/latest) and download `MyTranslator_<version>_aarch64.dmg`.
2. Open the DMG, drag **My Translator** to **Applications**, then eject the DMG.
3. Open My Translator from Applications.

This repository currently publishes Mac ARM64 and Windows x64 installers, with no new Intel Mac installer. Check your chip under Apple menu → **About This Mac**. Release assets include `SHA256SUMS` for installer verification.

The macOS app has an ad-hoc signature and is not signed with an Apple Developer ID or notarized. macOS may block the first launch. After confirming the download comes from this repository, follow the prompt in **System Settings → Privacy & Security** to allow it, then reopen the app.

## Grant Audio Capture Permissions

- **Captions from meeting/system audio:** allow My Translator under **System Settings → Privacy & Security → Screen & System Audio Recording**. Older macOS versions may call this **Screen Recording**.
- **Your microphone or duplex calls:** also allow **Microphone** access.
- Quit and reopen when macOS requests it, then click **开始** (Start). Permissions belong to the running application identity; `MyTranslator Dev` and the release app may have separate entries.

Audio file translation reads selected local files and does not require screen recording or microphone permission.

## Choose and Configure an Engine

Choose an engine during first-run setup; the app remembers it. You can change engines from the live toolbar later. Choosing an engine does not automatically start capture or a cloud session.

| Engine | Configuration | Uses and limits |
| --- | --- | --- |
| **Qwen3.8 实时通话翻译** | Model Studio API key, workspace ID, Beijing or Singapore region | Meeting audio to local captions; your speech to translated audio through a virtual microphone; separate terminology for each direction |
| **Soniox** | Soniox API key | Cloud transcription and text translation; optional separate TTS narration |
| **OpenAI Realtime** | OpenAI API key | One-way cloud realtime captions; the current start flow disables voice playback, Soniox-style duplex mode, and separate TTS |
| **本地 MLX** (Local MLX) | Local models | Experimental offline transcription and translation on Apple Silicon; language coverage differs from the cloud engines |

Open **设置 → 翻译引擎** (Settings → Translation Engine), choose an engine, enter its configuration, then click **保存并关闭** (Save & Close). Cloud engines remain selectable without a key, but configuration is validated before starting. A valid-looking key does not confirm model access or sufficient balance.

### Qwen: Verify Captions Before Outgoing Speech

1. Choose Qwen and enter a Model Studio API key, workspace ID, and service region that belong together.
2. Set **我阅读字幕的语言** (My caption language). Turn off **双向通话** (Duplex), save, play meeting or video audio, then click **开始** to verify captions.
3. To send translated speech to the other participant, install a virtual device such as BlackHole, then enable **双向通话**.
4. Select your physical microphone and set **发给对方的译音输出** (Outgoing translated audio) to the virtual device. Use headphones for the meeting speakers.
5. With automatic system-device management enabled, BlackHole can be paired automatically; use **System Default Microphone** in the meeting app. For other virtual devices, disable automatic management and select the matching meeting input manually.

**我阅读字幕的语言** and **对方听到的语言** (Language the other participant hears) must differ in duplex mode. The top-right **发给对方** (Send to other participant) controls independently enable and adjust original and translated speech. Pause, stop, and normal exit attempt to restore recorded system audio defaults; after a forced termination, recovery can only be attempted on the next launch.

See the [Qwen duplex guide](qwen-duplex.en.md) for complete routing, recovery limits, and Excel terminology imports.

## Everyday Use

- **Live captions:** click **开始** on the live page and **停止** (Stop) when finished. Engines such as Soniox offer System Audio, Microphone, or Both; Qwen uses its separate call configuration.
- **Bilingual display:** use **设置 → 显示设置** (Settings → Display) or **更多 → 双语字幕** (More → Bilingual Captions). Stacked and dual-column layouts are available; see [live bilingual captions](live-subtitles.en.md).
- **Narration:** text engines can use local Piper or cloud TTS; see the [TTS guide](tts_guide.en.md). Qwen call speech is generated directly by the translation model.
- **Audio files:** open **音频翻译** (Audio Translation), select a file and target language. Automatic decoding and splitting require FFmpeg and ffprobe to be available locally; already-split files can also be imported. Click translations to replay their audio and export SRT/VTT/TXT; see [audio file translation](audio-file-translation.en.md).
- **History:** use **翻译记录** (Translation History) for saved sessions. Export file-translation results before changing files or quitting.

This older screenshot is a visual reference only; follow the current UI for labels, layout, and Qwen configuration:

![Older Soniox settings example](user_manual/setting_soniox.png)

## Keyboard Shortcuts

Use these when you are not typing into an input, text area, or select control:

| Shortcut | Action |
| --- | --- |
| `⌘ Enter` | Start / Stop on the live page |
| `⌘ ,` | Open Settings |
| `Esc` | Close Settings or the shortcut sheet |
| `⌘ 1` / `⌘ 2` / `⌘ 3` | System Audio / Microphone / Both for other engines |
| `⌘ T` | Toggle separate TTS where supported |
| `?` | Show shortcut help |

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Capture is denied after permission was granted | Confirm that the running version is authorized, then quit and reopen. An old development-build entry may need removal and fresh authorization in System Settings |
| No captions after Start | Make sure audio is playing, the selected engine is configured, the network is available, and system-audio capture is authorized |
| Qwen connection fails | Check that the key, workspace, and region match; inspect model permissions, balance, and the error message. The old “Singapore only” instructions no longer apply |
| No microphone found | Connect an available USB, headset, or other physical microphone, then refresh devices |
| The other participant cannot hear translated speech | Check the installed virtual device, translated-speech switch and volume, and the pairing of output and meeting microphone |
| System sound is wrong after stopping | Check default input/output in system sound settings. Reconnect the original device and retry recovery; see the Qwen guide |
| Long audio cannot be decoded or split | Check FFmpeg/ffprobe or use **导入已切分音频** (Import Split Audio). A decode failure is not a cloud-key failure |

## Updates

**设置 → 关于 → 检查更新** (Settings → About → Check for Updates) reads this repository's latest published Release. Open GitHub, download the matching DMG, and replace the app. Updates are not automatically downloaded, installed, or restarted; draft releases are not treated as the latest published version.
