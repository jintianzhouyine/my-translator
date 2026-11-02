# Windows Installation and Usage Guide

[简体中文](installation_guide_win.md) | **English** | [Tiếng Việt (legacy)](installation_guide_win_vi.md)

This guide covers the current repository's Windows x64 releases. The app interface is primarily Chinese; Chinese labels below help you locate controls.

## Requirements

- Windows 10/11 on a 64-bit Intel/AMD (x64) PC.
- Microsoft Edge WebView2 Runtime; install it if the app reports it missing.
- An internet connection and an API key for your chosen cloud service. Qwen also requires a Model Studio workspace ID and matching service region.
- A separately installed virtual audio driver is needed only for sending translated speech into a meeting app. Caption-only mode does not need one.

New installers target x64, not 32-bit x86 or ARM64. Older Windows ARM64 installers remain in [v0.10.0](https://github.com/jintianzhouyine/my-translator/releases/tag/v0.10.0). Local MLX translation supports Apple Silicon Macs only; choose a cloud engine on Windows. Local Piper TTS is a separate feature and is available on Windows.

Check service prices and quotas in the provider console. Configure only the engine you will use; keys for every service are not required.

## Download and Install

1. Download `MyTranslator_<version>_x64-setup.exe` from this repository's [Releases](https://github.com/jintianzhouyine/my-translator/releases/latest).
2. Open the installer and follow the wizard to select a location and install.
3. Launch **My Translator** when installation finishes.

Release assets include `SHA256SUMS` for installer verification. The installer has no publisher certificate, so Windows SmartScreen may show **Windows protected your PC**. After confirming the file comes from this repository, choose **More info → Run anyway** if available. Managed-device policies may prevent this; follow your device's restrictions.

These installer screenshots are from an older version and may show a different interface language:

![SmartScreen: More info](user_manual_win/mytrans_win_01.png)

![SmartScreen: Run anyway](user_manual_win/mytrans_win_02.png)

![Finish installation and run the app](user_manual_win/mytrans_win_06.png)

## Choose and Configure an Engine

Choose an engine on first launch; the app remembers it. You can switch from the live toolbar later. Selecting an engine does not automatically capture audio or start a billable cloud session.

| Engine | Configuration | Uses |
| --- | --- | --- |
| **Qwen3.8 实时通话翻译** | Model Studio API key, workspace ID, Beijing or Singapore region | Meeting audio to local captions, your speech to translated audio, separate directional terminology, and audio file translation |
| **Soniox** | Soniox API key | Live transcription and text translation with optional separate TTS |
| **OpenAI Realtime** | OpenAI API key | One-way cloud realtime captions; the current start flow disables voice playback, Soniox-style duplex mode, and separate TTS |

Open **设置 → 翻译引擎** (Settings → Translation Engine), choose an engine, enter its configuration, then click **保存并关闭** (Save & Close). Cloud engines remain selectable without a key, but configuration is validated before starting. A valid-looking key does not confirm model permissions or balance.

### Qwen: Test Captions First

1. Enter a Model Studio API key, workspace ID, and service region that belong together.
2. Set **我阅读字幕的语言** (My caption language) and initially disable **双向通话** (Duplex).
3. Set **会议播放／恢复设备** (Meeting playback / recovery device) to the headphones actually playing the other participant's audio. Save, play meeting or video audio, then click **开始** (Start).
4. Enable **双语字幕（原文＋译文）** (Bilingual Captions: Original + Translation) under **设置 → 显示设置** (Settings → Display) to show both texts.

### Qwen: Send Translated Speech to the Other Participant

1. Install a virtual audio driver compatible with your system, such as standard VB-CABLE, then click **刷新设备** (Refresh Devices). The driver is not bundled with the app.
2. Enable **双向通话**, choose a physical microphone, and set **对方听到的语言** (Language the other participant hears) to a different language.
3. Set **发给对方的译音输出** (Outgoing translated audio) to the virtual cable's **playback endpoint**, such as `CABLE Input`.
4. With automatic system-device management enabled, standard VB-CABLE (including A/B/C/D) is paired automatically; use **System Default Microphone** in the meeting app. With manual management, choose the cable's matching **recording endpoint**, such as `CABLE Output`, as the meeting microphone.
5. Use physical headphones for both meeting speakers and **会议播放／恢复设备**. Do not use the same virtual cable for meeting playback, or translated speech may be transcribed again.

The top-right **发给对方** (Send to other participant) controls independently enable original and translated speech and adjust each volume. Pause, stop, and normal exit attempt to restore recorded system input, output, and communication defaults. If an original device is disconnected, recovery reports an error and retains its record. After a forced termination, recovery can only be attempted on the next launch.

See the [Qwen duplex guide](qwen-duplex.en.md) for complete setup, manual routing, and Excel terminology imports.

## Everyday Use

- **System audio:** play a video or meeting and click **开始**. No virtual cable is needed just to display system-audio captions. Engines such as Soniox offer System Audio, Microphone, or Both; Qwen uses its separate call configuration.
- **Bilingual captions:** stacked and dual-column original/translation layouts are available; see [live bilingual captions](live-subtitles.en.md).
- **Narration:** text engines can use local Piper or cloud TTS; see the [TTS guide](tts_guide.en.md). Qwen call speech is generated directly by the translation model.
- **Audio files:** open **音频翻译** (Audio Translation) and select a local file. Automatic decoding and splitting require FFmpeg/ffprobe to be available locally, or use **导入已切分音频** (Import Split Audio). Click translations to replay audio and export subtitles; see [audio file translation](audio-file-translation.en.md).
- **History:** use **翻译记录** (Translation History) for saved sessions. Export file-translation results before changing files or quitting.

## Keyboard Shortcuts

Use these when you are not typing into an input, text area, or select control:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` | Start / Stop on the live page |
| `Ctrl+,` | Open Settings |
| `Esc` | Close Settings or the shortcut sheet |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | System Audio / Microphone / Both for other engines |
| `Ctrl+T` | Toggle separate TTS where supported |
| `?` | Show shortcut help |

## Troubleshooting

| Problem | What to check |
| --- | --- |
| App cannot launch and reports missing WebView2 | Install [Microsoft WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) as prompted, then reopen the app |
| Microphone is unavailable | Check Windows privacy permissions for the microphone and desktop apps, and confirm the device is available |
| No system-audio captions | Ensure audio is playing and the capture device matches actual meeting playback; check engine configuration, network, and the error message |
| Qwen connection fails | Check that the key, workspace, and region match, then inspect model permissions, balance, and the specific error |
| The other participant cannot hear translated speech | Check translated-speech switch and volume, virtual playback/recording pairing, and the meeting's selected microphone |
| Repeated translations or echo | Use headphones and separate meeting playback from translated-speech output; do not capture system audio from the same virtual cable |
| Wrong defaults after Stop | Check physical input/output in system sound settings, reconnect the original device, and retry recovery; see the Qwen guide |
| Long audio cannot be split | Check FFmpeg/ffprobe or manually import continuous, complete, ordered audio pieces |

## Updates

**设置 → 关于 → 检查更新** (Settings → About → Check for Updates) reads this repository's latest published Release. Open GitHub, download the new x64 installer, close the app, and run the installer. Updates are not automatically downloaded, installed, or restarted; draft releases are not treated as the latest published version.
