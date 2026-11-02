# Three-Engine Latency and Soniox Endpoint-Tuning Benchmark

[简体中文](benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.md) · **English**

> This report preserves a single test from 2026-06-02, the model behavior observed then, and the recommendations made at that time. It does not describe current models, prices or application features. See the [current project overview](../README.en.md).
>
> Date: 2026-06-02. Trigger: Tuan Vu's Facebook feedback on May 16: “On Soniox/Windows, source captions keep appearing, but translations are still delayed by 2–3 seconds. Can this be fixed, or is it the API?”
> Test audio: `hope-v2-trim-16k.pcm` (JA→VI, approximately 290 seconds, one run). Scripts: `benchmarks/benchmark-final-three-way.cjs` and `benchmarks/benchmark-soniox-endpoint-delay.cjs` (newly written at the time).
> Keys: reused the local `my-translator-mobile/.env.local`.

## Main findings

- The observed 2–3-second Soniox delay was an **API latency floor**, rather than application overhead. Adjusting `max_endpoint_delay_ms` did not resolve it.
- **Translation took only 77–88ms** after the source became final. Most latency came from **Soniox ASR finalization**, with the first translated sentence appearing at approximately 3.8–4.0 seconds.
- Why source captions kept appearing while translations waited: Soniox **streamed provisional source text**, but **returned translations only after `is_final`**, following endpoint detection. The lack of provisional translations was an API limitation at the time.
- Feasible improvements at the time: (1) use **OpenAI** for users who need translations to appear progressively; it was the only engine in this comparison to stream target-text deltas; (2) do not lower Soniox endpoint delay to improve speed, because the test found no speed benefit, only more fragmented segments.

## 1. Three-way comparison (measured 2026-06-02)

| Engine | firstProv (ms) | firstFinal (ms) | Segments | First-sentence quality |
|---|---|---|---|---|
| OpenAI `gpt-realtime-translate` | 2659 | **6869** | 42 | “Này, mọi người, xin chào lại nhé.” (most natural) |
| Qwen `omni-plus-realtime` | 4440 | **4668** | 72 | “Vậy thì, thưa quý vị, một lần nữa xin chào.” |
| Qwen `livetranslate-flash` | 2593 | **3780** ⚡ | 48 | “Vậy thì, mọi người, xin chào một lần nữa.” (fastest) |

This matched the old `docs/engine-matrix-vi.md` results: OpenAI was slowest at approximately 7 seconds, and Qwen Live fastest at approximately 3.8 seconds. No regression was observed.

> The three-way script **did not include Soniox** despite the potentially misleading name: it compared OpenAI with two Qwen models. Soniox was measured separately in section 2.

## 2. Soniox endpoint-delay sweep

| max_endpoint_delay_ms | firstOrigProv | firstOrigFinal | **firstTransFinal** | Source → translation | Segments |
|---|---|---|---|---|---|
| 300 | 2082 | 3861 | **3949** | 88 | 126 |
| 1000 | 1980 | 3750 | **3833** | 83 | 114 |
| 3000 (application default at the time) | 2215 | 4002 | **4079** | 77 | 103 |

**Reading the results:**

- `firstTransFinal` was approximately 3.8–4.1 seconds **at all three settings**. Endpoint delay barely changed first-sentence translation latency; the difference was under 250ms, within possible single-run variation.
- The source → translation gap was **77–88ms**. Translation was almost immediate after source finalization and was not the bottleneck.
- `firstOrigProv` was approximately 2.0 seconds: Soniox needed about 2 seconds of audio before emitting the first ASR token. `firstOrigFinal` was approximately 3.8 seconds, adding about 1.8 seconds to finalize the first segment. **This was the measured intrinsic latency of `stt-rt-v4` at the time.**
- Endpoint delay affected **segment granularity**: 300ms produced 126 segments, while 3000ms produced 103. Lower values fragmented sentences more without making them faster.

**Conclusion at the time:** lowering `max_endpoint_delay_ms` did not resolve the 2–3-second lag. Most latency came from the Soniox ASR API.

## 3. Why source captions keep updating while translations wait

Application pipeline (`src/js/soniox.js`, `_handleResponse`):

- Tokens with `translation_status: "original"`, `is_final:false` → emit `onProvisional` → **continuously render provisional source text**.
- Tokens with `translation_status: "translation"` arrived only after endpoint detection with `is_final:true` → emit `onTranslation`.
- Soniox **did not send provisional translations** at the time, so the application could not render target text progressively.

Application overhead was small: callbacks rendered synchronously without debouncing, and audio chunks contained 1024 samples (approximately 64ms). This was not the primary source of the measured lag.

## 4. Streaming mechanisms and their effect on UX

| Engine | Provisional source | **Progressive translation?** | First final |
|---|---|---|---|
| Soniox | ✅ Live | ❌ Final only, after endpoint detection | ~3.9s |
| Qwen Live Flash | ❌ No source | ❌ Whole-block assignment, no deltas | ~3.8s |
| Qwen Omni | Partial | ❌ | ~4.7s |
| OpenAI | ✅ Live | ✅ **Streaming target-text deltas** | ~6.9s, but text appears progressively from ~2.7s |

In this comparison, **only OpenAI gave the impression of real-time translation through target-text deltas**, at the cost of slower first-final output and a higher recorded price at the time ($4/hour).

## 5. Recommendations at the time, in priority order

1. **[User response] Do not tune Soniox endpoint delay for speed.** The test showed no benefit. For progressively appearing translations, OpenAI was the recommendation at the time.
2. **[P3, optional] “Input Sensitivity / Endpoint” slider.** If exposing `max_endpoint_delay_ms`, explain that it changes segment granularity, not speed. `connect(config)` already accepted `endpointDelay`; only UI wiring was needed. Reducing the default from 3000 to 1500 could produce shorter segments suitable for meeting Q&A.
3. **[Not feasible at the time] Provisional translations for Soniox.** The API did not support them, so this was excluded.
4. **[Documentation] Update `engine-matrix-vi.md`.** Add a “progressive translation” column to help users choose: OpenAI displays text progressively, while Soniox / Qwen wait for sentence completion.

## Questions unresolved at the time

1. Implement the endpoint slider from section 5.2, or simply explain the API limit? The slider would change granularity rather than reduce lag, so its value was limited.
2. Did Soniox offer a low-latency / streaming-translation mode other than `stt-rt-v4`? The latest Soniox documentation had not been checked; the original record suggested using `docs-seeker` for further investigation.
3. The data came from one run of one Japanese recording. Were repeated runs and multiple languages needed to distinguish first-final differences from measurement noise?
