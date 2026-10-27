/** Optional loopback-only sink for the native-browser benchmark. */
import { createServer } from 'node:http';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve(process.argv[2] ?? 'client/src/dev/results/visibility-browser-captures');
const port = 54379;
const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const filePattern = /^(?:browser\.json|status\.json|failure\.txt|(?:aether-archipelago|nature|copper-metropolis)\/(?:diagnostics\.json|(?:raw|repeat|control|probe)\.json\.gz|(?:near|across)-(?:original|fast|wide|gpu|upload)\.png))$/;
const server = createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` || !origins.has(req.headers.origin)) { res.writeHead(403); res.end(); return; }
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.writeHead(204); res.end(); return;
  }
  if (req.method === 'GET' && req.url === '/health') { res.end('visibility-results-v1'); return; }
  const match = /^\/([a-z0-9-]{1,64})\/(.+)$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !match || !filePattern.test(match[2])) { res.writeHead(400); res.end(); return; }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw Error('Capture too large.'); chunks.push(chunk); }
    const target = resolve(root, match[1], match[2]); await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, Buffer.concat(chunks)); await rename(temporary, target);
    res.writeHead(204); res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(`Visibility capture receiver: ${root}`));
