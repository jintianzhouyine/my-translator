# 三引擎延迟与 Soniox 端点调参基准报告

**简体中文** · [English](benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.en.md)

> 本报告保留 2026-06-02 的单次测试、当时模型行为与建议，不代表当前模型、价格或应用功能。当前项目说明见 [README](../README.md)。
>
> 日期：2026-06-02。起因：Tuan Vu 于 5 月 16 日在 Facebook 反馈：“Soniox／Windows 中原文字幕持续显示，但译文仍延迟 2–3 秒。能修复吗，还是 API 的原因？”
> 测试音频：`hope-v2-trim-16k.pcm`（日语 → 越南语，约 290 秒，单次运行）。脚本：`benchmarks/benchmark-final-three-way.cjs`、`benchmarks/benchmark-soniox-endpoint-delay.cjs`（当时新写）。
> 密钥来源：复用本机 `my-translator-mobile/.env.local`。

## 主要结果

- 当时测到的 Soniox 2–3 秒延迟来自 **API 自身的延迟下限**，而非应用额外开销，调整 `max_endpoint_delay_ms` 无法解决。
- 源文最终确认后，**翻译只需 77–88ms**。主要延迟位于 **Soniox ASR 最终确认**，首句译文约在 3.8–4.0 秒出现。
- “为什么原文持续出现，翻译却要等”：Soniox **流式返回原文临时结果**，但**只有 `is_final` 后才返回译文**，即端点确认之后。当时没有译文临时流，这是 API 限制。
- 当时可行的改进：（1）需要逐步显示译文的用户可使用 **OpenAI**，它是该次比较中唯一流式输出目标文本增量的引擎；（2）Soniox 不宜为了提速而降低端点延迟，因为测量中没有提速，只使片段更碎。

## 1. 三路对比（2026-06-02 测量）

| 引擎 | firstProv（ms） | firstFinal（ms） | 片段数 | 首句质量 |
|---|---|---|---|---|
| OpenAI `gpt-realtime-translate` | 2659 | **6869** | 42 | “Này, mọi người, xin chào lại nhé.”（最自然） |
| Qwen `omni-plus-realtime` | 4440 | **4668** | 72 | “Vậy thì, thưa quý vị, một lần nữa xin chào.” |
| Qwen `livetranslate-flash` | 2593 | **3780** ⚡ | 48 | “Vậy thì, mọi người, xin chào một lần nữa.”（最快） |

结果与当时旧 `docs/engine-matrix-vi.md` 中的结论一致：OpenAI 最慢，约 7 秒；Qwen Live 最快，约 3.8 秒，没有发现回归。

> 注意：名为 three-way 的脚本**不含 Soniox**，实际是 OpenAI 加两个 Qwen 模型。Soniox 在第 2 节单独测量。

## 2. Soniox 端点延迟遍历

| max_endpoint_delay_ms | firstOrigProv | firstOrigFinal | **firstTransFinal** | 原文 → 译文 | 片段数 |
|---|---|---|---|---|---|
| 300 | 2082 | 3861 | **3949** | 88 | 126 |
| 1000 | 1980 | 3750 | **3833** | 83 | 114 |
| 3000（当时应用默认值） | 2215 | 4002 | **4079** | 77 | 103 |

**数据解释：**

- **三个设置**的 `firstTransFinal` 均约为 3.8–4.1 秒。端点延迟几乎不改变首句译文延迟，差异小于 250ms，处于单次测量可能的波动范围内。
- 原文 → 译文间隔为 **77–88ms**，源文最终确认后几乎立即获得译文，翻译不是瓶颈。
- `firstOrigProv` 约 2.0 秒，表示 Soniox 约需“听”2 秒才发出首个 ASR token；`firstOrigFinal` 约 3.8 秒，再用约 1.8 秒确认首个片段。**这是当时 `stt-rt-v4` 模型测得的固有延迟。**
- 端点延迟的实际影响是**分段粒度**：300ms 产生 126 段，3000ms 产生 103 段。更低的延迟值使句子切得更碎，没有更快。

**当时结论：** 降低 `max_endpoint_delay_ms` 不能解决 2–3 秒的滞后，主要延迟来自 Soniox ASR API。

## 3. 为什么原文持续更新，译文却需要等待

应用管线（`src/js/soniox.js` 的 `_handleResponse`）：

- `translation_status: "original"`、`is_final:false` 的 token → 发出 `onProvisional` → **持续显示原文临时结果**。
- `translation_status: "translation"` 的 token 只在端点后、`is_final:true` 时到达 → 发出 `onTranslation`。
- 当时 Soniox **不发送译文临时结果**，因此应用无法逐步渲染译文。

应用开销很小：从回调直接同步渲染，不做防抖；音频块为 1024 个采样点，约 64ms。它不是该次延迟的主要来源。

## 4. 流式机制对比（影响使用体验）

| 引擎 | 原文临时结果 | **译文逐步出现？** | 首个最终结果 |
|---|---|---|---|
| Soniox | ✅ 实时 | ❌ 只有端点后的最终结果 | 约 3.9 秒 |
| Qwen Live Flash | ❌ 无原文 | ❌ 整块赋值，无增量 | 约 3.8 秒 |
| Qwen Omni | 部分支持 | ❌ | 约 4.7 秒 |
| OpenAI | ✅ 实时 | ✅ **流式目标文本增量** | 约 6.9 秒，但从约 2.7 秒开始逐字显示 |

在这次比较中，**只有 OpenAI 通过目标文本增量带来“实时显示翻译”的感觉**，代价是首个最终结果更慢、当时记录的价格较高（$4/小时）。

## 5. 当时的改进建议（按优先级）

1. **[回复用户] 不以提速为目的调整 Soniox 端点延迟。** 该次测试未显示收益。若希望译文逐步出现，当时建议使用 OpenAI。
2. **[P3，可选] “输入灵敏度／端点”滑块。** 如果仍提供 `max_endpoint_delay_ms` 设置，应解释它改变分段粒度，而非速度。`connect(config)` 当时已有 `endpointDelay`，只需连接界面。默认值由 3000 降为 1500 可使片段更短，适合会议问答。
3. **[当时不可行] Soniox 译文临时流。** 当时 API 不支持，因此不实施。
4. **[文档] 更新 `engine-matrix-vi.md`。** 增加“译文逐步显示”列，帮助按需求选择引擎：OpenAI 逐步显示，Soniox／Qwen 等待句子完成。

## 当时尚未解决的问题

1. 要实现第 5.2 节的端点滑块，还是只向用户解释“API 限制”？该滑块不降低延迟，仅改变分段粒度，价值较低。
2. Soniox 除 `stt-rt-v4` 外，是否提供其他低延迟／流式翻译模式？当时未查最新 Soniox 文档，原记录建议使用 `docs-seeker` 进一步调查。
3. 数据来自单次运行、一份日语音频。是否需要多次运行和多语言样本，以确认首个最终结果的差异不是测量噪声？
