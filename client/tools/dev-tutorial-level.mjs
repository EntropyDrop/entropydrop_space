import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseTutorialLevel } from '../src/tutorial/TutorialLevelFormat.ts';

const MAX_LEVEL_BYTES = 64 * 1024 * 1024;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalRequest(request) {
  if (!loopbackAddresses.has(request.socket.remoteAddress)) return false;
  try {
    const protocol = request.socket.encrypted ? 'https:' : 'http:';
    const origin = new URL(`${protocol}//${request.headers.host}`);
    return loopbackHosts.has(origin.hostname) && request.headers.origin === origin.origin;
  } catch { return false; }
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_LEVEL_BYTES) {
        chunks.length = 0;
        reject(Object.assign(new Error('Tutorial level exceeds 64 MiB.'), { status: 413 }));
      } else chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Only Vite development serves this fixed-path, same-origin loopback writer. */
export function devTutorialLevel({ root } = {}) {
  let levelPath;
  return {
    name: 'dev-tutorial-level',
    apply: 'serve',
    configureServer(server) {
      // A host Vite app can mount Space under its own root and base URL.
      levelPath = resolve(root ?? server.config.root, 'src/tutorial/tutorial-level.json');
      const endpoint = `${server.config.base}__dev/tutorial-level`;
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== endpoint) return next();
        const reply = (status, body) => {
          response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify(body));
        };
        if (!isLocalRequest(request)) return reply(403, { error: 'Tutorial saving is only available on localhost.' });
        if (request.method !== 'PUT') return reply(405, { error: 'Use PUT to save a tutorial level.' });
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          return reply(415, { error: 'Expected a JSON tutorial level.' });
        }
        let level;
        try { level = parseTutorialLevel(JSON.parse(await readBody(request))); }
        catch (error) { return reply(error.status || 400, { error: error.message }); }
        const temporaryPath = `${levelPath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, `${JSON.stringify(level, null, 2)}\n`, { flag: 'wx' });
          await rename(temporaryPath, levelPath);
          reply(200, { saved: true });
        } catch {
          reply(500, { error: 'Could not write tutorial-level.json. Check local file permissions and disk space.' });
        } finally { await rm(temporaryPath, { force: true }).catch(() => {}); }
      });
    },
    handleHotUpdate(context) {
      if (context.file !== levelPath) return;
      // Keep editing after Save. The next entry must still read the updated JSON.
      for (const module of context.modules) context.server.moduleGraph.invalidateModule(module);
      return [];
    },
  };
}
