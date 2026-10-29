---
status: complete
created: 2026-10-29
priority: medium
tags:
- release
- windows
- reliability
created_at: 2026-10-29T05:19:08.926040Z
updated_at: 2026-10-29T05:50:20.874416Z
completed_at: 2026-10-29T05:50:20.874416Z
transitions:
- status: complete
  at: 2026-10-29T05:50:20.874416Z
---

# 修复 Windows 语音库准备超时与进度

## Overview

v0.10.1 的 Windows x64 构建在语音库准备阶段长时间无输出，前一轮等待 47 分钟后被取消。
脚本未区分下载与解压阶段，也没有下载或解压级别的等待上限。
用户要求修复后由助手触发构建并完成发布，先以 v0.10.2 增强诊断，最终修复版本为 v0.10.3。

## Design

- 保留 sherpa-onnx 1.13.3 x64 static-MD 库，维持 Windows 动态 CRT 配置。
- 增加下载/解压开始、耗时及周期进度日志；curl 下载具备连接、低速和整体超时，最多尝试三次。
- 使用官方资产大小及 SHA256 校验下载，解压采用有界子进程并检查必需库。
- Windows 解压改用预装 7-Zip，分别解开 bzip2 和 tar，每阶段独立 180 秒截止并输出心跳。
- 完成标记与必需文件均有效时复用缓存；失败不会把不完整目录当成可用缓存。
- 将依赖准备步骤限制在 25 分钟内，并保存成功准备的依赖缓存。
- 同步 v0.10.3 版本号和发布说明，提交/tag 后主动触发并检查 CI。

## Plan

- [x] 实现有日志、有边界的语音库准备与缓存
- [x] 添加下载、校验、缓存和子进程超时回归测试
- [x] 更新工作流、版本和文档
- [x] 提交推送并触发 v0.10.2 构建
- [x] 使用 7-Zip 修复实际解压停滞并触发 v0.10.3 构建
- [x] 确认两个平台构建及 Release 发布成功

## Test

- [x] 新增测试和应用测试通过
- [x] actionlint、版本一致性和 LeanSpec 严格校验通过
- [x] Windows 实际 CI 越过语音库准备步骤，日志可见
- [x] Mac ARM64 / Windows x64 安装包和校验文件上传成功

## Notes

本次不改变翻译模型或应用功能。代码和模拟测试只能验证失败处理，真实下载与打包以 CI 结果为准。

本地验证：234 项 JavaScript 测试通过，其中新增 13 项语音库准备回归测试；actionlint 1.7.12、Git 空白及六处版本一致性检查通过。单次下载 curl 总时限 300 秒、父进程硬截止 315 秒，解压硬截止 180 秒，日志心跳间隔 15 秒。

已推送提交 c83be44 和 v0.10.2 tag，并创建 Release 草稿。已由助手触发 GitHub Actions： https://github.com/jintianzhouyine/my-translator/actions/runs/40823382905 。

v0.10.2 实际 CI 的下载和 SHA256 校验很快完成；tar.exe 解压持续输出心跳后在 180 秒硬截止被终止，确认问题位于解压阶段。继续使用 v0.10.3 修复，不移动已有 tag。

7-Zip 修正后的本地验证：241 项 JavaScript 测试通过（语音库准备测试共20项），覆盖两阶段解压及任一步失败/超时的清理；actionlint 和 LeanSpec 严格校验通过。Windows 原始日志记录约3.4秒完成下载、校验通过，tar/bzip2 链路在180秒截止时终止。

v0.10.3 已推送提交 93307ed 和对应 tag，构建已触发： https://github.com/jintianzhouyine/my-translator/actions/runs/40824303689 。

v0.10.3 的 Windows CI 已成功完成语音库准备、缓存保存和 JavaScript 测试，进入 Rust 原生测试/编译阶段；解压停滞问题已在真实 Windows runner 上消除。

真实 Windows runner 的语音库准备耗时 12 秒（05:36:32–05:36:44 UTC），随后原生测试通过，进入安装包构建。macOS Apple Silicon 构建已成功。

最终验收：v0.10.3 的 Mac ARM64 与 Windows x64 构建均成功，Release 于 2026-10-29 05:49:32 UTC 正式发布，包含两个安装包及 SHA256SUMS。发布地址：https://github.com/jintianzhouyine/my-translator/releases/tag/v0.10.3 。未执行目标设备上的安装及真实通话验收。
