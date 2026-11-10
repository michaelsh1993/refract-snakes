import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const fixedFiles = new Set([
  'index.html',
  'styles.css',
  'LICENSE',
  'tools/preview.html',
  'tools/preview.js',
  'tools/preview.css',
]);

// This is shared by the preview server and build so local-only files cannot leak.
export function isPublicFile(path) {
  return fixedFiles.has(path)
    || /^src\/[a-zA-Z0-9_-]+\.js$/.test(path)
    || /^assets\/[a-zA-Z0-9_-]+\.(?:svg|png|jpe?g|webp|avif|gif|ico|woff2?)$/.test(path);
}

export async function isRegularPublicFile(root, path) {
  if (!isPublicFile(path)) return false;
  let current = root;
  try {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      current = join(current, parts[i]);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return false;
      if (i === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function listPublicFiles(root) {
  const candidates = [...fixedFiles];
  for (const directory of ['src', 'assets']) {
    try {
      for (const name of await readdir(join(root, directory))) candidates.push(`${directory}/${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const files = [];
  for (const path of candidates) {
    if (await isRegularPublicFile(root, path)) files.push(path);
  }
  return files.sort();
}
