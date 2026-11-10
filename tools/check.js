import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './public-files.js';

let count = 0;
for (const directory of ['src', 'tools', 'tests']) {
  let entries;
  try {
    entries = await readdir(join(projectRoot, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(projectRoot, directory, entry.name)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    count += 1;
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
