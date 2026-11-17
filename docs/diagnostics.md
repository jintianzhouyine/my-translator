# 诊断日志

[中文](diagnostics.md) · [English](diagnostics.en.md) · [文档目录](README.md)

打开 **设置 → 关于 → 诊断日志 → 打开日志目录**，即可在 Windows 文件资源管理器或 macOS Finder 中查看日志。界面也显示实际目录，可选中复制。

默认目录是应用数据目录中的 `logs`：

- Windows：`%APPDATA%\com.personal.translator\logs`
- macOS：`~/Library/Application Support/com.personal.translator/logs`

文件按本机日期命名，例如 `translator-2026-11-17.log`；事件时间包含本机时区。自动保留**今天及前 6 天**，共 7 个日期的日志。启动、跨日写入、打开日志目录及每小时维护时清理旧日志。应用关闭期间不运行清理，下次启动补做。

每日日志最多 5 MiB，达到上限后写入一条限制提示，当天不再追加，下一天恢复。清理只处理本应用生成的 `translator-YYYY-MM-DD.log` 普通文件，不删除其他文件、文件夹或符号链接。

日志记录应用版本、操作系统、翻译启停、引擎、连接状态、重连次数及错误类别。`live_paused reason=requested` 表示主动暂停或切换操作；`reason=auto_failure` 表示故障触发暂停；`retry_scheduled` 表示安排重连。`timeout`、`network`、`capture`、`output`、`backpressure` 分别表示超时、网络、采集、输出及队列积压类别。

不保存 API 密钥、完整设置、字幕、录音、音频数据、文件路径或原始服务端错误正文；错误仅保留预定义类别，因此未知故障可能显示 `unknown`。日志写入失败不会打断翻译。

再次遇到翻译中断时，记下大概时间，通过上述入口找到当天 `.log` 文件即可提供排查。若问题跨过午夜，可一并提供前一天的文件。无需发送设置文件或录音。
