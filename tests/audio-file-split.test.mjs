import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioSplitPoints, planAudioSegments } from '../src/js/audio-file-split.js';

test('automatic twenty-minute segments cover long sources and retain the final remainder', () => {
    assert.deepEqual(planAudioSegments(2700), [
        { id: 'part-1', startMs: 0, endMs: 1200000, duration: 1200 },
        { id: 'part-2', startMs: 1200000, endMs: 2400000, duration: 1200 },
        { id: 'part-3', startMs: 2400000, endMs: 2700000, duration: 300 },
    ]);
    assert.deepEqual(planAudioSegments(12.345), [{ id: 'part-1', startMs: 0, endMs: 12345, duration: 12.345 }]);
    assert.equal(planAudioSegments(1200).length, 1, 'exact multiples never append an empty segment');
    assert.equal(planAudioSegments(2400).length, 2);
});

test('manual points accept seconds and clock times, sort without mutating callers, and cover endpoints', () => {
    const points = parseAudioSplitPoints('00:20:00, 600\r\n\r\n 05:00\r00:15:00', 1800);
    assert.deepEqual(points, [300, 600, 900, 1200]);
    assert.deepEqual(parseAudioSplitPoints('90:00，1:00:00.125\n.5', 7200), [0.5, 3600.125, 5400]);
    const unsorted = Object.freeze([1200, 600]);
    const planned = planAudioSegments(1800, { boundaries: unsorted });
    assert.deepEqual(planned.map(part => [part.startMs, part.endMs]), [[0, 600000], [600000, 1200000], [1200000, 1800000]]);
    assert.deepEqual(unsorted, [1200, 600]);
});

test('empty manual input is explicit and cannot quietly create an oversized segment', () => {
    assert.deepEqual(parseAudioSplitPoints('\r\n  \n', 1200), []);
    assert.equal(planAudioSegments(1500, { boundaries: [] }).length, 1);
    assert.equal(planAudioSegments(1500).length, 2, 'automatic twenty-minute mode remains distinct');
    assert.throws(() => planAudioSegments(1801, { boundaries: [] }), /第 1 段超过 30 分钟/);
    assert.throws(() => planAudioSegments(4000, { boundaries: [1000, 3000] }), /第 2 段超过 30 分钟/);
    assert.throws(() => planAudioSegments(4000, { boundaries: [1000, 2000] }), /第 3 段超过 30 分钟/);
});

test('clock parsing rejects malformed fields without interpreting them as a different timestamp', () => {
    for (const text of ['1:60', '1:60:00', '1:02:60', '1::02', ':20', '1:2:3:4',
        '1: 02', '-1', '+10', '1e3', 'Infinity', 'NaN', '10.', 'word', '1.2.3']) {
        assert.throws(() => parseAudioSplitPoints(text, 7200), /第 1 行.*无效/, text);
    }
    assert.throws(() => parseAudioSplitPoints('100\n12:60', 7200), /第 2 行/);
    assert.throws(() => parseAudioSplitPoints('10,,20', 60), /空分割点/);
    assert.throws(() => parseAudioSplitPoints('10,', 60), /空分割点/);
    assert.deepEqual(parseAudioSplitPoints('60', 120), [60], 'plain seconds may exceed the clock seconds field');
});

test('duplicate, out-of-range and sample-colliding boundaries are refused', () => {
    for (const text of ['0', '60', '61', '10,00:10', '0.00007,0.00008']) {
        assert.throws(() => parseAudioSplitPoints(text, 60), /大于 0|重复|重合/);
    }
    assert.throws(() => parseAudioSplitPoints('0.00001', 60), /空片段/);
    assert.throws(() => parseAudioSplitPoints('59.99999', 60), /空片段/);
    for (const boundaries of [null, '10', [NaN], [Infinity], ['10'], [0], [60], [10, 10]]) {
        assert.throws(() => planAudioSegments(60, { boundaries }));
    }
});

test('fractional points are normalized once to the 16 kHz source timeline without gaps or overlaps', () => {
    const duration = 2.1234567;
    const points = parseAudioSplitPoints('0.10004,1.00004,2.00004', duration);
    assert.deepEqual(points, [1601 / 16000, 16001 / 16000, 32001 / 16000]);
    const plans = [planAudioSegments(duration, { boundaries: points }), planAudioSegments(duration, { segmentSeconds: 0.10004 })];
    for (const parts of plans) {
        assert.equal(parts[0].startMs, 0);
        assert.equal(parts.at(-1).endMs * 16, Math.round(duration * 16000));
        let totalSamples = 0;
        for (const [index, part] of parts.entries()) {
            assert.ok(Number.isInteger(part.startMs * 16));
            assert.ok(Number.isInteger(part.endMs * 16));
            assert.ok(part.endMs > part.startMs);
            assert.equal(part.id, `part-${index + 1}`);
            if (index) assert.equal(part.startMs, parts[index - 1].endMs);
            assert.equal(Math.round(part.duration * 16000), (part.endMs - part.startMs) * 16);
            totalSamples += Math.round(part.duration * 16000);
        }
        assert.equal(totalSamples, Math.round(duration * 16000));
    }
});

test('the whole-source and per-segment limits include exact boundaries', () => {
    const wholeDay = planAudioSegments(24 * 60 * 60);
    assert.equal(wholeDay.length, 72);
    assert.equal(wholeDay.at(-1).endMs, 86400000);
    assert.equal(planAudioSegments(3600, { segmentSeconds: 1800 }).length, 2);
    assert.throws(() => planAudioSegments(86400.00001), /24 小时/);
    assert.throws(() => parseAudioSplitPoints('10', 86401), /24 小时/);
    for (const segmentSeconds of [0, -1, NaN, Infinity, '1200', 1800.00001]) {
        assert.throws(() => planAudioSegments(60, { segmentSeconds }), /大于 0.*30 分钟/);
    }
});

test('500 segments are allowed, overflow is rejected before allocating a huge plan', () => {
    assert.equal(planAudioSegments(500, { segmentSeconds: 1 }).length, 500);
    assert.throws(() => planAudioSegments(501, { segmentSeconds: 1 }), /超过 500 段/);
    const points = Array.from({ length: 499 }, (_, index) => index + 1);
    assert.equal(planAudioSegments(500, { boundaries: points }).length, 500);
    assert.throws(() => planAudioSegments(501, { boundaries: [...points, 500] }), /500 段/);
    assert.throws(() => parseAudioSplitPoints([...points, 500].join(','), 501), /500 段/);
    assert.throws(() => planAudioSegments(86400, { segmentSeconds: 1 / 16000 }), /500 段/);
});

test('invalid and shorter-than-one-sample durations cannot produce empty or infinite plans', () => {
    for (const duration of [undefined, null, 0, -1, NaN, Infinity, '60']) {
        assert.throws(() => planAudioSegments(duration), /音频时长/);
        assert.throws(() => parseAudioSplitPoints('', duration), /音频时长/);
    }
    assert.throws(() => planAudioSegments(0.00001), /采样点/);
    assert.throws(() => planAudioSegments(1, { segmentSeconds: 0.00001 }), /采样点/);
    assert.equal(planAudioSegments(1 / 16000)[0].endMs, 0.0625);
    assert.throws(() => parseAudioSplitPoints(100, 120), /文本/);
});
