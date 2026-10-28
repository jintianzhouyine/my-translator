import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAudioSource } from '../src/js/audio-file-native.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides = {}) {
    const calls = [];
    const open = createNativeAudioSource({ convertFileSrc: (id, protocol) => `${protocol}://localhost/${id}`,
        invoke: async (command,args) => {
            calls.push({command,args});
            if (overrides[command]) return await overrides[command](args);
            if (command === 'audio_file_open_source') return {id:'source-token',fileName:'long.wav',duration:4000,fileSize:400000000};
            if (command === 'audio_file_prepare_part') return {id:'part-token',sampleRate:16000,totalSamples:16000};
            if (command === 'audio_file_read_part') return [0,1,2,3];
            return null;
        } });
    return {open,calls};
}

test('native source exposes only a scoped token URL and prepares/reads a bounded part on demand', async () => {
    const f = fixture(); const source = await f.open();
    assert.equal(source.audioUrl,'audio-source://localhost/source-token');
    assert.equal(f.calls.length,1, 'selection must not decode or translate');
    const part = await source.preparePart({startMs:1200000,endMs:1201000});
    assert.deepEqual(f.calls[1].args,{id:'source-token',startMs:1200000,endMs:1201000});
    assert.deepEqual(await part.pcmChunk(0,2),new Uint8Array([0,1,2,3]));
    assert.deepEqual(f.calls.at(-1).args,{id:'source-token',partId:'part-token',startSample:0,count:2});
    await part.dispose(); await part.dispose(); await source.dispose(); await source.dispose();
    assert.equal(f.calls.filter(c=>c.command==='audio_file_release_part').length,1);
    assert.equal(f.calls.filter(c=>c.command==='audio_file_close_source').length,1);
    await assert.rejects(part.pcmChunk(0,1),{name:'AbortError'});
});

test('cancelling a native dialog does not create a source or issue decoder commands', async () => {
    const f = fixture({audio_file_open_source:()=>null});
    assert.equal(await f.open(),null); assert.equal(f.calls.length,1);
});

test('late native selection after cancellation closes its new handle', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await assert.rejects(f.open({signal:abort.signal}),{name:'AbortError'});
    assert.equal(f.calls.at(-1).command,'audio_file_close_source');
});

test('cancelling preparation kills native work and releases any late prepared file', async () => {
    const prepared = deferred();
    const f = fixture({audio_file_prepare_part:()=>prepared.promise});
    const source = await f.open(); const abort = new AbortController();
    const pending = source.preparePart({startMs:0,endMs:1000},{signal:abort.signal});
    abort.abort(); prepared.resolve({id:'late',sampleRate:16000,totalSamples:16000});
    await assert.rejects(pending,{name:'AbortError'});
    assert.equal(f.calls.filter(c=>c.command==='audio_file_cancel_prepare').length,1);
    assert.deepEqual(f.calls.at(-1),{command:'audio_file_release_part',args:{id:'source-token',partId:'late'}});
    await source.dispose();
});

test('aborting a read never forwards late PCM into the provider', async () => {
    const read = deferred(); const f = fixture({audio_file_read_part:()=>read.promise});
    const source = await f.open(); const abort = new AbortController();
    const part = await source.preparePart({startMs:0,endMs:1000},{signal:abort.signal});
    const pending = part.pcmChunk(0,2); abort.abort(); read.resolve([0,0,0,0]);
    await assert.rejects(pending,{name:'AbortError'}); await part.dispose(); await source.dispose();
});
