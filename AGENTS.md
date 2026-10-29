# My Translator 项目协作说明

## 项目上下文

这是 Tauri 2 桌面翻译应用：前端为原生 HTML/CSS/JavaScript ES modules，后端为 Rust。
当前发布目标为 macOS Apple Silicon 和 Windows x64（Intel/AMD 64 位），界面主要使用中文。

- `src/`：界面及客户端会话；`src/js/` 包含 Qwen 双向通话、音频文件翻译和术语导入。
- `src-tauri/src/`：原生音频采集、输出路由、WebSocket、设置及文件处理命令。
- `tests/`：应用 JavaScript 测试；Rust 单元测试与原生模块放在一起。
- `scripts/`：开发启动、测试入口、平台准备和发布检查。
- `docs/`：功能配置、操作说明和版本记录；`specs/`：需求、设计、实施与验收记录。
- `.opencode/`：已有 OpenCode 工具资料。按需参考，不属于应用运行代码。

现有功能以代码及文档为准：

- [Qwen 双向通话](docs/qwen-duplex.md)
- [音频文件翻译](docs/audio-file-translation.md)
- [v0.10.0 发布说明](docs/releases/v0.10.0.md)
- [发布操作说明](docs/releasing.md)

## LeanSpec 工作流

在仓库根目录运行 `lean-spec`，本次初始化使用版本 `0.2.26`。
CLI 可直接使用，不依赖 MCP；未配置全局 AI 工具或额外 skill。

1. 开始工作前运行 `lean-spec board`；用 `lean-spec search "关键词"` 查找相关规范。
2. 多步骤功能、行为变更或需要设计取舍的工作应创建或更新 spec；简单修复及文字调整无需单独建 spec。
3. 用 `lean-spec create <name> --title "中文标题"` 创建规范，目录名使用英文 kebab-case，正文使用中文。
4. 实施前执行 `lean-spec update <spec> --status in-progress`，同步记录实施进度和验收结果。
5. 实际完成后执行 `lean-spec update <spec> --status complete`，再运行 `lean-spec validate --strict --check-deps`。

使用 CLI 管理编号、frontmatter、状态和时间戳，不手工创建带编号的规范目录或修改这些元数据。
正文可以直接编辑。完成状态表示实现及验收完成，而不是文档写完。
规范应简洁，超过 200 行或 3,500 tokens 时考虑拆分，400 行 / 5,000 tokens 为配置上限。

| 操作 | 命令 |
| --- | --- |
| 列出 / 查看 | `lean-spec list` / `lean-spec view <spec>` |
| 添加阻塞依赖 | `lean-spec rel add <spec> --depends-on <other>` |
| 移除阻塞依赖 | `lean-spec rel rm <spec> --depends-on <other>` |
| 设置父规范 | `lean-spec rel add <spec> --parent <parent>` |
| 查看依赖 / 大小 | `lean-spec deps <spec>` / `lean-spec tokens <spec>` |

仅真实的实施阻塞关系才使用 `depends_on`；普通文档引用使用 Markdown 链接。
更多说明及模板见 [specs/README.md](specs/README.md)。

## 开发与验证

开发环境使用 Node.js 20+ 和 Rust stable；CI 使用 Node.js 20。
以下命令均从仓库根目录执行，按变更范围选择验证：

| 用途 | 命令 |
| --- | --- |
| 安装 JavaScript 依赖 | `npm ci` |
| 桌面开发 | `npm run dev` |
| 浏览器预览 | `npm run dev:web` |
| JavaScript 测试 | `npm test` |
| Rust 单元测试 | `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` |
| Rust 静态检查 | `npm run lint` |
| Rust 格式检查 | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| 本地开发构建 | `npm run build:dev` |
| 发布构建 | `npm run build` |

`npm test` 通过 `scripts/test.mjs` 仅运行应用测试，不要使用裸 `node --test` 扫描 `.opencode/`。
Windows x64 使用 `x86_64-pc-windows-msvc`，构建前执行 `scripts/prepare-windows-x64.ps1` 准备匹配动态 CRT 的语音库。
平台发布步骤以 [release.yml](.github/workflows/release.yml) 为准：仅手动触发，输入已存在的版本 tag，
两个平台均通过后向 Release 草稿上传安装包并发布。推送 tag 不触发构建。

## 实现约定

- 保持现有原生 JavaScript 与 Rust 模块结构，不为小改动引入前端框架。
- 前后端命令或事件契约有变动时，同时核对两侧及相关测试。
- 音频处理保留原始时间轴；失败请求的重试或跳过应保留其他已完成结果。
- 自动切分依赖本机 FFmpeg/ffprobe；通话译音输出依赖单独安装的虚拟音频设备。
- 自动测试及模拟服务不能代替真实云端、字幕对齐或会议音频设备验收；记录实际验证范围。
- 功能行为变化时更新对应 `docs/` 和 spec，避免复制整份历史文档。
- 不提交 API Key、`.env`、私人录音或本机生成文件；不要修改 vendored SheetJS 文件的换行和校验内容。
