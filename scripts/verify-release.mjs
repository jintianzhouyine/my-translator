import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
assert.ok(['aarch64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(target), 'Unexpected build target');
const windows = target.endsWith('windows-msvc');
const binary = path.join('src-tauri', 'target', target, 'release', `my-translator${windows ? '.exe' : ''}`);
const data = fs.readFileSync(binary);
if (windows) {
    assert.ok(data.length >= 0x40, 'Truncated Windows executable header');
    assert.equal(data.toString('ascii', 0, 2), 'MZ', 'Not a Windows executable');
    const peOffset = data.readUInt32LE(0x3c);
    assert.ok(peOffset >= 0x40 && peOffset + 26 <= data.length, 'Invalid PE header offset');
    assert.equal(data.readUInt32LE(peOffset), 0x00004550, 'Missing PE signature');
    assert.equal(data.readUInt16LE(peOffset + 4), 0x8664, 'Windows executable must be native x64');
    assert.equal(data.readUInt16LE(peOffset + 24), 0x020b, 'Windows executable must use the 64-bit PE32+ format');
} else {
    assert.ok(data.length >= 8, 'Truncated macOS executable header');
    assert.equal(data.readUInt32LE(0), 0xfeedfacf, 'Not a 64-bit Mach-O executable');
    assert.equal(data.readUInt32LE(4), 0x0100000c, 'macOS executable must be native ARM64');
}

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(config.version, manifest.version, 'Package versions must match');
const releaseTag = process.env.RELEASE_TAG ||
    (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
if (releaseTag !== undefined) {
    assert.equal(releaseTag, `v${manifest.version}`, 'Release tag must match package version');
}
console.log(`Verified native ${windows ? 'x64' : 'ARM64'} executable: ${binary} (${data.length} bytes), version ${manifest.version}`);
