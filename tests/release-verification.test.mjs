import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const verifier = fileURLToPath(new URL('../scripts/verify-release.mjs', import.meta.url));
const windowsTarget = 'x86_64-pc-windows-msvc';
const macTarget = 'aarch64-apple-darwin';

function windowsExecutable(machine = 0x8664, optionalMagic = 0x020b) {
    const data = Buffer.alloc(512);
    data.write('MZ', 0, 'ascii');
    data.writeUInt32LE(0x80, 0x3c);
    data.writeUInt32LE(0x00004550, 0x80);
    data.writeUInt16LE(machine, 0x84);
    data.writeUInt16LE(240, 0x94);
    data.writeUInt16LE(optionalMagic, 0x98);
    return data;
}

function macExecutable(cpu = 0x0100000c) {
    const data = Buffer.alloc(32);
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(cpu, 4);
    return data;
}

function verify(t, { target = windowsTarget, binary = windowsExecutable(), configVersion = '0.10.1', env = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'my-translator-release-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, 'src-tauri', 'target', target, 'release',
        `my-translator${target.endsWith('windows-msvc') ? '.exe' : ''}`);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, binary);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.10.1' }));
    fs.writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: configVersion }));
    const cleanEnv = { ...process.env };
    delete cleanEnv.RELEASE_TAG;
    delete cleanEnv.GITHUB_REF_TYPE;
    delete cleanEnv.GITHUB_REF_NAME;
    const result = spawnSync(process.execPath, [verifier, target], {
        cwd: root,
        env: { ...cleanEnv, ...env },
        encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
}

test('release verification accepts Windows x64 with a manually selected tag from main', t => {
    const result = verify(t, { env: { RELEASE_TAG: 'v0.10.1', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified native x64 executable/);
});

test('release verification preserves Apple Silicon and legacy tag-trigger verification', t => {
    const result = verify(t, {
        target: macTarget,
        binary: macExecutable(),
        env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.10.1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified native ARM64 executable/);
});

for (const [name, machine] of [['ARM64', 0xaa64], ['32-bit x86', 0x014c]]) {
    test(`release verification rejects a ${name} executable in a Windows x64 build`, t => {
        const result = verify(t, { binary: windowsExecutable(machine) });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Windows executable must be native x64/);
    });
}

test('release verification rejects a 32-bit optional header even with an x64 machine marker', t => {
    const result = verify(t, { binary: windowsExecutable(0x8664, 0x010b) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /64-bit PE32\+ format/);
});

test('release verification rejects the retired Windows ARM64 build target', t => {
    const result = verify(t, { target: 'aarch64-pc-windows-msvc', binary: windowsExecutable(0xaa64) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected build target/);
});

test('release verification rejects Intel binaries in the Apple Silicon target', t => {
    const result = verify(t, { target: macTarget, binary: macExecutable(0x01000007) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /macOS executable must be native ARM64/);
});

test('release verification rejects inconsistent application versions', t => {
    const result = verify(t, { configVersion: '0.10.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Package versions must match/);
});

for (const [name, env] of [
    ['manual release input', { RELEASE_TAG: 'v0.10.0', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }],
    ['tag ref', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.10.0' }],
]) {
    test(`release verification rejects an outdated ${name}`, t => {
        const result = verify(t, { env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Release tag must match package version/);
    });
}

test('release verification uses the selected release tag instead of the workflow ref', t => {
    const result = verify(t, { env: { RELEASE_TAG: 'v0.10.1', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.10.0' } });
    assert.equal(result.status, 0, result.stderr);
});

test('release verification rejects an invalid PE offset with a readable error', t => {
    const binary = windowsExecutable();
    binary.writeUInt32LE(binary.length, 0x3c);
    const result = verify(t, { binary });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid PE header offset/);
});
