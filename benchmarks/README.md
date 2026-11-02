# 基准测试

**简体中文** · [English](README.en.md)

> 本目录保留特定日期、模型和样本的历史测量，不代表当前服务的性能保证。当前功能见[项目介绍](../README.md)。

用于翻译引擎延迟测量的独立脚本，不参与应用构建。

## benchmark-soniox-endpoint-delay.cjs

遍历 Soniox 的 `max_endpoint_delay_ms`（300 / 1000 / 3000），区分翻译延迟中可调部分和 API 本身的延迟。

**当时的结果：** 调整端点延迟几乎不影响首个最终译文的延迟（约 3.8–4.1 秒），主要改变分段粒度。测得的 2–3 秒滞后来自 Soniox ASR 最终确认，翻译步骤本身的原文 → 译文间隔约为 80ms。完整分析见[三引擎延迟与 Soniox 端点调参报告](benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.md)。

## 运行

```bash
cd benchmarks
npm install ws            # 唯一依赖
# 创建 .env.local，填写 SONIOX_API_KEY=...
node benchmark-soniox-endpoint-delay.cjs
```

需要 16kHz、单声道、s16le PCM 样本。默认读取 `../live-test/hope-v2-trim-16k.pcm`，这是被 Git 忽略的开发文件；可覆盖路径：

```bash
BENCH_PCM_16K=/path/to/your-16k.pcm node benchmark-soniox-endpoint-delay.cjs
```

`.env.local` 和 `results/` 已被 Git 忽略，请勿提交密钥或原始转写内容。
