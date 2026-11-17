---
status: in-progress
created: 2026-11-17
priority: medium
created_at: 2026-11-17T09:37:22.486357Z
updated_at: 2026-11-17T09:37:22.586730Z
transitions:
- status: in-progress
  at: 2026-11-17T09:37:22.586730Z
---

# 实时翻译断线恢复与运行状态修复

## Overview

修复实时翻译自行结束，以及界面仍在运行但翻译已停止、只能重新开关的问题。覆盖 Soniox、Qwen、OpenAI 的连接生命周期及传统音频采集的异常通知；文件翻译保持原有重试与完成确认规则。

## Design

- 临时传输故障有限退避重连（最多 3 次）；鉴权、余额、配置等错误不自动重试。手动停止取消计时器、握手及迟到回调。
- Qwen 按方向恢复，维持采集、设备路由及另一方向；重连后字幕 ID 加连接代次，避免覆盖已有句子。OpenAI 由单个客户端管理重连，避免重复启动采集。
- Soniox 的服务端正常关闭和 finished 也触发恢复；握手超时、发送失败/积压有界处理，轮换失败保留可用旧连接。
- 原生 OpenAI 只发送一次终止事件，连接和写入有超时；Qwen/OpenAI 检查传输心跳，不以无字幕或静音判定故障。
- 传统 start_capture 接受可选 onError 通道，设备采集结束显式通知 UI；暂停等待未结束的原生启动，再次清理迟到资源。
- 双向通话译音突发由原先超过 5 秒立即结束整通，改为 30 秒有界缓冲；超量跳过旧译音并提示，字幕和原声继续，真实设备故障仍清理并报错。原生 write_translation_audio 返回 bool 表示发生裁剪。
- 恢复只处理新音频，不缓存或补播断线期间声音。说明见 [实时字幕](../../docs/live-subtitles.md)。

## Plan

- [x] 三个实时云引擎的恢复、取消与旧回调隔离
- [x] 前端运行状态与音频启动/停止生命周期同步
- [x] 修复正常长句译音突发触发整通停止
- [x] 原生连接、音频采集异常通知与有界译音缓冲实现
- [x] 更新中英文使用说明

## Test

- [x] Node 24 执行 `scripts/test.mjs`：330 项全部通过。包含 Soniox 12 项、OpenAI 客户端 17 项、App 生命周期 8 项，以及 Qwen 双向恢复、取消、长句突发/积压等场景。
- [x] 原生隔离测试 20 项通过：混音 13 项、采集转发 4 项、心跳 3 项。混音仅移除 serde 注解，采集转发原样提取；心跳将 tokio 的 Instant 替换为 std 的 Instant，保留实现和断言。临时验证记录位于 `/tmp/my-translator-rust-check/logic-tests/README.txt`。
- [x] 8 个变更 Rust 文件 `rustfmt --check`、`git diff --check` 和 `lean-spec validate --strict --check-deps` 通过。
- [ ] 完整 `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`：crates.io 持续 0 bytes 超时，离线缓存缺少 chrono，尚未完成；本机 WebSocket 集成测试已编写但因此未执行。
- [ ] Windows 构建及真实会议设备长时间验收；本次未生成安装包，规范保留 in-progress。

## Notes

用户已确认 Windows 实时翻译并开启双向通话，未注意错误提示；当时安装版无落盘故障日志，后续新增日志见 [007](../007-diagnostic-logs/README.md)。本次依据代码中可复现的故障路径修复，不把模拟服务等同于真实云端/会议设备长时间验收。

版本交付为 [v0.10.7](../../docs/releases/v0.10.7.md)：按用户要求提交并推送代码与新 tag、创建 Release 草稿；构建由用户手动触发。完整原生与目标设备验证仍未完成，保持 in-progress。

Windows 通话仍绑定启动时选定的物理播放设备。会议软件中途换到另一个仍有效的播放端时，需要重新选择/开始；本次不依据静音擅自切换默认设备。
