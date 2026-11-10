import { readFile, realpath } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRegularPublicFile, projectRoot } from './public-files.js';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function createServer({ root = projectRoot } = {}) {
  const resolvedRoot = realpath(root);
  return createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const reply = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      reply(405, 'Method not allowed');
      return;
    }

    let path;
    try {
      path = decodeURIComponent((request.url || '/').split('?')[0]);
    } catch {
      reply(400, 'Invalid request path');
      return;
    }

    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.slice(1).split('/').some((part) => part.startsWith('.'))) {
      reply(404, 'Not found');
      return;
    }
    const relative = path === '/' ? 'index.html' : path.slice(1);
    try {
      const publicRoot = await resolvedRoot;
      if (!(await isRegularPublicFile(publicRoot, relative))) {
        reply(404, 'Not found');
        return;
      }
      const content = await readFile(join(publicRoot, relative));
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(relative)] || 'text/plain; charset=utf-8',
        'Content-Length': content.byteLength,
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      reply(error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Unable to serve file');
    }
  });
}

function start() {
  const args = process.argv.slice(2);
  let value = process.env.PORT || '4173';
  if (args.length) {
    if (args.length === 2 && args[0] === '--port') value = args[1];
    else if (args.length === 1 && args[0].startsWith('--port=')) value = args[0].slice(7);
    else throw new Error('Usage: npm run dev -- --port 4173');
  }
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const port = Number(value);
  const server = createServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Try npm run dev -- --port ${port + 1}.`
      : `Unable to start preview: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Snakes and Ladders:  http://127.0.0.1:${port}/`);
    console.log(`Activity preview:   http://127.0.0.1:${port}/tools/preview.html`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
