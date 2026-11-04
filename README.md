<p align="center">
  <img src="banner.png?v=2" alt="My Translator — 实时语音翻译与双语字幕">
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/jintianzhouyine/my-translator/releases/latest"><img src="https://img.shields.io/github/v/release/jintianzhouyine/my-translator?color=green&label=release" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="使用 Tauri 构建">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Windows-x64-blue?logo=windows" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/github/stars/jintianzhouyine/my-translator?style=flat&color=yellow" alt="本项目 Star 数">
</p>

# My Translator · 我的翻译器

一款基于 Tauri 2 的桌面语音翻译工具，支持**实时双语字幕、双向通话译音和音频文件翻译**。采集系统声音或麦克风后，通过自己配置的云端服务完成识别与翻译，也可在 Apple Silicon 上使用实验性的本地翻译模式。

软件只需安装在自己的电脑上：阅读对方讲话的翻译字幕，或将自己的讲话翻译成语音，通过虚拟麦克风送给会议中的对方。当前应用界面主要为中文；项目文档提供中文和英文版本。

[下载最新版](https://github.com/jintianzhouyine/my-translator/releases/latest) · [文档目录](docs/README.md) · [反馈问题](https://github.com/jintianzhouyine/my-translator/issues)

## 下载与安装

当前发布的安装包为：

| 电脑 | 安装包 |
| --- | --- |
| Mac M 系列（Apple Silicon） | `MyTranslator_<版本>_aarch64.dmg` |
| Windows Intel / AMD 64 位 | `MyTranslator_<版本>_x64-setup.exe` |

Release 中的 `SHA256SUMS` 可用于校验安装包。应用内「检查更新」会检查当前仓库的正式 Release，并引导手动下载；新版本通过 GitHub Actions 手动构建。Windows ARM64 的旧安装包保留在 [v0.10.0](https://github.com/jintianzhouyine/my-translator/releases/tag/v0.10.0)，当前不提供新的 Windows ARM64 或 Mac Intel 安装包。

macOS 安装包使用 ad-hoc 签名，未经 Apple 公证；Windows 安装包未使用发行者证书签名。安装及权限处理见 [macOS 指南](docs/installation_guide.md)和 [Windows 指南](docs/installation_guide_win.md)。

## 主要功能

### 实时字幕

- 采集系统声音、麦克风，或同时采集两者。
- 显示译文，或开启「双语字幕」显示原文＋译文；支持上下排列和左右双栏对照。
- 提供置顶窗口、精简模式、字体大小和颜色调整，以及不会打断历史阅读的自动滚动。
- 保存和浏览本机会话记录；字幕显示开关不会删除已收到的原文。

详见[实时双语字幕](docs/live-subtitles.md)。原文是否可用取决于所选引擎返回的识别内容。

### Qwen 双向通话

使用百炼的 `qwen3.8-livetranslate-flash-realtime`，为两个方向建立独立会话：

```text
你的讲话 → 识别与翻译 → 生成译音 → 虚拟麦克风 → 对方的会议软件
对方讲话 → 采集会议声音 → 识别与翻译 → 本机原文和翻译字幕
```

- 分别设置「对方听到的语言」和「我阅读字幕的语言」，输入语种自动识别。
- 实时页右上角独立控制发给对方的**原声、译音及各自音量**。
- 支持将虚拟输入设为系统默认麦克风；暂停、停止、启动失败或正常退出后恢复记录的音频设备。强制结束进程后，在下次启动时尝试恢复。
- 自动配对支持 macOS BlackHole 和 Windows 标准名称的 VB-CABLE（含 A/B/C/D）；其他设备可使用手动路由。
- 只想阅读字幕时，可以关闭双向通话，无需虚拟麦克风。

需要自行准备百炼 API Key、业务空间 ID 及匹配的北京／新加坡地域。双向通话分别计量两个会话，直接生成译音，无需另接 TTS。虚拟音频驱动需要单独安装，会议软件应使用相应输入设备或系统默认麦克风。详见 [Qwen 配置与音频路由](docs/qwen-duplex.md)。

### 专有名词导入

Qwen 的两个翻译方向可以独立维护词典。支持从 Excel（`.xlsx`）、CSV、TSV、TXT 和 JSON 导入，预览后选择合并、覆盖冲突或整份替换；可交换两列用于反向翻译，每个方向最多 1,000 条。

提供 [Excel 示例词表](docs/examples/qwen-terms.xlsx)。词典用于向模型提示指定译法，不能保证每次输出完全一致；详见 [术语词典与导入说明](docs/qwen-duplex.md#术语词典)。

### 音频文件翻译与字幕回放

- 选择本地录音，生成原文、译文和带时间轴的字幕；当前沿用已保存的 Qwen 实时接口配置。
- 支持自动分段、自定义分割点，或手动导入已经切分的文件。
- 加速模式最多两段并行，显示中间译文；遇到暂时性错误可自动重试，也可单独重试或跳过失败片段。
- 点击译文播放对应的原音频范围，导出译文、原文或双语的 SRT / VTT / TXT。

桌面自动解码需要本机安装 FFmpeg / ffprobe；当前未内置这两个工具。自动解码支持单个原文件最多 16 GiB、24 小时；手动导入的每个片段最多 100 MiB、30 分钟。时间轴为语音段级别，实际对齐与翻译效果取决于服务返回结果。详见[音频文件翻译指南](docs/audio-file-translation.md)。

### 多种引擎与语音朗读

| 引擎 | 应用中的用途 | 需要准备 |
| --- | --- | --- |
| Qwen LiveTranslate | 双向通话译音、本机字幕、音频文件翻译 | 百炼 Key、业务空间、地域；通话译音另需虚拟音频设备 |
| Soniox | 流式识别与文字翻译、双语对话识别、上下文和术语配置 | Soniox API Key |
| OpenAI Realtime | 单向流式文字字幕；当前界面未启用语音播放 | OpenAI API Key |
| 本地 MLX（实验性） | 在本机进行识别和翻译 | Apple Silicon、Python 环境及本地模型 |

不同引擎的语种、原文返回和语音能力不同，不能将 Qwen 的通话路由功能视为所有引擎通用。云端费用由自己的服务账号承担，实际价格、语言支持和延迟以服务商及使用情况为准。

Soniox／本地文字翻译还可使用独立 TTS 朗读；提供 Edge、Google、ElevenLabs 等在线选项，以及基于 Piper / sherpa-onnx 的本地语音。离线语音需先下载模型，现有目录主要为越南语和英语。另有「文本朗读」页面，可直接粘贴文字播放。详见 [TTS 指南](docs/tts_guide.md)。

## 数据与隐私

- 云端模式直接连接自己配置的服务商；音频、术语和必要上下文会发送给对应服务，不经过本项目的中转服务器。
- API Key 和应用设置保存在本机，不要将密钥或私人录音提交到仓库。
- 文件选择和分段在本机处理，点击开始翻译后才发送对应音频；导出和会话记录保存在本机。
- 本地 MLX 翻译和 Piper 语音在准备好模型及运行环境后可在本机处理；云端模式需要联网。

## 从源码运行

需要 Node.js 20+、Rust stable，以及对应平台的 Tauri 原生构建工具；macOS 需要 Xcode Command Line Tools，Windows 需要 MSVC C++ 构建工具与 WebView2。

```bash
git clone https://github.com/jintianzhouyine/my-translator.git
cd my-translator
npm ci
```

Windows x64 在构建前还需准备语音库：

```powershell
./scripts/prepare-windows-x64.ps1
```

准备完成后启动应用：

```bash
npm run dev
```

`npm run build` 用于打包，`npm test` 运行应用 JavaScript 测试；原生测试使用 `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`。浏览器预览 `npm run dev:web` 不具备原生采集与音频路由能力。

本项目使用 LeanSpec 记录需求与验收，在根目录运行 `lean-spec board` 查看；协作说明见 [AGENTS.md](AGENTS.md) 和 [specs/README.md](specs/README.md)。发布说明见[手动构建和发布](docs/releasing.md)。自动测试不等同于真实云账号、虚拟设备及会议软件的端到端验收。

## 文档

完整中英文对照入口见[文档目录](docs/README.md)。

- [macOS 安装](docs/installation_guide.md) · [Windows 安装](docs/installation_guide_win.md)
- [Qwen 双向通话](docs/qwen-duplex.md) · [实时双语字幕](docs/live-subtitles.md)
- [音频文件翻译](docs/audio-file-translation.md) · [TTS 语音朗读](docs/tts_guide.md)
- [构建和发布](docs/releasing.md) · [历史变更记录](docs/project-changelog.md)
- [历史基准测试](benchmarks/README.md)

## Star History

<a href="https://www.star-history.com/?repos=jintianzhouyine%2Fmy-translator&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&legend=top-left" />
    <img alt="jintianzhouyine/my-translator 的 Star 历史" src="https://api.star-history.com/image?repos=jintianzhouyine/my-translator&type=date&legend=top-left" />
  </picture>
</a>

## 致谢与许可证

本项目基于 [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) 继续开发。采用 [MIT 许可证](LICENSE)，保留原作者的版权与许可声明。

原版权声明：`Copyright (c) 2026 Personal Translator Contributors`。完整来源与第三方许可说明见[版权与来源说明](COPYRIGHT.md)。
