import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildSite } from '../tools/build.js';
import { createServer } from '../tools/serve.js';

async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'refract-tooling-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(parent, 'refract-tooling-')));
    await rm(root, { recursive: true, force: true });
  });
  const files = {
    'index.html': '<h1>Play</h1>',
    'styles.css': 'body { color: blue; }',
    LICENSE: 'Fixture license',
    'src/game.js': 'export const game = true;',
    'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'tools/preview.html': '<h1>Preview</h1>',
    'tools/preview.js': 'export const preview = true;',
    'tools/preview.css': 'body { margin: 0; }',
    'tools/serve.js': '// Not public',
    'tests/private.test.js': '// Not public',
    '.git/config': 'private repository settings',
    '.env': 'private environment',
    'src/.env': 'private nested environment',
    'assets/notes.txt': 'private notes',
    'dist/stale.txt': 'stale build output',
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

function get(server, path, method = 'GET') {
  return new Promise((resolveResult, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolveResult({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function serverFixture(t) {
  const root = await fixture(t);
  const server = createServer({ root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  return { root, server };
}

test('preview serves browser modules, query strings, and HEAD requests', async (t) => {
  const { server } = await serverFixture(t);
  assert.equal((await get(server, '/')).body, '<h1>Play</h1>');
  const script = await get(server, '/src/game.js?v=1');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['x-content-type-options'], 'nosniff');
  const head = await get(server, '/index.html', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength('<h1>Play</h1>'));
  assert.equal((await get(server, '/tools/preview.html')).status, 200);
});

test('preview rejects private files, encoded traversal, malformed paths, and writes', async (t) => {
  const { server } = await serverFixture(t);
  for (const path of [
    '/.env', '/.git/config', '/src/.env', '/tools/serve.js', '/tests/private.test.js',
    '/assets/notes.txt', '/dist/stale.txt', '/../index.html', '/src/%2e%2e/index.html',
    '/src/%2e%2e/%2e%2e/.env', '/src%5c..%5c.env', '/src/game.js%00', '//index.html',
  ]) {
    assert.equal((await get(server, path)).status, 404, path);
  }
  assert.equal((await get(server, '/%zz')).status, 400);
  const post = await get(server, '/index.html', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('build only includes public files and replaces stale output', async (t) => {
  const root = await fixture(t);
  const { destination, files } = await buildSite({ root });
  assert.equal(destination, join(root, 'dist'));
  assert.deepEqual(files, [
    'LICENSE', 'assets/mark.svg', 'index.html', 'src/game.js', 'styles.css',
    'tools/preview.css', 'tools/preview.html', 'tools/preview.js',
  ]);
  assert.deepEqual((await readdir(destination)).sort(), ['.nojekyll', 'LICENSE', 'assets', 'index.html', 'src', 'styles.css', 'tools']);
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), '<h1>Play</h1>');
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'private environment');
});

test('build refuses a dist link and public server refuses asset links', async (t) => {
  const { root, server } = await serverFixture(t);
  const outside = await fixture(t);
  await rm(join(root, 'dist'), { recursive: true });
  // Windows junctions need no elevated symlink privilege; use a directory link.
  await symlink(outside, join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildSite({ root }), /Refusing to replace dist/);
  assert.equal(await readFile(join(outside, '.env'), 'utf8'), 'private environment');
  await rm(join(root, 'assets'), { recursive: true });
  await symlink(join(outside, 'assets'), join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await get(server, '/assets/mark.svg')).status, 404);
});
