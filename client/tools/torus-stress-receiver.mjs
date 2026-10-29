import { createServer } from 'node:http';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = resolve(process.argv[2]);
createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:54388') { res.writeHead(403).end(); return; }
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/health') { res.end('torus-stress-v1'); return; }
  if (req.headers.origin !== 'http://localhost:5173') { res.writeHead(403).end(); return; }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.writeHead(204).end(); return; }
  if (req.method !== 'POST' || !/^\/firefox\/(?:nature|copper-metropolis|aether-archipelago)\/(?:(?:baseline|seam|optimized|repeat|cache|workers|batch|paired)\/)?(?:status\.json|result\.json|coverage-probe\.json|near-(?:plain|batch)\.png|stress-[0-7]-(?:control|dense|turn|move)\.png)$/.test(req.url ?? '')) { res.writeHead(400).end(); return; }
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw Error('Payload too large'); chunks.push(chunk); }
    let bytes = Buffer.concat(chunks), path = resolve(root, '.' + req.url);
    if (path.endsWith('/result.json')) { JSON.parse(bytes.toString()); bytes = gzipSync(bytes); path += '.gz'; }
    await mkdir(dirname(path), { recursive: true }); await writeFile(path + '.tmp', bytes); await rename(path + '.tmp', path); res.writeHead(204).end();
  } catch (error) { res.writeHead(500).end(String(error)); }
}).listen(54388, '127.0.0.1', () => console.log(root));
