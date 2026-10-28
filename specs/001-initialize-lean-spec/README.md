---
status: complete
created: 2026-10-28
priority: medium
tags:
- tooling
- documentation
created_at: 2026-10-28T11:23:30.935072Z
updated_at: 2026-10-28T11:28:07.575057Z
completed_at: 2026-10-28T11:28:07.575057Z
transitions:
- status: complete
  at: 2026-10-28T11:28:07.575057Z
---

# 初始化 LeanSpec 项目规范

## Overview

为现有 My Translator 项目建立轻量的需求和实施记录，方便后续功能先明确范围、设计和验收条件。
本次只初始化项目协作文件；现有功能说明继续维护在 docs/，不改变应用行为。

## Design

- 使用已安装的 LeanSpec 0.2.26 标准初始化，规范保存在 specs/，配置与模板位于 .lean-spec/。
- 根目录 AGENTS.md 记录技术栈、代码目录、开发命令和中文协作流程。
- 保留 Overview / Design / Plan / Test / Notes 结构，模板提示使用中文。
- 通过 CLI 管理元数据；依赖关系使用当前版本的 rel add / rel rm 命令。
- 使用 CLI 集成，不增加应用依赖，不配置全局 MCP 或安装额外 skill。
- 参考 [Qwen 双向通话](../../docs/qwen-duplex.md)、
  [音频文件翻译](../../docs/audio-file-translation.md) 和
  [v0.10.0 发布说明](../../docs/releases/v0.10.0.md)。

## Plan

- [x] 执行标准初始化，生成配置、模板与规范目录
- [x] 补充中文项目上下文、开发命令和规范工作流
- [x] 修正模板中的旧命令，并添加 README 导航
- [x] 验证模板生成、状态流转和规范校验

## Test

- [x] 使用临时目录验证中文模板能创建规范并完成状态流转
- [x] lean-spec validate --strict --check-deps 无错误或警告
- [x] lean-spec board / list / view 能识别初始化记录
- [x] git diff --check 通过，文档相对链接有效

## Notes

本次仅变更文档和 LeanSpec 配置，因此验证重点为 CLI 与文档完整性，不重跑应用构建。