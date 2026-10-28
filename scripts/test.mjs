import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(path.join(root, 'tests'))
    .filter(name => name.endsWith('.test.mjs')).sort()
    .map(name => path.join('tests', name));
if (files.length === 0) throw new Error('No application tests found');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    cwd: root, stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
