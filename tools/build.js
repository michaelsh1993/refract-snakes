import { copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPublicFiles, projectRoot } from './public-files.js';

export async function buildSite({ root = projectRoot } = {}) {
  const source = await realpath(root);
  const destination = resolve(source, 'dist');
  const files = await listPublicFiles(source);
  for (const required of ['index.html', 'styles.css', 'LICENSE']) {
    if (!files.includes(required)) throw new Error(`Missing public file: ${required}`);
  }

  // Never follow a link or accept an arbitrary output path when cleaning a build.
  if (dirname(destination) !== source) throw new Error('Build output must be inside the project.');
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(destination) !== destination) {
      throw new Error('Refusing to replace dist because it is not a regular project directory.');
    }
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(destination);
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
  await writeFile(join(destination, '.nojekyll'), '');
  return { destination, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { files } = await buildSite();
    console.log(`Built ${files.length} public files into dist/.`);
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
