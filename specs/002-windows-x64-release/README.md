---
status: complete
created: 2026-10-29
priority: medium
tags:
- release
- windows
created_at: 2026-10-29T02:13:23.503950Z
updated_at: 2026-10-29T02:35:11.364781Z
completed_at: 2026-10-29T02:35:11.364781Z
transitions:
- status: complete
  at: 2026-10-29T02:35:11.364781Z
---

# Windows x64 发布与手动构建

## Overview

用户需要把 Windows 发布目标从 ARM64 切换为 Intel/AMD 64 位 x64，保留 Mac M 系列安装包。
新版本为 v0.10.1；准备代码、tag 和 GitHub Release 草稿，构建由用户手动触发。

## Design

- Windows 使用 windows-2022 与 x86_64-pc-windows-msvc；macOS 保持 aarch64-apple-darwin。
- PE 架构检查改为 AMD64，拒绝 ARM64 和 32 位 x86 的应用二进制。
- 工作流仅接受 workflow_dispatch，输入已存在的版本 tag；校验后解析为固定 commit，所有任务使用同一 commit。
- 构建成功后上传两个平台安装包和 SHA256SUMS，再发布草稿；不改写已发布版本。
- 同步 npm、Cargo、Tauri 版本为 0.10.1，更新下载及手动发布说明。
- 历史 v0.10.0 ARM64 Release 保留，应用翻译功能不变。

## Plan

- [x] 修改 Windows 构建目标与架构检查
- [x] 实现手动触发、tag 校验及草稿发布流程
- [x] 更新版本号与相关文档
- [x] 提交并推送版本及 tag，创建 Release 草稿

## Test

- [x] 架构检查回归测试与应用 JavaScript 测试通过
- [x] 工作流语法、版本一致性及 LeanSpec 严格校验通过
- [x] 确认远端 tag 与提交一致，Release 为草稿
- [x] 确认没有触发新构建

## Notes

实际 Windows x64 / macOS 安装包构建和设备运行验证留待用户触发 CI 后完成。
本 spec 的完成范围是发布配置与交付准备，不代表新安装包已构建或通过设备验收。

本地验证：221 项 JavaScript 测试通过，其中包含 12 项发布架构与版本回归测试；6 处版本号一致为 0.10.1；工作流 YAML、仅手动触发和构建矩阵检查通过。

交付验证：actionlint 1.7.12 与 10 个 shell 片段语法检查通过。v0.10.1 tag 指向 cf41355，GitHub Release 已创建为草稿，附件为空，未触发新构建。Git 网络超时后使用已有 Git 凭据通过 API 同步，blob/tree/commit 哈希与本地一致。安装包由用户手动运行工作流生成。