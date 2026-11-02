# Audio-file translation and caption playback

[中文](audio-file-translation.md) · [English](audio-file-translation.en.md) · [Documentation](README.en.md)

Open **音频翻译** (Audio translation) at the top, choose a local file and target language, then click **开始翻译** (Start translation). This uses the Bailian API key, workspace and region saved under **设置 → 翻译引擎 → Qwen** (Settings → Translation engine → Qwen). It does not require a microphone, screen-capture permission or a virtual audio device. The current app interface is primarily Chinese; the Chinese labels identify the controls in the app.

File selection and splitting happen locally. Audio is sent to Bailian, with model usage charges, only after you start translation. The model is `qwen3.8-livetranslate-flash-realtime`: each request uses a separate text-translation session and sends audio in approximately 100ms packets.

## Acceleration, retries and skipping

- The default **加速：2 段并行** (Accelerated: 2 concurrent parts) processes at most two requests at a time. It further divides the selected recording within its existing split boundaries into requests of up to two minutes. A single part longer than 30 seconds is split into at least two requests. Manually imported, pre-split files retain their file boundaries. You can choose **顺序：1 段处理** (Sequential: 1 part) to preserve the original segmentation.
- Each stream retains its input sample rate and sends audio at about real-time speed. Running two requests concurrently can shorten the total wait, but short recordings, provider queues, networks and rate limits affect the actual gain; twice the speed is not guaranteed. Pacing includes time spent reading PCM so it does not accumulate an extra delay for each packet.
- Intermediate translations appear immediately under **正在生成** (Generating). Finalized text enters the caption list; provisional text is not exported.
- By default, network interruptions, timeouts, service failures and rate limits retry up to twice, after 2 and 5 seconds. You can select one retry or disable automatic retries. All parts and retries share a local minimum connection interval of 7.5 seconds and a limit of 8 new connections per minute. Hitting these limits adds a wait to avoid repeatedly triggering provider rate limits.
- Invalid keys, permissions, balance or configuration errors do not retry automatically and stop submission of subsequent requests. After correcting settings, retry unfinished parts. A local decoding failure only marks the affected part; no paid translation session is opened for that part.
- Once automatic retries are exhausted, the affected request's part shows **失败** (Failed), while other parts continue. Use **重试此片段** (Retry this part) or **跳过失败片段** (Skip failed part). **Skipping is available only for failed parts, not normally running requests.** A skipped part can still be retried manually.
- Completed translations are retained. Retrying resends only the selected part and replaces that part's previous partial results on success, avoiding duplicate captions. Retrying repeats model usage for that audio and may incur another charge.
- After cancelling the job, **重试未完成片段** (Retry unfinished parts) resumes unfinished work in the current window without processing completed or deliberately skipped parts again. Retries keep the previous target language and dictionary direction. A retry started while idle reads newly saved credentials and dictionary contents. **重新翻译** (Translate again) restarts from the beginning. The recovery queue is not preserved after exiting the app.

## Files and dictionaries

- Supported selections are WAV, MP3, M4A, AAC, FLAC and OGG. The desktop app uses locally installed FFmpeg/ffprobe to inspect duration and decode parts. An original source file can be up to 16 GiB and 24 hours long.
- The initial split plan uses 20-minute parts; you can choose 5, 10, 20 or 30 minutes. Accelerated mode further divides requests when translation begins. Files exceeding the older 100 MiB / 30-minute limit no longer need to be compressed as a whole first.
- Audio is decoded locally to 16kHz mono PCM16. Native decoding prepares one part at a time and retains at most two active part caches, releasing them after completion. The whole recording is not decoded into memory, and recognition does not require playing it aloud.
- FFmpeg and ffprobe must be on the local PATH, in common Homebrew locations, or beside the application executable. Current installers do not include them. If they are missing, the page offers manual import of pre-split files.
- No dictionary is applied by default. You can explicitly choose the saved **我的话 → 对方** (My speech → Other participant) or **对方 → 字幕** (Other participant → Captions) dictionary. Check that its translations suit the target language. See [terminology configuration](qwen-duplex.en.md).
- You can cancel during translation. Completed text is retained for partial export or retrying only the unfinished parts.

## Automatic splitting failures and manual splitting

After selecting a file, the app shows the planned time ranges. If a part fails to decode, choose a shorter automatic duration and click **重新分段** (Split again), or enter manual split points.

Manual points accept seconds, `minutes:seconds` or `hours:minutes:seconds`, including decimals, one per line or comma-separated. For example, entering `15:00, 30:00` for a 45-minute file creates three parts. Zero and the end of the file are added automatically. Points cannot repeat or fall outside the recording, and each part must be at most 30 minutes. Click **应用分割点** (Apply split points) before starting translation. You can preview boundaries by clicking parts in the list.

If decoding tools are missing, duration cannot be read, or changing points does not fix decoding, choose **导入已切分音频** (Import pre-split audio) and select one or more files you have split yourself. Each must be at most 100 MiB and 30 minutes and be decodable by the system as mono or stereo. This path does not need FFmpeg. Files are naturally sorted by numbers in their names, so `part-2` comes before `part-10`; check the order before starting.

Imported files should be consecutive, non-overlapping parts of the original recording with no omissions. The app constructs the caption timeline by adding their durations. If you removed pauses or omitted parts when splitting, the merged captions will no longer align with the unedited recording. You can import up to 500 parts with a combined duration of 24 hours.

## Timing and playback

Each translated segment shows start and end times relative to the original recording. Timing comes from Qwen's `speech_started.audio_start_ms` and `speech_stopped.audio_end_ms`, is paired to translations by source-item ID, and is offset by the part's position in the original recording. It does not use network arrival times. Source-item IDs are isolated between requests. Multiple translation items for the same source segment are combined into one caption.

Click a translation to play its corresponding source-audio range and pause at that segment's end. For multiple manually imported files, playback switches to the appropriate file and position. You can also play the current file continuously, seek or adjust playback speed; the currently playing segment is highlighted. Live audio capture stops before playback to avoid recognizing the source again.

Timing is at speech-segment level rather than word-level forced alignment, so recognition and segmentation can contain model errors. If complete timestamps are missing, the segment shows **时间未对齐** (Timing unavailable). The app does not guess seek times. SRT/VTT export waits for complete timing; TXT remains available.

## Export

Choose **译文** (Translation), **原文** (Source) or **原文与译文** (Source + translation), then SRT, VTT or TXT. Select the destination in the system save dialog.

- SRT/VTT use the original audio timeline and can be played alongside that file.
- TXT includes text without subtitle timing.
- The suggested filename marks cancelled or failed jobs as **部分结果** (Partial results).
- Skipped parts leave a time gap; later captions do not shift earlier. Finalized partial text received before a failure can still be exported.
- Files and results remain in the current app window. Export before selecting another file or exiting. Part-audio caches are cleaned up after processing, cancellation or closure. The app does not automatically upload the entire original recording to public storage.

## Verification

Automated checks cover split planning, per-part decoding and cache release, global timing offsets, item-ID isolation across parts, pacing, cancellation, partial results after failure, late source text and timestamps, strict completion checks, exports, click-to-play and stopping at segment boundaries. Native playback reads ranges only from the selected file and does not accept arbitrary paths. Export writes a complete temporary file before replacing its destination, preserving an existing file if writing fails.

Splitting was checked with a 31-minute, 178,560,044-byte WAV, including seeking into late parts, fractional-millisecond boundaries and cancellation. Real per-part decoding of MP3, M4A, AAC, FLAC and OGG passed. Acceleration/recovery tests cover the two-request limit, single-part preparation and cache release, automatic backoff, skipping failed requests only, isolation of late events, replacing partial results after retries, and resuming after cancellation.

On **2026-10-28**, 209 JavaScript and 27 real native Rust tests passed. In a real browser, the actual UI and controller were tested with a local mock service: two parts succeeded, a third failed after retrying, then was skipped and retried individually to success. The other two parts stayed on their first request and captions were not duplicated. This did not call Bailian. An Apple Silicon development build was placed at `dist/audio-recovery/MyTranslator Dev.app`.

Provider timestamps and translation quality still need acceptance checks with a real Bailian account and recordings. A successful local build or unit-test run does not establish that cloud translation has been verified.

Protocol references: [server events](https://help.aliyun.com/zh/model-studio/live-translator-server-events), [client events](https://help.aliyun.com/zh/model-studio/live-translator-client-events), [rate limits](https://help.aliyun.com/zh/model-studio/rate-limit).
