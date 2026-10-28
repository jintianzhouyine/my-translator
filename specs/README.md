# 项目需求规范

本目录用 LeanSpec 记录 My Translator 后续功能的需求、设计、实施计划和验收结果。
现有功能说明继续维护在 `docs/`，不批量转换为历史 spec。

## 使用方式

本次使用已安装的 `lean-spec 0.2.26` 初始化。从仓库根目录运行：

```bash
lean-spec board
lean-spec search "关键词"
lean-spec create my-feature --title "功能名称"
lean-spec update <spec> --status in-progress
lean-spec view <spec>
lean-spec validate --strict --check-deps
lean-spec update <spec> --status complete
```

未安装 CLI 的开发者可使用 `npx lean-spec@0.2.26 <命令>` 运行同一版本。
项目无需增加运行时依赖，CLI 即可完成全部规范管理。

## 目录与状态

每个规范位于 `编号-英文名称/README.md`，正文使用中文。
用 `lean-spec create` 生成编号与元数据，用 `lean-spec update` 管理状态；正文可直接编辑。

- `planned`：待实施，默认状态。
- `in-progress`：正在实施。
- `complete`：实现和验收已完成。
- `archived`：已归档。

当前配置关闭 `draft` 状态。只在多步骤功能、行为变更或重要设计决策时创建 spec；
简单修复、文字调整通常不需要。普通参考资料用 Markdown 链接，真正阻塞实施的规范用
`lean-spec rel add <spec> --depends-on <other>` 建立依赖。

## 配置与已有文档

- [项目协作说明](../AGENTS.md)：技术栈、开发命令与工作流程。
- [LeanSpec 配置](../.lean-spec/config.json)：目录、状态和长度限制。
- [规范模板](../.lean-spec/templates/spec-template.md)：Overview / Design / Plan / Test / Notes。
- [Qwen 双向通话](../docs/qwen-duplex.md)。
- [音频文件翻译](../docs/audio-file-translation.md)。
- [v0.10.0 发布说明](../docs/releases/v0.10.0.md)。
