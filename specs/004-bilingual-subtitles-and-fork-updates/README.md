---
status: complete
created: 2026-10-29
priority: medium
created_at: 2026-10-29T06:10:48.483053Z
updated_at: 2026-10-29T06:30:05.393463Z
completed_at: 2026-10-29T06:30:05.393463Z
transitions:
- status: in-progress
  at: 2026-10-29T06:11:08.115074Z
- status: complete
  at: 2026-10-29T06:30:05.393463Z
---

# 实时双语字幕与当前仓库更新入口

## Overview

用户希望实时字幕可同时显示原文与译文，并让应用检查更新、GitHub 和问题反馈指向当前仓库 `jintianzhouyine/my-translator`。现有 `show_original` 已持久化，但字幕渲染忽略此选项；更新器仍依赖当前发布未提供的 `latest.json`。

## Design

- 复用原文显示设置，支持单栏上下双语与仅译文，保留双栏对照；通话期间可切换并保存显示偏好。
- Qwen 原文与译文继续按消息 ID 关联，支持原文晚到更新，不新增 ASR 请求或更换翻译模型。
- 集中维护当前仓库、Issue 和 Releases 地址。通过 GitHub 正式 Release 元数据比较当前安装版本，发现新版后打开下载页。
- 当前发布不含签名自动更新包，因此不显示自动安装或自动重启承诺；失败、限流和暂无 Release 与已是最新版分开呈现。

## Plan

- [x] 修复字幕显示设置并添加通话中即时切换
- [x] 修改仓库链接和更新检查流程
- [x] 更新使用说明及回归测试

## Test

- [x] 字幕原文/译文、晚到原文、切换与持久化行为检查
- [x] 更新版本比较、错误状态及下载地址检查
- [x] JavaScript 测试和 LeanSpec 严格检查通过

## Notes

官方文档确认 Qwen3.8 的 ASR 始终开启，原文增量使用 `conversation.item.input_audio_transcription.delta`，通过 `previous_item_id` 关联译文。参考 [客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events) 与 [服务端事件](https://help.aliyun.com/zh/model-studio/live-translator-server-events)。真实通话与目标设备安装不以模拟测试替代。功能实现阶段未创建 Release；后续应用户要求，准备以 v0.10.4 创建 Release 草稿，由用户手动触发构建。

验收：261 项 JavaScript 测试全部通过；浏览器预览实际验证双语开关、设置同步以及项目/反馈链接。匿名 GitHub latest API 返回当前正式 v0.10.3，CORS 允许 WebView 访问。JSON、依赖锁一致性、cargo metadata --offline --locked、Git 空白及 LeanSpec 严格检查通过。真实 Rust 测试尝试被本机第三方 screencapturekit 1.5.4 Swift 编译错误阻止（CoreVideo.swift:200 IOSurface 转 IOSurfaceRef），尚未进入应用测试；没有关闭原生能力或修改第三方依赖。没有使用真实 API/会议音频、没有重新打包或发布。
