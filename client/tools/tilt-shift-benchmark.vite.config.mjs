import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import appConfig from '../vite.config.js';

const directory = fileURLToPath(new URL('../../.local/aether-tilt-shift/', import.meta.url));
const authority = '127.0.0.1:5198';
const origin = 'http://' + authority;
const prefix = '/space/app/__dev/tilt-shift/';
const district = /^terrain\/(?:index\.json|(?:[0-9]|[12][0-9]|3[01])_[0-3]\.edsz\.gz)$/;
const bounded = /^(?:status\.json|results\.json|(?:medium|low)-(?:baseline|blur|lod|tilt)\.png)$/;
const full = /^(?:status\.json|results\.json|(?:medium|low)-(?:baseline|tilt)-(?:ring|skyline|overlook)\.png)$/;

export default env => {
  const config = appConfig(env);
  config.base = '/space/app/';
  config.server = { ...config.server, host: '127.0.0.1', port: 5198, strictPort: true };
  config.plugins.push({
    name: 'tilt-shift-benchmark',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        if (req.headers.host !== authority) {
          res.writeHead(403).end();
          return;
        }
        const path = req.url.slice(prefix.length);
        if (req.method === 'GET' && district.test(path)) {
          try {
            const data = await readFile(join(directory, path));
            const contentType = path.endsWith('.json') ? 'application/json' : 'application/gzip';
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }).end(data);
          } catch (error) {
            res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
          }
          return;
        }

        const [suite, filename, extra] = path.split('/');
        const allowed = suite === 'bounded' ? bounded : suite === 'full' ? full : null;
        if (req.method !== 'POST' || req.headers.origin !== origin || !allowed?.test(filename) || extra !== undefined) {
          res.writeHead(403).end();
          return;
        }
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 8000000) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          const folder = join(directory, suite);
          await mkdir(folder, { recursive: true });
          const target = join(folder, filename);
          const temp = target + '.tmp';
          await writeFile(temp, Buffer.concat(chunks));
          await rename(temp, target);
          res.writeHead(204).end();
        } catch {
          res.writeHead(500).end();
        }
      });
    },
  });
  return config;
};
