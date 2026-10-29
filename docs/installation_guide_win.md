# Installation Guide — Windows

Step-by-step guide to install and use **My Translator** on Windows 10/11.

---

## Requirements

- Windows 10 or later, 64-bit Intel/AMD (x64)
- **Soniox mode** (recommended): [Soniox](https://soniox.com) API key (pay-per-use, ~$0.12/hour)
- **OpenAI Realtime mode** (premium): [OpenAI](https://platform.openai.com) API key (~$4/hour — much pricier, but returns native translated voice — no separate TTS needed)
- **TTS narration** (optional, text engines only): Edge TTS (free, no API key) or premium providers. See [TTS Guide](tts_guide.md)

---

## Step 1 — Download

Download the latest `.exe` installer from: [**Releases — Windows**](https://github.com/jintianzhouyine/my-translator/releases/latest)

Starting with v0.10.1, download `MyTranslator_<version>_x64-setup.exe` for 64-bit Intel/AMD PCs.
This is an x64 application, not a 32-bit x86 build. Older Windows ARM64 installers remain available in
[v0.10.0](https://github.com/jintianzhouyine/my-translator/releases/tag/v0.10.0).

---

## Step 2 — Bypass SmartScreen

> ⚠️ The app is not yet signed with a certificate. Windows SmartScreen will block it on first run.

When you see the **"Windows protected your PC"** screen:

1. Click **"More info"**

![SmartScreen warning — click More info](user_manual_win/mytrans_win_01.png)

2. Click **"Run anyway"**

![Click Run anyway](user_manual_win/mytrans_win_02.png)

---

## Step 3 — Install

The setup wizard will guide you:

1. Click **Next** to start

![Welcome to My Translator Setup](user_manual_win/mytrans_win_03.png)

2. Choose install location (default is fine) → click **Next**

![Choose Install Location](user_manual_win/mytrans_win_04.png)

3. Wait for installation to complete → click **Next**

![Installation Complete](user_manual_win/mytrans_win_05.png)

4. Check **"Run My Translator"** → click **Finish**

![Completing Setup — Run My Translator](user_manual_win/mytrans_win_06.png)

---

## Step 4 — Configure API Key & Languages

The app opens. Click ⚙️ to open **Settings**.

Configure:

1. **API KEYS** — Paste at least one of:
   - **Soniox API key** — recommended default (~$0.12/hr)
   - **OpenAI API key** — premium engine with native translated voice (~$4/hr — see warning below)
   - A green dot ✓ next to each field means the key format looks valid; click **Test** to ping the provider live. Engines without a valid key are greyed out in the engine dropdown.
2. **Translation Engine** — choose between:
   - ☁️ **Soniox** (cloud, ~$0.12/hr, ~2 s latency, supports two-way mode)
   - ⚡ **OpenAI Realtime** (cloud, ~$4/hr, ~1.5 s latency, **native voice included** — two-way and custom TTS unavailable)
3. **Source** — Choose the source language (or leave as Auto-detect)
4. **Target** — Choose the target language (e.g., Vietnamese, English...)
5. **Audio Source** — Choose System Audio (computer sound) or Microphone

![Settings — API Key and Languages](user_manual/mytrans_setting_1.png)

Scroll down for more options:

- **Font Size** — Adjust text size
- **Max Lines** — How many lines to show
- **Show original text** — Display source text alongside translation
- **Custom Context** — Add domain/terms for better accuracy

![Settings — TTS Narration section](user_manual/mytrans_setting_2.png)

Click **Save & Close** when done.

> 💡 **Where to get a Soniox API key?**
> 1. Go to [console.soniox.com](https://console.soniox.com) → create an account
> 2. Add funds ($10 minimum, lasts a long time at ~$0.12/hour)
> 3. Go to **API Keys** → create and copy your key

![Soniox Console — Billing overview](user_manual/mytrans_key_1.png)

> 💡 **Where to get an OpenAI API key?**
> 1. Go to [platform.openai.com](https://platform.openai.com) → create an account
> 2. **Settings → Billing** → add a payment method and credits ($10 ≈ ~2.5 hours)
> 3. **API keys** → **Create new secret key** → copy the key (`sk-...`)
>
> ⚠️ **Cost warning**: OpenAI Realtime is ~34× pricier than Soniox at provider list rates. Use it for high-stakes meetings; for everyday use, Soniox is the better default. See the [**OpenAI vs Soniox benchmark**](benchmark_openai_vs_soniox.md) for details.

Once a valid OpenAI key is saved, the **OpenAI Realtime** engine becomes selectable in the dropdown:

![Settings — OpenAI Realtime engine with API key](user_manual/setting_openai.png)

---

## Step 5 — Enable TTS Narration (Optional)

Want translations **read aloud**? Enable TTS narration:

1. In Settings, scroll to **TTS Narration** section
2. Check **"Enable narration (read translations aloud)"**

![Settings — TTS disabled](user_manual/mytrans_setting_2.png)

3. Enter your **ElevenLabs API key**
4. Choose a **voice** (2 female, 2 male — all support Vietnamese)
5. Click **Save & Close**

![Settings — TTS enabled with API key and voice](user_manual/mytrans_setting_3.png)

> 💡 **Where to get an ElevenLabs API key?**
> 1. Go to [elevenlabs.io](https://elevenlabs.io) → create an account
> 2. Subscribe to the **Starter plan** ($5/month, ~60 min of TTS)
> 3. Go to **Developers → API Keys** → create a key with "Text to Speech" access

![ElevenLabs — Subscription plan](user_manual/mytrans_key_2.png)
![ElevenLabs — Create API key](user_manual/mytrans_key_3.png)

> 💡 TTS is optional. If disabled, the app works exactly like before — transcript & translate only.

---

## Step 6 — Start Translating!

Click ▶ to start. The app will show **Listening...**

Now play any audio on your PC (YouTube, Zoom, podcasts...) and translations appear in real-time!

If TTS is enabled, you can toggle it on/off with the **TTS** button or `Ctrl+T`.

![App translating with TTS enabled](user_manual/mytrans_tts_1.png)

### Choosing the translation mode

If you have both a Soniox and an OpenAI key configured, the first time you start a session the app asks which engine to use:

![Choose translation mode — Standard vs OpenAI Realtime](user_manual/openao_entry.png)

You can switch any time from the engine pill in the toolbar.

### Dual-panel view with OpenAI Realtime

In **Dual** view the source transcript appears on the left and the translated text on the right — OpenAI's whisper transcription and translated output stream side-by-side:

![Dual-panel translation running with OpenAI Realtime](user_manual/openai_translate.png)

---

## Tips

- **System Audio** captures whatever is playing on your PC — no virtual cable needed
- **Microphone** captures live speech from your mic
- **TTS** reads translations aloud — toggle with the TTS button or `Ctrl+T`
- The app works as an **overlay** — drag it anywhere, resize as needed
- Translations are **saved automatically** — click 📋 to view the transcript file

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Start / Stop |
| `Ctrl+,` | Open Settings |
| `Esc` | Close Settings |
| `Ctrl+T` | Toggle TTS narration |

---

## Troubleshooting

### SmartScreen blocks the installer
→ Click **"More info"** → **"Run anyway"** (see Step 2).

### No translation text appears
→ Check that the API key for your selected engine is correct in Settings (⚙️). Click **Test** to verify connection.

### OpenAI Realtime: engine option is greyed out
→ The OpenAI key field is empty or the key format is invalid (must start with `sk-`). Paste a fresh key, then click **Test**.

### OpenAI Realtime: "Two-way" toggle is hidden
→ This is expected. Two-way mode is only available on Soniox. Switch engines if you need it.

### Translation cost is much higher than expected
→ Confirm which engine you selected. OpenAI Realtime is ~$4/hour vs Soniox's ~$0.12/hour.

### No system audio captured
→ Make sure audio is playing on your PC. Some apps use exclusive audio mode — try a different source.

### App doesn't start
→ Make sure WebView2 Runtime is installed. It comes with Windows 10/11, but on older versions you may need to install it from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

---

## Updating

My Translator includes **auto-update**. When a new version is available:

1. A **green badge** appears on the ⚙️ settings icon
2. Open Settings → **About** tab → click **Download & Install**
3. The app will restart automatically with the new version

No need to download installers manually for future updates!
