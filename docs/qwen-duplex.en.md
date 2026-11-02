# Qwen duplex call translation

[中文](qwen-duplex.md) · [English](qwen-duplex.en.md) · [Documentation](README.en.md)

Only your computer needs to run My Translator. The other participant keeps using their existing meeting app.

- Your microphone → Qwen translation and speech generation → virtual audio output → the meeting app's microphone.
- The other participant's meeting audio → a separate Qwen session → source and translated captions on your computer.

This mode uses the cloud model `qwen3.8-livetranslate-flash-realtime` and requires internet access and a Bailian API key. Each direction has its own session and metered usage. The app's language lists include 60 text targets and 29 speech targets, including Chinese and English. Qwen generates the outgoing speech directly; a separate TTS provider or Piper model is not required.

The current app interface is primarily Chinese. Chinese menu labels below identify the controls shown in the app.

## Configuration

1. Open **设置 → 翻译引擎** (Settings → Translation engine) and select **Qwen3.8 实时通话翻译** (Qwen3.8 live call translation).
2. Enter your Bailian API key, workspace ID and service region. The key and workspace must belong to the selected region. Beijing and Singapore are supported.
3. Choose **我阅读字幕的语言** (the language of captions you read) and **对方听到的语言** (the language the other participant hears). Duplex calls require different target languages for the two directions. Qwen detects the input language automatically.
4. Select your physical microphone. Set **发给对方的译音输出** (outgoing translated audio) to an installed virtual audio device.
5. Keep **通话时设为系统默认麦克风，结束后恢复音频设备** (use as the system default microphone during the call and restore audio devices afterward) enabled. The meeting app can then use the system default microphone. Set its speaker to your headphones, and select the same headphones under **会议播放／恢复设备** (meeting playback/recovery device). On macOS this selection is used only for restoring defaults.
6. Save and start translation. If you only need incoming captions, disable **双向通话** (duplex call). This does not capture your microphone, generate outgoing speech or require a virtual audio device.

You must select the output device explicitly. If it is missing, the app does not fall back to speakers. Click **刷新设备** (Refresh devices) after installing a device. The app does not install audio drivers or change device selections inside your meeting app.

## Routing on macOS and Windows

On macOS, you can use an installed virtual audio device such as BlackHole. My Translator writes translated speech to it, and the meeting app reads its microphone input. ScreenCaptureKit captures system audio while excluding the app's own playback. Grant system-audio capture and microphone permissions on first use.

On Windows, use a virtual audio cable whose driver supports your system architecture. Select its playback endpoint as the translator's outgoing device and its corresponding recording endpoint as the meeting microphone; their names may differ. The system-audio capture device should be the headphones on which the meeting app plays incoming audio. Keep it separate from the translated-audio output to avoid recognizing the translated audio again. If using a Windows ARM machine, confirm that the driver itself supports ARM64; current installers from this fork target Windows x64.

Use headphones on either platform. Excluding the app's playback does not stop a physical microphone from picking up sound from speakers.

## System defaults and recovery

Automatic management is enabled by default. Before a duplex call starts, the app records the default input/output devices, fixes microphone capture to the physical device, then switches the system default microphone to the virtual input. On Windows it also handles default communications devices. An existing physical headphone/speaker default output stays unchanged. Apps that follow the system default microphone can receive the audio. Apps fixed to another microphone still require adjustment; some may need to be reopened.

- Automatic pairing supports BlackHole on macOS and standard VB-CABLE names on Windows, including A/B/C/D. For other or renamed virtual devices, turn this setting off and configure routing manually.
- Pause, stop, failed startup and normal exit restore the recorded microphone and playback devices without waiting for cloud captions to finish. A forcibly terminated process cannot guarantee immediate restoration; the next launch attempts recovery from the local record.
- If you already changed the defaults to virtual devices before starting, the app cannot know their earlier values. Explicitly select physical devices under **我的麦克风** (My microphone) and **会议播放／恢复设备** so it can restore those choices.
- If an original device disconnects, the app reports a recovery failure and retains the record. Reconnect that device, or manually select an available physical device in system sound settings, then retry. The app does not choose an arbitrary replacement.
- With automatic management disabled, you manage system defaults yourself. Caption-only mode does not switch system devices.

## Original and translated audio

The **发给对方** (Audio sent to the other participant) area at the top right of the live view has independent switches and 0–100% volume sliders:

- **原声** (Original): mixes your physical microphone directly into the virtual output. Off by default.
- **译音** (Translation): mixes Qwen's translated speech into that output. On by default.

You can enable both, either one or neither. Changes apply immediately and are saved without restarting translation. Muting the original does not disable recognition. Muting translation does not stop captions, cloud sessions or billing. Muting clears queued audio for that stream; enabling it again does not replay audio from the muted interval.

Original speech is sent immediately, while translation arrives later, so they can overlap when both are enabled. The native mixer resamples each stream, adds them and limits clipping. The original-audio buffer is limited to 120ms and the translation buffer to 5 seconds. These buffer limits do not describe end-to-end translation latency. Automatic ducking of the original audio is not implemented.

The app remembers the selected engine. Users with existing configuration enter the live view directly; new users see onboarding until they choose an engine. Engines can be changed later from the toolbar. Remembering an engine does not automatically start capture or a paid session.

## Terminology dictionaries

The two directions have separate dictionaries and are not reversed automatically. Enter one mapping per line, separated by the first ASCII equals sign. Additional equals signs in the translation are preserved.

Example for outgoing speech:

```text
灰度发布 = canary release
产品名 = ProductName
```

Example for incoming captions:

```text
canary release = 灰度发布
ProductName = 产品名
```

Each direction accepts up to 1,000 terms. Duplicate source terms, empty source terms or empty translations block saving. Terms are sent through `session.translation.corpus.phrases` to improve terminology accuracy; they are not a guaranteed hard replacement rule. Saving settings during translation pauses the session. Start it again to apply the new configuration.

### Import from Excel

1. Click **导入词表** (Import terminology) beside the dictionary for the relevant direction and select an `.xlsx` file. You can adapt the [example workbook](examples/qwen-terms.xlsx).
2. Select a worksheet. The first two columns are source and target terms. An optional first row can use `原词, 译法` or `source, target` headers. Additional columns may contain notes and are ignored.
3. Review the preview. The default merges with the existing dictionary and keeps existing translations when a source term conflicts. You can overwrite conflicts or replace the entire dictionary for that direction. Identical duplicates are removed. If a source has different translations within the file, correct the file first.
4. To use the same workbook for the reverse direction, select **交换两列** (Swap columns). Only the currently selected direction changes.
5. Click **确认导入** (Confirm import), then **保存并关闭** (Save & close). Saving during translation pauses it; restart to use the new dictionary.

Files are read locally and the dictionary is unchanged until confirmation. Limits are 2 MiB per file, 1,000 terms per direction after merging, and 10,002 rows per worksheet including blank rows. The first two Excel columns must contain text or ordinary displayable values. Copy formulas and paste them as values first. Save legacy `.xls` workbooks as `.xlsx`. The preview shows only the first 20 terms; confirmation imports all valid terms.

UTF-8 and BOM-marked UTF-16 text dictionaries are also supported: two-column CSV/TSV, TXT with `source = translation` per line, and JSON as `{ "source": "translation" }` or `[{ "source": "term", "target": "translation" }]`.

## Verification scope

Automated tests cover dictionary validation, settings compatibility, session state and audio-routing logic. Account access, network latency, system permissions, virtual drivers and end-to-end meeting calls still require checks with real accounts and devices on the target computer. A successful build does not establish that real calls have been verified.

Local verification on Apple Silicon macOS, **2026-10-28**:

- All 97 JavaScript tests passed, covering protocol events, duplex session lifecycle, caption saving, settings compatibility, engine switching, the home screen after restart, real Excel parsing, import previews, conflicts and cancellation.
- `cargo test --lib --locked --offline` ran all 12 Rust tests successfully. `DOCS_RS` was not set: ScreenCaptureKit and sherpa-onnx completed real native compilation and linking.
- An arm64 `MyTranslator Dev.app` build passed ad-hoc signature verification and was placed under the project's `dist/` directory. Its Chinese UI, Qwen settings and real device enumeration were inspected.
- The local Command Line Tools failed because of obsolete `PackageDescription` private interfaces and duplicate `SwiftBridging` module declarations. Temporary SwiftPM interface copies and compiler file mappings under `/tmp/my-translator-rust/` worked around this without changing the system installation or disabling native features. Clearing caches alone did not fix it. Rebuilding after removing those temporary files requires recreating them or repairing the matching Command Line Tools; the packaged app does not depend on them to run.
- Windows ARM builds and real Bailian/virtual-driver/meeting-app calls were not verified. The release workflow includes Rust tests for its target platforms, to be run in available build environments.

For first use, verify incoming captions in caption-only mode, then configure a virtual device and test outgoing audio. Confirm that only your voice triggers outgoing translation, incoming speech produces local captions, and stopping does not send old queued audio.

Audio controls and recovery verification on **2026-11-01**: 282 JavaScript tests and 48 full macOS Rust unit tests passed. The Windows system-device module passed an x64 GNU compile check. A browser at 900×500 was used to check both audio switches, volume sliders and the settings entry. These checks did not change system defaults, record audio or call the cloud service. Real BlackHole/VB-CABLE switching, recovery and mixing with meeting apps remain to be verified on hardware.

## Provider references

- [Qwen real-time translation guide, language lists and terminology configuration](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)
- [Qwen3.8 model, regions and billing](https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime)
- [Real-time translation client events](https://help.aliyun.com/zh/model-studio/live-translator-client-events)

Live captions can show source + translation or translation only using **设置 → 显示设置** (Settings → Display) or **更多** (More). See [bilingual live captions](live-subtitles.en.md).
