import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareSpeechLibraries, runCommand, verifyArchive } from '../scripts/prepare-windows-speech.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const errorDetails = error => `${error.message}\n${error.cause?.message || ''}`;

async function fixture(t, platform = 'linux') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-translator-speech-setup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const archive = Buffer.from('small speech archive fixture\n');
    const artifact = {
        version: 'fixture',
        name: 'speech-fixture-win-x64-static-MD',
        url: 'https://example.invalid/speech-fixture.tar.bz2',
        size: archive.length,
        sha256: digest(archive),
        requiredLibraries: ['sherpa-onnx-c-api.lib', 'onnxruntime.lib'],
    };
    const cacheDir = path.join(root, 'cache');
    const envFile = path.join(root, 'github-env');
    const destination = path.join(cacheDir, artifact.name);
    const calls = [];
    const logs = [];
    const library = name => Buffer.from(`complete library fixture: ${name}\n`);
    const extract = async args => {
        const stageRoot = args.includes('-C') ? args[args.indexOf('-C') + 1] : args.find(arg => arg.startsWith('-o'))?.slice(2);
        assert.ok(stageRoot, 'Extraction must specify its staging directory');
        const libDir = path.join(stageRoot, artifact.name, 'lib');
        await fs.mkdir(libDir, { recursive: true });
        for (const name of artifact.requiredLibraries) {
            await fs.writeFile(path.join(libDir, name), library(name));
        }
    };
    const run = async (command, args, options) => {
        calls.push({ command, args, options });
        if (/^curl(?:\.exe)?$/i.test(path.basename(command))) {
            const output = args[args.indexOf('--output') + 1];
            assert.ok(output, 'Download must specify its output file');
            await fs.writeFile(output, archive);
        } else if (/^tar(?:\.exe)?$/i.test(path.basename(command))) {
            await extract(args);
        } else if (/^7z(?:\.exe)?$/i.test(path.basename(command))) {
            const stageRoot = args.find(arg => arg.startsWith('-o'))?.slice(2);
            assert.ok(stageRoot, '7-Zip must extract into its staging directory');
            if (args[1].endsWith('.tar.bz2')) {
                await fs.writeFile(path.join(stageRoot, 'speech.tar'), 'decompressed tar fixture');
            } else {
                assert.ok(args[1].endsWith('.tar'), 'Second stage must read a tar file');
                assert.equal(await fs.readFile(args[1], 'utf8'), 'decompressed tar fixture');
                await extract(args);
            }
        } else {
            assert.fail(`Unexpected command: ${command}`);
        }
    };
    const options = {
        cacheDir, envFile, artifact, run, platform,
        sevenZipCommand: path.join(root, 'tool path with spaces', '7z.exe'),
        log: text => logs.push(text), retryDelayMs: 0,
    };
    return { root, archive, artifact, cacheDir, envFile, destination, calls, logs, library, extract, run, options };
}

test('speech library download retries a failed request and only extracts a verified archive', async t => {
    const f = await fixture(t);
    let downloads = 0;
    const libDir = await prepareSpeechLibraries({
        ...f.options,
        run: async (command, args, options) => {
            if (/curl/i.test(command) && ++downloads === 1) throw new Error('Connection reset');
            return f.run(command, args, options);
        },
    });
    assert.equal(downloads, 2);
    assert.equal(f.calls.filter(call => /tar/i.test(call.command)).length, 1);
    assert.equal(libDir, path.join(f.destination, 'lib'));
    assert.equal(await fs.readFile(path.join(libDir, 'sherpa-onnx-c-api.lib'), 'utf8'),
        f.library('sherpa-onnx-c-api.lib').toString());
    assert.match(await fs.readFile(f.envFile, 'utf8'), /SHERPA_ONNX_LIB_DIR=/);
});

test('speech library download stops after three failed attempts without creating a completed cache', async t => {
    const f = await fixture(t);
    let attempts = 0;
    await assert.rejects(prepareSpeechLibraries({
        ...f.options,
        run: async () => { attempts += 1; throw new Error('Download timed out'); },
    }), error => /timed out/i.test(errorDetails(error)));
    assert.equal(attempts, 3);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
    await assert.rejects(fs.readFile(f.envFile), { code: 'ENOENT' });
});

for (const kind of ['size', 'checksum']) {
    test(`speech library setup rejects a bad archive ${kind} before extraction`, async t => {
        const f = await fixture(t);
        let downloads = 0;
        let extractions = 0;
        await assert.rejects(prepareSpeechLibraries({
            ...f.options,
            run: async (command, args) => {
                if (/curl/i.test(command)) {
                    downloads += 1;
                    const data = kind === 'size' ? f.archive.subarray(1) : Buffer.alloc(f.archive.length, 0x41);
                    await fs.writeFile(args[args.indexOf('--output') + 1], data);
                } else {
                    extractions += 1;
                    assert.fail('Corrupt archive must not be extracted');
                }
            },
        }), error => (kind === 'size' ? /size|length/i : /sha|checksum/i).test(errorDetails(error)));
        assert.equal(downloads, 3);
        assert.equal(extractions, 0);
        await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
        await assert.rejects(fs.readFile(f.envFile), { code: 'ENOENT' });
    });
}

test('speech library archive verification accepts matching bytes and rejects altered bytes', async t => {
    const f = await fixture(t);
    const file = path.join(f.root, 'test.tar.bz2');
    await fs.writeFile(file, f.archive);
    await verifyArchive(file, f.artifact);
    const changed = Buffer.from(f.archive);
    changed[0] ^= 1;
    await fs.writeFile(file, changed);
    await assert.rejects(verifyArchive(file, f.artifact), /sha|checksum/i);
});

for (const reason of ['tar exited with code 2', 'Extraction timed out']) {
    test(`speech library setup discards partial extraction after ${reason}`, async t => {
        const f = await fixture(t);
        await assert.rejects(prepareSpeechLibraries({
            ...f.options,
            run: async (command, args, options) => {
                if (/tar/i.test(command)) {
                    await f.extract(args);
                    throw new Error(reason);
                }
                return f.run(command, args, options);
            },
        }), error => error.message.includes(reason));
        await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
        await assert.rejects(fs.readFile(f.envFile), { code: 'ENOENT' });
        assert.deepEqual(await fs.readdir(f.cacheDir), [], 'Failed extraction staging directories must be removed');
    });
}

test('speech library cache hit skips network and extraction but exports its path for the new job', async t => {
    const f = await fixture(t);
    const libDir = await prepareSpeechLibraries(f.options);
    await fs.rm(f.envFile);
    const cachedLibDir = await prepareSpeechLibraries({
        ...f.options,
        run: async () => assert.fail('A verified cache must not spawn download or extraction'),
    });
    assert.equal(cachedLibDir, libDir);
    assert.equal((await fs.readFile(f.envFile, 'utf8')).trim(), `SHERPA_ONNX_LIB_DIR=${libDir}`);
});

for (const damage of ['missing library', 'same-size modified library', 'invalid marker']) {
    test(`speech library setup rebuilds cached artifacts with ${damage}`, async t => {
        const f = await fixture(t);
        const libDir = await prepareSpeechLibraries(f.options);
        const lib = path.join(libDir, f.artifact.requiredLibraries[0]);
        if (damage === 'missing library') await fs.rm(lib);
        if (damage === 'same-size modified library') {
            const bytes = await fs.readFile(lib);
            bytes[0] ^= 1;
            await fs.writeFile(lib, bytes);
        }
        if (damage === 'invalid marker') await fs.writeFile(path.join(f.destination, '.complete.json'), '{invalid json');
        f.calls.length = 0;
        await prepareSpeechLibraries(f.options);
        assert.equal(f.calls.filter(call => /curl/i.test(call.command)).length, 1);
        assert.equal(f.calls.filter(call => /tar/i.test(call.command)).length, 1);
        assert.deepEqual(await fs.readFile(lib), f.library(f.artifact.requiredLibraries[0]));
        await prepareSpeechLibraries({ ...f.options, run: async () => assert.fail('Rebuilt cache should be reusable') });
    });
}

test('Windows speech setup runs bounded 7-Zip decompression then extraction without invoking tar.exe', async t => {
    const f = await fixture(t, 'win32');
    const libDir = await prepareSpeechLibraries(f.options);
    const extraction = f.calls.filter(call => call.command === f.options.sevenZipCommand);
    assert.equal(extraction.length, 2);
    assert.ok(extraction[0].args[1].endsWith('speech.tar.bz2'));
    assert.ok(extraction[1].args[1].endsWith('speech.tar'));
    assert.ok(extraction[0].args.includes('-tbzip2'));
    assert.ok(extraction[1].args.includes('-ttar'));
    for (const call of extraction) {
        assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 180000,
            'Each extraction stage must have an independent hard deadline');
    }
    assert.equal(f.calls.filter(call => /^tar(?:\.exe)?$/i.test(path.basename(call.command))).length, 0);
    assert.equal(await fs.readFile(path.join(libDir, 'onnxruntime.lib'), 'utf8'), f.library('onnxruntime.lib').toString());
});

for (const stage of [1, 2]) {
    for (const reason of ['exited with code 2', 'timed out']) {
        test(`Windows speech setup removes partial files when 7-Zip stage ${stage} ${reason}`, async t => {
            const f = await fixture(t, 'win32');
            let extractionCalls = 0;
            await assert.rejects(prepareSpeechLibraries({
                ...f.options,
                run: async (command, args, options) => {
                    await f.run(command, args, options);
                    if (command === f.options.sevenZipCommand && ++extractionCalls === stage) {
                        throw new Error(`7-Zip stage ${stage} ${reason}`);
                    }
                },
            }), error => error.message.includes(`7-Zip stage ${stage} ${reason}`));
            assert.equal(extractionCalls, stage, 'Later stages must not run after a failed extraction stage');
            await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
            await assert.rejects(fs.readFile(f.envFile), { code: 'ENOENT' });
            assert.deepEqual(await fs.readdir(f.cacheDir), [], 'Both intermediate tar and extracted libraries must be removed');
        });
    }
}

test('Windows speech setup rejects an empty intermediate tar before starting its second stage', async t => {
    const f = await fixture(t, 'win32');
    let extractionCalls = 0;
    await assert.rejects(prepareSpeechLibraries({
        ...f.options,
        run: async (command, args, options) => {
            if (command === f.options.sevenZipCommand) {
                extractionCalls += 1;
                const stageRoot = args.find(arg => arg.startsWith('-o')).slice(2);
                await fs.writeFile(path.join(stageRoot, 'speech.tar'), '');
            } else {
                await f.run(command, args, options);
            }
        },
    }), /tar|empty/i);
    assert.equal(extractionCalls, 1);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.cacheDir), []);
});

test('Windows speech library cache skips both 7-Zip stages and still exports the path', async t => {
    const f = await fixture(t, 'win32');
    const libDir = await prepareSpeechLibraries(f.options);
    await fs.rm(f.envFile);
    const cachedLibDir = await prepareSpeechLibraries({
        ...f.options,
        run: async () => assert.fail('A verified Windows cache must not invoke curl or either 7-Zip stage'),
    });
    assert.equal(cachedLibDir, libDir);
    assert.equal((await fs.readFile(f.envFile, 'utf8')).trim(), `SHERPA_ONNX_LIB_DIR=${libDir}`);
});

test('speech setup command runner terminates a stalled real child and emits progress while waiting', async () => {
    let child;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const logs = [];
    try {
        await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            timeoutMs: 1000,
            heartbeatMs: 100,
            label: 'stalled test process',
            log: message => logs.push(message),
            progress: () => 'test heartbeat',
            spawnImpl: (command, args, options) => {
                child = spawn(command, args, options);
                child.once('close', (code, signal) => resolveClosed({ code, signal }));
                return child;
            },
        }), /timed out|timeout/i);
        assert.ok(child, 'A real child process should have been started');
        const outcome = await Promise.race([closed, delay(2000, undefined, { ref: false }).then(() => { throw new Error('Timed-out child is still running'); })]);
        assert.ok(outcome.signal || outcome.code !== null, 'The child must actually terminate');
        assert.ok(logs.some(message => String(message).includes('test heartbeat')), 'A stalled command should still report progress');
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
});

test('speech setup command runner surfaces a nonzero child exit', async () => {
    await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(23)'], {
        timeoutMs: 2000, label: 'failing test process', log: () => {},
    }), /23/);
});
