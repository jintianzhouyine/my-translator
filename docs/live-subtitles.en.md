# Bilingual live captions

[中文](live-subtitles.md) · [English](live-subtitles.en.md) · [Documentation](README.en.md)

The current app interface is primarily Chinese. Chinese menu labels below identify the controls shown in the app.

In **设置 → 显示设置** (Settings → Display), enable **双语字幕（原文＋译文）** (bilingual captions: source + translation). Each live caption shows the source above its translation. Turn it off to show translations only. You can also switch it through **更多 → 双语字幕** (More → Bilingual captions) in the live view. Changes take effect immediately, are saved for the next launch, and do not pause the call or change audio output.

The side-by-side button in **更多** switches to separate source and translation columns. Turning bilingual captions off temporarily hides the source column; turning it back on restores the layout selected in the current app run. The content preference is saved across launches; the stacked/side-by-side layout is a choice for the current run.

Source text and translations may arrive at different times. Qwen pairs them using the service's sentence IDs. If a translation arrives first, the app shows **等待原文…** (Waiting for source…) and fills in the source in the same segment when it arrives. It does not translate the result back to invent a source transcript. Qwen 3.8 transcription is enabled by default and does not require a separate ASR integration. The display preference also applies to Soniox, OpenAI and local mode whenever they return source text.

Copied and saved sessions still include the source and translation received by the app. Hiding text does not delete or edit the history. [Audio-file translation](audio-file-translation.en.md) has independent display and export options.

Enable **桌面字幕** (Desktop captions) in **设置 → 显示设置** to show the latest sentence in a separate transparent, always-on-top window. The live view's **更多 → 桌面字幕** also toggles it. Drag the captions to move the window; hover to reveal its close button. Closing the caption window switches the preference off.

Choose source only, translation only, or both, and your speech, the other person's speech, or both speakers. Desktop captions are off by default and initially select your speech with source and translation. These preferences are saved immediately and apply without restarting recognition or changing audio output. They are independent of the main window's bilingual preference. Missing text waits for the matching sentence rather than showing text from a previous sentence.

Qwen duplex mode identifies each side from its separate audio stream. Its captions-only mode captures only the other person. Other live engines treat microphone input as you and system audio as the other person; when capturing both inputs together, select both speakers because the mixed stream cannot reliably identify the audio source. Desktop captions reuse existing recognition results and do not start an additional capture or translation session. Clearing the main transcript clears desktop captions; Pause and Stop retain the latest sentence for reading.

Live translation reconnects automatically after temporary network failures or a server closing the session, with up to three retries for consecutive failures. Qwen restores only the affected direction while the other direction keeps working. OpenAI reconnects without restarting audio capture. If a Soniox session rotation fails while its original connection remains usable, the app keeps that connection.

Pause and Stop cancel pending reconnections. Account or configuration errors, exhausted retries, and audio device failures show an error and leave the running state. Existing captions and session records are retained. After reconnection, translation resumes with new audio; audio during the interruption is not replayed. Silence alone does not trigger a caption timeout.

Automated checks cover stacked/side-by-side display, restoring the previous preference after a failed settings save, uninterrupted changes during a call, and delayed or out-of-order Qwen source text. Recognition quality still needs verification using your API account and meeting audio.

Qwen references: [client events and default ASR](https://help.aliyun.com/zh/model-studio/live-translator-client-events), [server transcription and translation events](https://help.aliyun.com/zh/model-studio/live-translator-server-events).
