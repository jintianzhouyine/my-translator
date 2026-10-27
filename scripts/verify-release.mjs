import assert from 'assert';
import fs from 'fs';
import path from 'path';

const target = process.argv[2];
assert.ok(['aarch64-apple-darwin', 'aarch64-pc-windows-msvc'].includes(target), 'Unexpected build target');
const windows = target.endsWith('windows-msvc');
const binary = path.join('src-tauri', 'target', target, 'release', `my-translator${windows ? '.exe' : ''}`);
const data = fs.readFileSync(binary);
if (windows) {
    assert.equal(data.toString('ascii', 0, 2), 'MZ', 'Not a Windows executable');
    const peOffset = data.readUInt32LE(0x3c);
    assert.equal(data.readUInt32LE(peOffset), 0x00004550, 'Missing PE signature');
    assert.equal(data.readUInt16LE(peOffset + 4), 0xaa64, 'Windows executable must be native ARM64');
} else {
    assert.equal(data.readUInt32LE(0), 0xfeedfacf, 'Not a 64-bit Mach-O executable');
    assert.equal(data.readUInt32LE(4), 0x0100000c, 'macOS executable must be native ARM64');
}

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(config.version, manifest.version, 'Package versions must match');
if (process.env.GITHUB_REF_TYPE === 'tag') {
    assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Release tag must match package version');
}
console.log(`Verified native ARM64 executable: ${binary} (${data.length} bytes), version ${manifest.version}`);
