import { defineConfig } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  plugins: [{
    name: 'local-benchmark-results',
    configureServer(server) {
      server.middlewares.use('/__benchmark_result', (req, res) => {
        // Only this loopback page can save a bounded JSON result, to a fixed directory.
        if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:5187') {
          res.statusCode = 403; res.end(); return;
        }
        let body = '';
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 2_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.backend !== 'Three.js WebGPU' || !Array.isArray(result.rawFrameMs)) throw new Error('Invalid result');
            const directory = resolve(import.meta.dirname, 'results');
            mkdirSync(directory, { recursive: true });
            const filename = `three-webgpu-${Date.now()}.json`;
            writeFileSync(resolve(directory, filename), JSON.stringify(result, null, 2));
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ file: filename }));
          } catch { res.statusCode = 400; res.end('Invalid benchmark JSON'); }
        });
      });
    },
  }],
});
