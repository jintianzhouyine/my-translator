import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { AudioFileTranslation, audioFileConfig, exportAudioFileText } from '../src/js/audio-file-translation.js';

const settings = { qwen_api_key: 'test', qwen_workspace_id: 'space', qwen_region: 'cn-beijing', qwen_glossary_inbound: { hello: '你好' } };
const options = { targetLanguage: 'zh', glossaryDirection: 'inbound', parallelism: 1, maxRetries: 0 };
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return {promise,resolve,reject}; }
function fixture(overrides = {}) {
    const snapshots = [], sent = [], sleeps = [], disposed = [];
    let finish;
    const client = {
        async connect(cfg) { this.config = cfg; },
        async sendAudio(bytes) { sent.push(bytes); },
        async finish() {
            this.onSegment('Hello', '你好', { itemId: 't', startMs: 0, endMs: 200 });
            this.onClosed('finished');
            if (finish) await finish();
        },
        async disconnect() { this.disconnects = (this.disconnects || 0) + 1; },
    };
    const audio = name => ({ fileName: name, duration: 0.15, sampleRate: 16000, totalSamples: 2400,
        audioUrl: `blob:${name}`, pcmChunk(start,count) { return new Uint8Array(count * 2).fill(1); },
        dispose() { disposed.push(name); } });
    const controller = new AudioFileTranslation({ decode: async file => audio(file.name), createClient: () => client,
        onChange: snapshot => snapshots.push(snapshot), sleep: async ms => sleeps.push(ms), now: () => 0, ...overrides });
    return { controller, client, snapshots, sent, sleeps, disposed, audio, setFinish: fn => { finish = fn; } };
}

test('file selection is local, uses one text-only Qwen stream and paces full plus partial PCM chunks', async () => {
    const f = fixture();
    await f.controller.choose({ name: 'meeting.wav' });
    assert.equal(f.client.config, undefined);
    await f.controller.start(settings, options);
    assert.equal(f.client.config.audioOutput, false);
    assert.equal(f.client.config.turnDetection, 'server_vad');
    assert.equal(f.client.config.finishTimeoutMs, 30000);
    assert.deepEqual(f.client.config.phrases, {hello:'你好'});
    assert.deepEqual(f.sent.slice(0,2).map(bytes => bytes.length), [3200,1600]);
    assert.deepEqual(f.sleeps.slice(0,2), [100,50]);
    assert.equal(f.sent.length, 12, 'file plus one second of silent VAD tail');
    assert.ok(f.sent.slice(2).every(bytes => bytes.every(byte => byte === 0)));
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.controller.snapshot.segments.map(s => [s.startMs,s.endMs]), [[0,150]], 'tail is never exported past file end');
    assert.equal(f.controller.busy, false);
});

test('target and dictionary validation does not erase a previous result or open a connection', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    await f.controller.start(settings, options);
    const previous = f.controller.snapshot;
    await assert.rejects(f.controller.start({}, options), /设置/);
    assert.equal(f.controller.snapshot, previous);
    assert.throws(() => audioFileConfig(settings, {targetLanguage:'xx'}), /目标语言/);
    assert.throws(() => audioFileConfig(settings, {...options,glossaryDirection:'bad'}), /词典/);
    const cfg = audioFileConfig(settings, options); cfg.phrases.hello = 'changed';
    assert.equal(settings.qwen_glossary_inbound.hello, '你好');
});

test('failed or cancelled replacement decode keeps previous audio and captions, disposing late cancelled output', async () => {
    const f = fixture(); await f.controller.choose({name:'old.wav'}); await f.controller.start(settings, options);
    f.controller.decode = async () => { throw new Error('bad format'); };
    await f.controller.choose({name:'bad.wav'});
    assert.equal(f.controller.snapshot.fileName, 'old.wav');
    assert.equal(f.controller.snapshot.segments.length, 1);
    assert.equal(f.disposed.length, 0);
    const pending = deferred(); f.controller.decode = () => pending.promise;
    const replacing = f.controller.choose({name:'late.wav'});
    await f.controller.cancel(); pending.resolve(f.audio('late.wav')); await replacing;
    assert.deepEqual(f.disposed, ['late.wav']);
    assert.equal(f.controller.snapshot.fileName, 'old.wav');
    assert.equal(f.controller.snapshot.state, 'completed');
});

test('successful replacement releases the old file only after the new preview is published', async () => {
    const f = fixture(); await f.controller.choose({name:'old.wav'}); await f.controller.start(settings, options);
    await f.controller.choose({name:'new.wav'});
    assert.deepEqual(f.disposed, ['old.wav']);
    assert.equal(f.controller.snapshot.fileName, 'new.wav');
    assert.equal(f.controller.snapshot.segments.length, 0);
});

test('late timing and source corrections update one row; missing timestamps remain missing', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    f.client.finish = async () => {
        f.client.onSegment('', '译文', {itemId:'t'});
        f.client.onSegment('原文', '译文', {itemId:'t',startMs:30,endMs:120});
        f.client.onSegment('未对齐', 'Untimed', {itemId:'u'});
    };
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.segments.length, 2);
    assert.equal(f.controller.snapshot.segments[0].sourceText, '原文');
    assert.equal(f.controller.snapshot.segments[0].startMs, 30);
    assert.equal(f.controller.snapshot.segments[1].startMs, null);
    assert.match(f.controller.snapshot.message, /1 段未返回完整时间戳/);
    assert.throws(() => exportAudioFileText(f.controller.snapshot.segments,{format:'srt'}), /时间戳/);
    assert.match(exportAudioFileText(f.controller.snapshot.segments,{format:'txt'}), /Untimed/);
});

test('finish errors preserve partial text and never report completion', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    f.setFinish(async () => { throw new Error('finish timeout'); });
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.equal(f.controller.snapshot.segments.length, 1);
    assert.match(f.controller.snapshot.parts[0].error, /finish timeout/);
});

test('multiple target items for one source utterance become one timed subtitle cue', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    f.client.finish = async () => {
        for (const [itemId,text] of [['t1','第一部分'],['t2','第二部分']]) {
            f.client.onSegment('Full source',text,{itemId,sourceItemId:'s1',startMs:0,endMs:150});
        }
    };
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.segments.length,1);
    assert.equal(f.controller.snapshot.segments[0].text,'第一部分\n第二部分');
    assert.equal(exportAudioFileText(f.controller.snapshot.segments,{format:'srt'}).match(/ --> /g).length,1);
});

test('transport error cancels paced sending and preserves its reason', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    f.client.sendAudio = async () => f.client.onError('network','连接失败');
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.match(f.controller.snapshot.parts[0].error, /连接失败/);
    assert.equal(f.sleeps.length, 0);
});

test('user cancellation interrupts a paced send and ignores subsequent provider results', async () => {
    const sleeping = deferred();
    const f = fixture({ sleep: (_ms, signal) => new Promise((resolve,reject) => {
        sleeping.resolve(); signal.addEventListener('abort', () => reject(new Error('abort')), {once:true});
    }) });
    await f.controller.choose({name:'x.wav'});
    const running = f.controller.start(settings, options); await sleeping.promise;
    await f.controller.cancel();
    f.client.onSegment('late','迟到',{itemId:'late',startMs:0,endMs:50});
    await running;
    assert.equal(f.sent.length, 1);
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.equal(f.controller.snapshot.segments.length, 0);
    assert.equal(f.controller.busy, false);
});

test('unexpected close before EOF cannot turn silently dropped audio into success', async () => {
    const f = fixture(); await f.controller.choose({name:'x.wav'});
    f.client.sendAudio = async () => f.client.onClosed('finished');
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.match(f.controller.snapshot.parts[0].error, /提前关闭/);
});

test('cancelling during part cleanup reaches a terminal state after cleanup completes', async () => {
    for (const terminal of ['completed','error']) {
        const closing = deferred(), entered = deferred();
        const f = fixture(); await f.controller.choose({name:'x.wav'});
        if (terminal === 'error') f.client.connect = async () => { throw new Error('bad key'); };
        f.client.disconnect = () => { entered.resolve(); return closing.promise; };
        const running = f.controller.start(settings,options);
        await entered.promise;
        const cancelling = f.controller.cancel(); closing.resolve(); await cancelling; await running;
        assert.equal(f.controller.snapshot.state,'cancelled');
        assert.equal(f.controller.busy,false);
    }
});

test('exports preserve source timeline, sort cues and produce UTF-8-ready SRT/VTT/bilingual text', () => {
    const segments = [
        {sourceText:'Second',text:'第二句',startMs:61234,endMs:62500},
        {sourceText:'<First>',text:'第一句 &',startMs:1250,endMs:2300},
    ];
    const srt = exportAudioFileText(segments,{format:'srt',content:'bilingual'});
    assert.match(srt, /^1\n00:00:01,250 --> 00:00:02,300\n&lt;First&gt;\n第一句 &amp;/);
    assert.match(srt, /2\n00:01:01,234 --> 00:01:02,500/);
    assert.match(exportAudioFileText(segments,{format:'vtt'}), /^WEBVTT\n\n1\n00:00:01\.250/);
    assert.equal(exportAudioFileText(segments,{format:'txt',content:'original'}), '<First>\n\nSecond\n');
    assert.equal(segments[0].text,'第二句', 'export does not mutate source ordering');
    assert.throws(() => exportAudioFileText([{text:'x',startMs:0,endMs:1}],{format:'txt',content:'original'}), /缺少/);
    assert.throws(() => exportAudioFileText([{text:'x',startMs:1,endMs:1}],{format:'srt'}), /时间戳/);
});
