# Text-to-speech (TTS) guide

[中文](tts_guide.md) · [English](tts_guide.en.md) · [Legacy Vietnamese](tts_guide_vi.md) · [Documentation](README.en.md)

TTS turns translations or text from the **文本朗读** (Text-to-Speech) page into speech. Recognition, translation and speech synthesis are separate steps: local TTS does not make the entire translation pipeline offline. Qwen duplex calls use speech generated directly by the model; see [Qwen configuration](qwen-duplex.en.md).

The current app interface is primarily Chinese. Chinese menu labels below identify the controls shown in the app.

## Available providers

There are seven providers in the current settings:

| Provider | Processing and credentials | Speed setting |
| --- | --- | --- |
| Edge TTS (default) | Online; no user-supplied API key | -50% to +100% |
| Microsoft v2 | Online; no user-supplied API key | -50% to +100% |
| Google TTS — Free | Online; a user API key or a build-time key is required; unavailable without either | 0.5–2.0×, adjusted during playback |
| TikTok TTS | Online; requires a TikTok `sessionid` | 0.5–2.0×, adjusted during playback |
| Local offline TTS (Piper) | Local CPU; download a voice once, then no API is needed | 0.5–3.0× |
| Google Chirp 3 HD | Online; a Google Cloud API key with Cloud Text-to-Speech API enabled | 0.5–2.0× |
| ElevenLabs | Online; requires an ElevenLabs API key | No separate speed control currently |

“Free” is the provider category shown in the app, not a guarantee of permanent availability or unlimited calls. Online providers receive the text to synthesize. Check your provider account for current prices, quotas, languages and availability. Prices, latency figures and synthesis speeds in older documentation are not current performance guarantees from this project.

## Local offline TTS

The local implementation runs Piper (VITS) models through sherpa-onnx, including local phonemization. Synthesis does not upload text, need an API key or require a dedicated GPU. Downloading a voice initially needs internet access. Actual latency and memory use depend on the CPU, model, text length and concurrent workloads.

1. Open **设置 → 语音朗读** (Settings → TTS) and choose **本地离线朗读** (Local offline).
2. Filter voices by language. The built-in catalog currently offers Vietnamese and English models, not Chinese models. Selecting local TTS does not mean every translation target language is supported.
3. Click the download button beside a voice. On the first download, choose the default application location or a custom folder.
4. Select the installed voice, save settings, then enable translation narration or play text from the **文本朗读** (Text-to-Speech) page.

Voice management:

- Downloads show progress and are verified with SHA-256. Models are typically tens of MiB; see the list for sizes.
- Deleting a voice removes its files from disk and frees space.
- The folder button changes the model location. Existing models are not moved automatically, and voices in the old folder are not listed in the new location.
- Installed voices work entirely offline. The catalog includes Vietnamese VAIS1000, 25 hours and custom Vietnamese voices, plus English Ryan and Lessac. The current list and download availability in the app are authoritative.

## Edge TTS and Microsoft v2

Both use online Microsoft speech paths and cannot be used as offline features when disconnected. Select the provider, voice and speed, then save; no user-supplied API key is required. Microsoft v2 can filter Vietnamese or English voices. Edge presets include Chinese, English, Vietnamese, Japanese and Korean voices such as Xiaoxiao, Jenny, HoaiMy, Nanami and SunHi.

Their access methods and availability can change. If connections fail, check your network, then try another provider or an installed local voice.

## Google TTS — Free and TikTok TTS

**Google TTS — Free** is an experimental integration, separate from Google Chirp 3 HD. You can supply a Google API key in settings. With no user key, it only attempts the key configured at build time. Without either, the provider is unavailable; there is no hardcoded fallback key. Speed is adjusted during playback.

**TikTok TTS** requires a `sessionid` in settings, followed by a voice and speed selection. It also needs internet access and valid session credentials. The available voices are listed in settings.

## Google Cloud TTS — Chirp 3 HD

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com).
2. Enable the [Cloud Text-to-Speech API](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com) for that project and configure billing and permissions as required for your account.
3. Create an API key on the [Credentials page](https://console.cloud.google.com/apis/credentials) and restrict its API access to Cloud Text-to-Speech API.
4. In **设置 → 语音朗读** (Settings → TTS), select **Google Chirp 3 HD**, paste the key, choose a voice and speed, then click **保存并关闭** (Save & close).

The app includes preset voices for Vietnamese, English, Japanese, Korean and Chinese. Check your Google Cloud project for current quotas and prices; this guide does not promise a fixed free allowance.

## ElevenLabs

1. Sign in or register at [ElevenLabs](https://elevenlabs.io), and confirm that your account has the required API access and quota.
2. Create a key in the account's API Keys page.
3. Choose **ElevenLabs** under **设置 → 语音朗读** (Settings → TTS), enter the key, select a voice and save.

The current integration selects voices. It does not include an in-app workflow for creating or training cloned voices, or a separate speed control. Billing and voice permissions depend on your ElevenLabs account.

## Using TTS

- **Live translation narration:** click the TTS/narration button in the live view or press `⌘ T` (the corresponding Ctrl shortcut on Windows). It is off at each launch; enable it when needed. New translations are read aloud when enabled.
- **Supported engines:** one-way Soniox and local MLX translation can use separate TTS. Traditional two-way translation disables the button to avoid recapturing speech repeatedly.
- **Qwen and OpenAI Realtime:** the separate TTS button does not apply. Qwen generates outgoing speech natively, controlled by **译音** (Translation audio) at the top right. Selecting Piper does not switch Qwen's output to local synthesis.
- **Reading text:** open **文本朗读** (Text-to-Speech), type or paste text, then play, pause or stop using the selected provider. Long text is synthesized in parts; failed parts show errors. This playback path is separate from live capture.
- **Changing providers:** choose and save a provider under **设置 → 语音朗读**. Before using local TTS, confirm that the selected voice is installed.

## Troubleshooting

- **No audio:** check the narration switch, system volume and playback device. Verify the provider credentials or installed local model.
- **Local voices missing:** check the model folder and language filter. Changing the folder does not move existing models.
- **Google errors:** check the API key, enabled API, project permissions and billing. Distinguish the Google experimental option from Cloud Chirp 3 HD.
- **Edge/Microsoft/TikTok connection failures:** check the network and provider availability. TikTok also needs a valid `sessionid`.
- **Narration gets transcribed again:** use headphones and check capture devices. Lower the volume or pause capture. The Windows system-audio capture path may include the app's own playback.

Try voices, cloud integrations and real audio devices on your own computer. This guide describes implemented configuration and workflows; it does not establish end-to-end verification with every provider account.
