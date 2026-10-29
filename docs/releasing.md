# 手动构建和发布

当前发布组合为 **macOS Apple Silicon（ARM64）+ Windows x64（Intel/AMD 64 位）**。
GitHub Actions 仅接受手动触发，推送代码、推送 tag 或创建 Release 草稿都不会启动构建。

## 准备版本

1. 同步 `package.json`、`package-lock.json`（顶层及根包）、`src-tauri/Cargo.toml`、
   `src-tauri/Cargo.lock`（本项目条目）及 `src-tauri/tauri.conf.json` 的版本。
2. 创建 `docs/releases/v<版本>.md` 发布说明，完成相关测试并提交。
3. 将提交和对应的 `v<版本>` tag 推送到 GitHub；同一版本 tag 不重复指向不同内容。
4. 使用该 tag 创建 Release 草稿，暂不正式发布。没有草稿时，工作流会在构建成功后创建。

## 在网页中触发

1. 打开 [Build & Release 工作流](https://github.com/jintianzhouyine/my-translator/actions/workflows/release.yml)。
2. 点击 **Run workflow**，保留 **Use workflow from: main**。
3. 在 **Existing version tag to build and publish** 中填写已有 tag，例如 `v0.10.4`。
4. 再次点击 **Run workflow**。

工作流先校验 tag、应用版本和发布说明，并将 tag 解析为固定的 commit。
macOS 和 Windows 任务都构建该 commit，而不是构建触发时 main 上的其他代码。
每个平台执行 JavaScript / Rust 测试、打包及二进制架构和版本检查。

两个平台全部通过后，自动上传以下文件并正式发布 Release：

- `MyTranslator_<版本>_aarch64.dmg`
- `MyTranslator_<版本>_x64-setup.exe`
- `SHA256SUMS`

任何构建失败都不会发布草稿；修复之前请查看对应任务的日志。
草稿上传中途失败时可重跑工作流，已上传的同名草稿附件会被替换。
对已经正式发布的版本，工作流会拒绝覆盖安装包；代码修复应使用新的版本和 tag。

## 应用内检查更新

「设置 → 关于 → 检查更新」读取本仓库的最新正式 Release，并与已安装应用版本比较。
发现新版后点击「前往 GitHub 下载」，在 Release 页面选择适合自己电脑的安装包后安装。
GitHub 项目仓库和问题反馈也指向 `jintianzhouyine/my-translator`。

当前发布仅提供上述安装包与校验文件，不提供 Tauri 签名自动更新包或 `latest.json`，
应用不会自动下载、安装或重启。网络错误和 GitHub 限流会明确提示，可以稍后重试，
也可以直接访问 [Release 下载页](https://github.com/jintianzhouyine/my-translator/releases/latest)。

## 构建范围

- macOS：`macos-14` / `aarch64-apple-darwin`。
- Windows：`windows-2022` / `x86_64-pc-windows-msvc`。
- Windows x64 先执行 `scripts/prepare-windows-x64.ps1`，准备官方 sherpa-onnx static-MD 库，与 Rust 默认动态 CRT 匹配。
- 语音库准备会分别打印下载、校验和解压进度；下载具有连接、低速及总时限，最多尝试三次。
- Windows 使用预装 7-Zip 分两阶段解开 bzip2 和 tar，避免 tar.exe 解压停滞。
- 官方压缩包通过大小和 SHA-256 校验后才解压。准备步骤最多运行 25 分钟，失败会明确报告阶段和错误。
- 校验后的库会单独缓存，后续运行可以复用；缓存服务失败不阻止正常下载准备。
- 旧 Windows ARM64 安装包保留在历史 Release 中。
- 测试和二进制检查不能替代真实设备上的安装、云端翻译与音频路由验收。
