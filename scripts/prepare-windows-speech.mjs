import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Pinned to the official v1.13.3 release asset, including its published digest.
// MD matches Rust's default dynamic CRT; the crate's default downloader uses MT.
export const SPEECH_ARTIFACT = Object.freeze({
    version: '1.13.3',
    name: 'sherpa-onnx-v1.13.3-win-x64-static-MD-Release-lib',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.3/sherpa-onnx-v1.13.3-win-x64-static-MD-Release-lib.tar.bz2',
    size: 88744561,
    sha256: '99be8347b96dd3024847b2a70be9ec4ccf3e49d49a9a42a813d9e817b3969c1e',
    requiredLibraries: ['sherpa-onnx-c-api.lib', 'onnxruntime.lib'],
});

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

export async function verifyArchive(file, artifact = SPEECH_ARTIFACT) {
    const stat = await fsp.stat(file);
    assert.equal(stat.size, artifact.size, 'Speech archive size does not match the official release');
    assert.equal(await sha256(file), artifact.sha256, 'Speech archive SHA256 mismatch');
}

// A hard process deadline supplements curl's own connection/transfer limits.
// No shell is involved, so the process being terminated is curl/7-Zip/tar itself.
export function runCommand(command, args, {
    timeoutMs,
    heartbeatMs = 15000,
    label = command,
    log = console.log,
    progress = () => '',
    spawnImpl = spawn,
} = {}) {
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'A positive process timeout is required');
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawnImpl(command, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
        let timedOut = false;
        let finished = false;
        const finish = (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            clearInterval(heartbeat);
            if (error) reject(error);
            else resolve();
        };
        const heartbeat = setInterval(() => {
            let detail = '';
            try { detail = progress(); } catch { /* A partial file may not exist yet. */ }
            log(`${label}: ${Math.round((Date.now() - started) / 1000)}s elapsed${detail ? `; ${detail}` : ''}`);
        }, heartbeatMs);
        const deadline = setTimeout(() => {
            timedOut = true;
            log(`${label}: reached the ${Math.round(timeoutMs / 1000)}s time limit; terminating the process.`);
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('error', error => finish(new Error(`${label}: ${error.message}`, { cause: error })));
        child.once('close', (code, signal) => {
            if (timedOut) finish(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
            else if (code !== 0) finish(new Error(`${label} failed with exit code ${code}${signal ? ` (${signal})` : ''}`));
            else finish();
        });
    });
}

async function libraryManifest(destination, artifact) {
    const libraries = [];
    for (const name of artifact.requiredLibraries) {
        assert.equal(path.basename(name), name, 'Library names must not contain directories');
        const file = path.join(destination, 'lib', name);
        const stat = await fsp.stat(file);
        assert.ok(stat.isFile() && stat.size > 0, `Missing or empty speech library: ${name}`);
        libraries.push({ name, size: stat.size, sha256: await sha256(file) });
    }
    return libraries;
}

async function validCache(destination, artifact) {
    try {
        const marker = JSON.parse(await fsp.readFile(path.join(destination, '.complete.json'), 'utf8'));
        if (marker.archiveSha256 !== artifact.sha256 || marker.archiveSize !== artifact.size) return false;
        const actual = await libraryManifest(destination, artifact);
        return JSON.stringify(actual) === JSON.stringify(marker.libraries);
    } catch {
        return false;
    }
}

async function exportLibraries(destination, envFile, log) {
    const libraryDirectory = path.join(destination, 'lib');
    assert.ok(!/[\r\n]/.test(libraryDirectory), 'Library path must not contain newlines');
    await fsp.appendFile(envFile, `SHERPA_ONNX_LIB_DIR=${libraryDirectory}\n`);
    log(`Prepared Windows x64 speech libraries: ${libraryDirectory}`);
    return libraryDirectory;
}

export async function prepareSpeechLibraries({
    cacheDir = process.env.SHERPA_ONNX_CACHE_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'my-translator-speech'),
    envFile = process.env.GITHUB_ENV,
    artifact = SPEECH_ARTIFACT,
    run = runCommand,
    log = console.log,
    retryDelayMs = 2000,
    heartbeatMs = 15000,
    platform = process.platform,
    sevenZipCommand,
} = {}) {
    assert.ok(envFile, 'GITHUB_ENV is required to export the speech library path');
    assert.equal(path.basename(artifact.name), artifact.name, 'Artifact name must not contain directories');
    cacheDir = path.resolve(cacheDir);
    const destination = path.join(cacheDir, artifact.name);
    log(`Checking cached speech libraries: ${destination}`);
    if (await validCache(destination, artifact)) {
        log('Speech library cache verified; download and extraction skipped.');
        return exportLibraries(destination, envFile, log);
    }

    await fsp.mkdir(cacheDir, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(cacheDir, '.prepare-'));
    const archive = path.join(staging, 'speech.tar.bz2');
    try {
        for (let attempt = 1; attempt <= 3; attempt++) {
            await fsp.rm(archive, { force: true });
            log(`Downloading speech libraries (${attempt}/3), ${(artifact.size / 1024 / 1024).toFixed(1)} MiB: ${artifact.url}`);
            try {
                await run(platform === 'win32' ? 'curl.exe' : 'curl', [
                    '--fail', '--location', '--silent', '--show-error',
                    '--connect-timeout', '30', '--max-time', '300',
                    '--speed-time', '45', '--speed-limit', '1024',
                    '--output', archive, artifact.url,
                ], {
                    timeoutMs: 315000, heartbeatMs, label: `Download attempt ${attempt}/3`, log,
                    progress: () => {
                        const bytes = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
                        return `${(bytes / 1024 / 1024).toFixed(1)} / ${(artifact.size / 1024 / 1024).toFixed(1)} MiB (${Math.min(100, Math.round(bytes / artifact.size * 100))}%)`;
                    },
                });
                log('Download finished; verifying archive size and SHA256.');
                await verifyArchive(archive, artifact);
                log('Speech archive verified.');
                break;
            } catch (error) {
                log(`Download attempt ${attempt}/3 failed: ${error.message}`);
                if (attempt === 3) throw new Error('Speech library download failed after 3 attempts', { cause: error });
                await delay(retryDelayMs);
            }
        }

        if (platform === 'win32') {
            // Git's tar may be ahead of Windows bsdtar on PATH. Use the runner's
            // known 7-Zip installation and separate bzip2 decompression from tar
            // extraction, with independent deadlines and visible command output.
            const installedSevenZip = path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
            const extractor = sevenZipCommand || (fs.existsSync(installedSevenZip) ? installedSevenZip : '7z.exe');
            const tarArchive = path.join(staging, 'speech.tar');
            log(`Windows extraction tool: ${extractor}`);
            log('Decompressing bzip2 archive with 7-Zip (maximum 180s).');
            await run(extractor, ['x', archive, `-o${staging}`, '-y', '-bd', '-bb1', '-tbzip2'], {
                timeoutMs: 180000, heartbeatMs, label: 'Decompressing speech archive (7-Zip)', log,
            });
            const tarStat = await fsp.stat(tarArchive);
            assert.ok(tarStat.isFile() && tarStat.size > 0, '7-Zip did not produce a nonempty speech.tar');
            log(`Bzip2 decompression finished (${(tarStat.size / 1024 / 1024).toFixed(1)} MiB); extracting tar with 7-Zip (maximum 180s).`);
            await run(extractor, ['x', tarArchive, `-o${staging}`, '-y', '-bd', '-bb1', '-ttar'], {
                timeoutMs: 180000, heartbeatMs, label: 'Extracting speech libraries (7-Zip)', log,
            });
        } else {
            log('Extracting speech libraries with tar (maximum 180s).');
            await run('tar', ['-xjf', archive, '-C', staging], {
                timeoutMs: 180000, heartbeatMs, label: 'Extracting speech libraries', log,
            });
        }
        const extracted = path.join(staging, artifact.name);
        log('Extraction finished; checking required static libraries.');
        const libraries = await libraryManifest(extracted, artifact);
        await fsp.writeFile(path.join(extracted, '.complete.json'), JSON.stringify({
            archiveSha256: artifact.sha256, archiveSize: artifact.size, libraries,
        }, null, 2) + '\n');
        // Only a fully extracted, verified directory can become the cache entry.
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(extracted, destination);
        return await exportLibraries(destination, envFile, log);
    } finally {
        await fsp.rm(staging, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    prepareSpeechLibraries().catch(error => {
        console.error(error.stack || error.message);
        if (error.cause) console.error(`Cause: ${error.cause.message}`);
        process.exitCode = 1;
    });
}
