# Benchmarks

[简体中文](README.md) · **English**

> These are historical measurements for the models, dates and samples in the reports, not current service guarantees. See the [current project overview](../README.en.md) for current features.

Standalone latency benchmarks for the translation engines. Not part of the app build.

## benchmark-soniox-endpoint-delay.cjs

Sweeps Soniox `max_endpoint_delay_ms` (300 / 1000 / 3000) to quantify how much
of the translation lag is tunable vs an API floor.

**Finding:** endpoint delay barely changes first-final latency (~3.8-4.1s); it
only changes segment granularity. The 2-3s lag is Soniox ASR finalize, not the
translation step (orig→trans gap is ~80ms). Full analysis:
[benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.md](benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.en.md).

### Run

```bash
cd benchmarks
npm install ws            # only dependency
# create .env.local with: SONIOX_API_KEY=...
node benchmark-soniox-endpoint-delay.cjs
```

Requires a 16kHz mono PCM s16le sample. By default reads
`../live-test/hope-v2-trim-16k.pcm` (gitignored dev artifact); override with:

```bash
BENCH_PCM_16K=/path/to/your-16k.pcm node benchmark-soniox-endpoint-delay.cjs
```

`.env.local` and `results/` are gitignored — never commit keys or raw transcripts.
