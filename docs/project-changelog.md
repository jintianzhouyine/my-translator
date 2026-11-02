# 更新记录

**简体中文** · [English](project-changelog.en.md)

这里保留项目的历史更新记录。下述功能、平台支持、模型可用性、价格和测量结果仅对应记录中的版本与日期，不代表当前版本。当前功能见[项目介绍](../README.md)。

当前 `.github/workflows/release.yml` 使用 `docs/releases/v<version>.md` 作为 GitHub Release 正文；本文件保留更早的版本历史。

格式为 `## v<version> - <YYYY-MM-DD>`，内容延续到下一个 `## v` 标题。

---

## v0.9.1 - 2026-07-11

### 修复：引擎选择不再阻止用户完成配置

- **没有密钥时仍可选择云端引擎。** 之前，Soniox / OpenAI 下拉选项只有在填写有效密钥后才可选，但用户又必须先选择引擎才能填写密钥，形成死循环。所有需要密钥的引擎（Soniox、OpenAI、Qwen）现在都可选择，并显示醒目的“cần API key”（需要 API Key）提示；未填写密钥时仍不能开始会话。
- **本地 MLX 根据实际硬件而非二进制架构判断。** Apple Silicon Mac 通过 Rosetta 运行 x64 版本时，应用曾把架构识别为“x86_64”，错误地禁用本地 MLX。现在通过 `sysctl hw.optional.arm64` 查询真实 CPU，不受安装包架构影响。在不支持的设备上，本地 MLX 也不再被直接禁选，而是明确提示并在开始时阻止运行。

### 文档

- README 和发布说明新增“应该下载哪个安装包”表格（Apple Silicon、Intel、Windows），解决部分用户在 Apple Silicon 上误装 x64 Mac 版本的问题。

---

## v0.9.0 - 2026-07-11

> 自 v0.7.3 后的第一个标签版本，也包含下方 v0.8.0 中的全部改动：本地／在线 TTS 提供商、朗读模式及自定义越南语音色。

### 应该下载哪个文件？

| 电脑 | 下载文件 |
|---|---|
| **Mac Apple Silicon**（M1/M2/M3/M4） | `MyTranslator_0.9.0_aarch64.dmg` |
| **Mac Intel**（2020 年以前的机型） | `MyTranslator_0.9.0_x64.dmg` |
| **Windows** | `MyTranslator_0.9.0_x64-setup.exe` |

在 Mac 上打开 Apple 菜单 → 关于本机 →“芯片”：**Apple** 对应 aarch64，**Intel** 对应 x64。`.app.tar.gz`、`.sig` 和 `latest.json` 用于当时的自动更新，无需手动下载。

### 改动：主界面按三种活动重新设计

- **活动切换器 `[🎙 Live | 📖 Đọc | 📚 Thư viện]`**（实时／朗读／资料库）替代 Live/Read 开关和独立 Sessions 页面。各页面只显示自身控件；浏览资料库时实时会话继续在后台运行，Live 页签显示红色提示标记。
- **实时工具栏整合**：从约 15 个按钮收敛为状态行（引擎、语言、音源下拉框）、字幕和底部操作区。底部含一个主要的 [▶ Bắt đầu/Dừng]（开始／停止）按钮、TTS 和 ⋯ 菜单（复制、清空、字号、文字颜色、双栏、精简模式、快捷键）。音源改为下拉框，⌘1/2/3 仍可切换。
- **两种窗口模式**：⤢ 在紧凑浮层和展开窗口（约 900×640，便于朗读与资料库操作）之间切换。两种模式分别记忆用户调整后的尺寸。
- **翻译时自动隐藏工具栏**：空闲 3 秒后隐藏，移动鼠标或悬停顶部边缘时显示；可在 ⋯ 菜单关闭。保留手动精简模式。
- **朗读页快速选音色**：直接在朗读面板更换当前 TTS 音色；“Chỉnh thêm…”（更多设置）跳转到设置 → TTS。
- **快捷键速查**：按 `?`，或打开 ⋯ → Phím tắt（快捷键）。
- 工具栏移除最小化按钮，仍可使用 ⌘M。

### 技术细节

- 新增 `src/js/ui-shell.js`，负责活动导航、⋯／下拉弹窗辅助逻辑、窗口模式（通过 localStorage 持久化），以及自动隐藏与手动精简模式共用的界面显隐。
- 移除 `sessions-view`，其列表／查看器标记移入资料库面板。移除 `mode-toggle`，保留 `_readMode` 作为 `getActivity()==='read'` 的旧兼容别名。
- 字幕滚动区域从 `#transcript-container` 移到 `#transcript-content`；前者现在是容纳状态行和操作行的纵向 flex 容器。

---

## v0.8.0 - 2026-07-06

### 新增

- **朗读模式：在浮层中朗读越南语文本。** 工具栏新增 Live ↔ Read 开关，默认 Live。粘贴或输入越南语后，应用使用当前 TTS 提供商朗读；没有字符数限制，文本按句分块，每块调用一次合成。支持播放／暂停／停止、“đoạn N/M”（第 N/M 段）进度和当前块高亮。
  - 本地音色采用类似 Trudio 的预取策略（提前合成下一块），使衔接接近无间隙；其他提供商顺序朗读，避免集中触发限流。
  - 不静默丢弃文本：合成／解码在有限重试后仍失败的块，会显示清晰的逐块错误标记。
  - 朗读使用独立音频路径，与实时采集 → 翻译 → 播放完全分离，避免回归。音频仅驻留内存，播放后释放，不写入磁盘。

- **Google TTS — Free：支持可选的用户 API Key。** 设置 → TTS → Google TTS — Free 新增可选 Google API Key 字段。填写时使用该密钥，否则使用应用内置密钥（如果有）；两者都没有时提供商不可用，不使用硬编码回退。密钥保存在本机，错误输出会脱敏。

- **本地（离线）TTS 提供商：Piper 神经音色，完全在设备端运行。** 新增通过 sherpa-onnx 运行 Piper（VITS）模型的本地语音合成，无需网络或 API Key，不向外发送数据。支持 macOS 和 Windows 的 CPU；当时记录的合成速度约为实时的 15 倍。
  - 内置可按需下载的越南语及英语音色目录（设置 → TTS → Local）。每个音色由用户发起下载，显示进度，也可真正从本机删除。
  - 可选择模型位置：默认应用目录或自定义文件夹；首次下载前提示，之后随时可更改。
  - 安装前校验下载文件的 SHA-256；音素化所需的 espeak-ng 数据随各模型提供，完整离线运行。

### 说明

- sherpa-onnx 采用静态链接，无需另外随包提供原生库；应用二进制增大约 23 MB。

## v0.7.3 - 2026-06-17

### 改动

- **Soniox 引擎从 `stt-rt-v4` 升级到 `stt-rt-v5`。** 仅修改模型配置即可替换，当时测得越南语输出更好。旧 `stt-rt-v4` 在记录中计划于 2026-06-30 退役，此次升级也用于保持后续可用。

### 基准测试

对照条件一致：相同测试脚本、相同的 302 秒日语 → 越南语音频，两个模型同时按实时速度推送。

| 指标 | stt-rt-v4 | stt-rt-v5 |
|---|---:|---:|
| 连接 | 2445 ms | 2450 ms |
| 首个最终结果 | 16597 ms | 16084 ms（约快 0.5 秒） |
| 最终片段数 | 109 | 109 |
| 错误数 | 0 | 0 |
| 费用（302 秒，按 $0.12/小时） | $0.0102 | $0.0102 |

延迟、费用和分段基本一致；v5 的改进体现在**翻译质量**：专有名词更准确（如“Akabira”而非 v4 的“Akahira”），术语更精确（“vũ trụ”“vệ tinh nhân tạo”），从句衔接更流畅，碎片化表达更少。

### 技术细节

- `src/js/soniox.js`：配置中的 `model` 从 `stt-rt-v4` 改为 `stt-rt-v5`。
- `src/js/app.js`：API Key 连通性检测（`_pingSoniox`）同步修改模型名。

---

## v0.7.2 - 2026-05-26

### 改动

- **Qwen 引擎从 Omni Plus 迁移到 LiveTranslate Flash**（`qwen3-livetranslate-flash-realtime`）。服务端 VAD 替代之前按 RMS 实现的客户端 VAD；使用纯文字输出，语言选择器明确列出 60 多种受支持语言，与当时移动端 v0.4.3 一致。当时 DashScope 国际站仅新加坡地域提供免费预览。
- **设置按引擎重组**，与移动端保持一致：只显示当前引擎的 API Key 区域。非 Soniox 引擎隐藏其专属功能（自定义上下文、严格语言检测、端点延迟）。OpenAI／Qwen 云端实时引擎隐藏 TTS 页签。引擎提示合并为一条动态说明。
- **Qwen 使用单栏字幕**：Live Flash 当时只返回译文，没有源语言 ASR 通道，因此启用 Qwen 时强制折叠为单栏，避免空白原文栏和灰色临时文本干扰。
- **Qwen 源语言选择隐藏“自动检测”**：真实麦克风输入下，源语言为“auto”会使 Live Flash 停滞。切换到 Qwen 时，源语言默认英语并自动调整为具体语言。
- **Qwen 禁用双向模式**，与 OpenAI 一致；当时云端实时引擎仅支持单向。

### 文档

- macOS、Windows 安装指南的英文及越南语版新增三张引擎设置截图：`setting_soniox.png`、`setting_openai.png`、`setting_qwen.png`。macOS 英文指南补入此前仅越南语版包含的 Qwen 配置说明。

### 技术细节

- `src-tauri/src/commands/qwen_realtime.rs` 从 486 行重写为 264 行，URL 切换至 `qwen3-livetranslate-flash-realtime`。移除 RMS-VAD 状态、`commit_turn`、`rms_int16`。新会话请求 `modalities=["text"]`，设置 `input_audio_transcription.language` 和 `translation.language`，关闭客户端端点控制，由服务器处理。`response.text.text` 快照作为临时结果发出，`response.text.done` 按 `response_id` 去重后作为最终结果发出。
- `src/js/qwen-realtime-client.js` 从 148 行重写为 90 行。临时缓冲区改为整份快照赋值；Live Flash 每次发送 `text + stash`，不是增量。`connect({ apiKey, sourceLanguage, targetLanguage })` 移除输出队列和原文临时回调。
- 新增 `src/js/qwen-langs.js`，包含 60 种语言，与移动端 `QWEN_LANGS` 结构一致，不提供“auto”。
- `src/js/app.js` 的 `_updateModeUI` 根据引擎显示密钥区、Soniox 专属设置和 TTS 页签，切走不适用页签时提供回退。
- `TranscriptUI.provider` 改为 getter/setter；运行中切换到 Qwen 时移除 `.dual-view`。`_render()` 在 provider='qwen' 时强制使用 `_renderSingle`；Qwen 临时结果按目标语言流显示（`seg-translated` 类），不再使用暗色斜体。
- 从设置结构体、默认值和 JavaScript 的 `DEFAULT_SETTINGS` 移除 `qwen_audio_output`。结构体级 `#[serde(default)]` 兼容已有 settings.json，无需迁移。

### 注意事项

- 当时 DashScope 密钥必须在**新加坡地域**创建；其他地域使用不同端点，开始时会发生 `WebSocket error`。
- 原 Qwen-Omni 用户需要将源语言从“Auto”改为具体语言；若旧目标语言代码不在新的 60 种语言列表中，自动调整会默认选中越南语，需重新确认。

---

## v0.7.1 - 2026-05-25

### 改动

- **OpenAI Realtime 在麦克风之外新增系统音频和混合音源支持。** 实测服务端端点检测也可处理非麦克风来源，因此取消之前的仅麦克风限制。
- **OpenAI 和 Qwen Realtime 默认关闭语音输出（TTS）**，防止共享设备上的扬声器 → 麦克风反馈循环，系统音频采集时尤其明显。云端实时引擎移除工具栏语音开关，改为与当时移动端一致的纯文字模式。Soniox／Local 仍保留原有自定义 TTS。

### 技术细节

- `src-tauri/src/settings.rs` 的 `openai_audio_output`、`qwen_audio_output` 默认值从 `true` 改为 `false`。两个客户端连接时始终请求纯文字输出。
- `_updateModeUI` 不再在 OpenAI 模式中隐藏或禁用音源按钮。
- 移除 `_toggleOpenAiAudio` 辅助方法及 `#btn-openai-audio` 工具栏元素。

---

## v0.7.0 - 2026-05-24

### 新功能

- **Qwen-Omni Realtime 翻译提供商**：新增阿里云 DashScope 的 `qwen3.5-omni-plus-realtime` 作为第四种引擎。当时为免费预览，流式返回译文与语音，支持完整的 Soniox 语言列表，不受 OpenAI 13 种语言限制。
- **引擎选择**：引导页新增第三张卡片，工具栏新增 🌏 Qwen 快速切换按钮。
- **Qwen 系统音频和混合音源模式**：与当时仅麦克风的 OpenAI 不同，Qwen 使用客户端 RMS-VAD 控制轮次，因此可以配合系统音频采集。

### 修复

- **最终片段的尾行重复**：`addTranslation` 后没有清除 `provisionalText`，导致已完成片段的残留副本以“...”临时行再次显示。OpenAI Realtime 也受影响；两个引擎现在都在每次 `onSegment` 时清除临时文本。

### 技术细节

- 新增约 400 行的 Rust 模块 `src-tauri/src/commands/qwen_realtime.rs`：连接 DashScope 国际端点的 WebSocket 桥接；客户端 RMS-VAD 轮次控制（int16 阈值 500、静音 400ms、窗口 2–7 秒）；`response_in_flight` 单请求保护，避免 `response.create` 竞争；用 `last_done_response_id` 对 `response.text.done` 与 `response.audio_transcript.done` 去重。
- 新增 `src/js/qwen-realtime-client.js`，采用与 Soniox 客户端相同的回调结构，使 app.js 接线保持对称。
- 加强会话指令，要求人称代词一致且完整翻译；此前缺少指令前缀时 Qwen 有时只返回部分翻译。
- 设置新增 `qwen_api_key` 和 `qwen_audio_output`（默认 true）。
- 使用源文／译文最终结果队列 `_pendingSourceFinals`，在两类事件完成节奏不一致时进行配对。

### 注意事项

- 当时 DashScope 国际站密钥需在 https://bailian.console.alibabacloud.com 的新加坡地域创建；中国内地密钥使用不同端点。
- 语音模态需要 audio_output=true；工具栏静音会发送 `modalities=["text"]`，使 DashScope 跳过语音生成，节省计费秒数。

---

## v0.6.0 - 2026-05-13

### 新功能

- **OpenAI Realtime 翻译提供商**：新增 `gpt-realtime-translate`（记录中的 2026 年 5 月正式版），作为 Soniox 和 Local MLX 之外的第三种引擎。单个 WebSocket 流式返回译文和译音，无需单独 TTS 步骤，相比纯文字提供商降低端到端延迟。
- **支持 13 种输出语言**：en、es、pt、fr、de、it、ru、hi、id、vi、ja、ko、zh。
- **签名并公证的 macOS DMG**：当时构建使用 Developer ID 签名并通过 Apple 公证服务，首次启动无需 `xattr` 绕过操作。

### 修复

- **双栏路由**：双栏视图下，OpenAI 原文转写稳定显示在左侧原文栏，译文显示在右侧。此前 Whisper 转写滞后于译文时，启发式路由会误把译文放入原文栏。
- **原文／译文最终结果配对**：Whisper 转写和翻译流的完成节奏不同；现在通过队列配对，保存后的记录保持对齐。

### 注意事项

- **当时费用**：按提供商标价，在 5 分钟日语 → 越南语正式端点测试中，约为 $0.07/分钟（约 $4/小时），约为 Soniox 的 34 倍。由用户自己的 OpenAI 账户计费；设置中显示费用提示。
- 选择 OpenAI Realtime 时，**双向模式**和**自定义 TTS 提供商开关**不可用，语音直接由模型输出。
- 支持的输出语言中**不含泰语**；当时泰语用户应继续使用 Soniox 或 Local MLX。
- **长停顿时原文可能停滞**（如掌声间隔），翻译仍继续。该问题当时仍在调查。

### 技术细节

- Rust 音频管线新增基于 `rubato` 的 16k → 24k 多相重采样，使现有 16kHz 采集适配模型要求的 24kHz s16le 输入。
- 新增 Tauri 命令 `openai_realtime_start`、`openai_realtime_send_audio`、`openai_realtime_stop`。WebSocket 放在 Rust 端，因为浏览器不能在 WebSocket 握手中设置 `Authorization` 请求头。
- 新增 `src/js/openai-realtime-client.js`，对齐 Soniox 客户端回调结构；新增 `openai-audio-output-queue.js`，使用 Web Audio API 流式播放 24kHz 输出。
- 字幕 UI 新增明确的 `provider` 标记，替代之前的启发式判断，修复双栏回归。
- 新增本地公证构建脚本 `scripts/build-notarized.sh`，从 gitignored `.env` 读取 `APPLE_*` 环境变量。

---

## v0.5.3 - 2026-04-10

### 修复

- **Windows**：修复点击播放数秒后应用崩溃的问题。v0.5.2 引入的 Application Loopback（ALAC）流配置不正确，在采集时触发访问冲突。回退到已知稳定的 v0.5.1 旧版 WASAPI loopback 路径。

### 重新出现的已知限制

- Windows 系统音频采集会包含应用自身的 TTS 输出。单向模式请使用耳机避免反馈；双向模式本就禁用 TTS，因此没有变化。待可在真实 Windows 电脑测试时，再研究排除自身声音。

---

## v0.5.2 - 2026-04-09

### 新功能

#### 会话历史查看器

- 新增 **Sessions** 页面，浏览全部已保存的翻译会话。
- 点击会话查看完整字幕并复制到剪贴板。
- 通过浮层工具栏的时钟图标进入。

#### 改进自动保存

- 会话现在在**停止时自动保存**，无需手动操作。
- 完整会话日志始终保留，不像显示缓冲区那样裁剪。
- 记录包含日期、时间、源语言、目标语言和模式等元数据。

### 修复

- **Google TTS**：API 被禁用时提供更清晰的提示，引导用户在 Google Cloud Console 启用“Cloud Text-to-Speech API”。
- **Windows**：修复新音频采集实现中的 WASAPI 编译错误。

### 技术细节

- 重构 Windows WASAPI 音频采集，提供 ALAC 和旧版 loopback 支持。
- 新增 Rust 命令 `list_transcripts`、`read_transcript`。

---

## v0.5.1 - 2026-03-26

### 新功能

- **双向翻译**：同时翻译两种语言之间的对话，用于 Zoom、Google Meet、MS Teams 等双语会议。
- **混合音源“Both”**（系统音频 + 麦克风）：同时采集自己的声音和远端参与者，供双向模式使用。
- **端点延迟滑块**：调整 STT 延迟，在更快响应与更准确转写之间取舍。
- **Soniox 增强**：保活、丰富上下文、语言识别和置信度分数。
- **严格语言限制**：提高目标语言输出的可靠性。

### 说明

- 双向模式自动关闭 TTS 朗读，防止音频反馈循环。

---

## v0.5.0 - 2026-03-21

### 新功能

- **支持全部 Soniox 语言**，包含 70 多种源语言。
- **自动更新**：设置 → 关于中检查和安装更新的内置更新器。
- **TTS 朗读**：三种提供商，Edge TTS（免费）、Google Chirp 3 HD、ElevenLabs。
- **关于页签**：版本信息、更新控制和链接。
- **更新体验重新设计**：更清晰的进度、错误处理。

### 修复

- 修复自动更新、重启和 TTS 管线中的多项稳定性问题。

---

## v0.4.5 - 2026-03-18

### 新功能

- **Google TTS Chirp 3 HD**：接近真人的神经音色。
- **双栏视图**：原文和译文左右显示，各自独立滚动。
