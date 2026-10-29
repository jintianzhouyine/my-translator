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
3. 在 **Existing version tag to build and publish** 中填写已有 tag，例如 `v0.10.1`。
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

## 构建范围

- macOS：`macos-14` / `aarch64-apple-darwin`。
- Windows：`windows-2022` / `x86_64-pc-windows-msvc`。
- Windows x64 先执行 `scripts/prepare-windows-x64.ps1`，准备官方 sherpa-onnx static-MD 库，与 Rust 默认动态 CRT 匹配。
- 旧 Windows ARM64 安装包保留在历史 Release 中。
- 测试和二进制检查不能替代真实设备上的安装、云端翻译与音频路由验收。
