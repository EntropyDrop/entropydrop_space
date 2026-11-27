#!/usr/bin/env node
/**
 * Resumable npm install wrapper for slow or connection-resetting HTTP proxies.
 *
 * Runs a local HTTP relay on 127.0.0.1 that fetches registry.npmjs.org tarballs
 * in 1 MiB HTTP Range chunks through HTTPS_PROXY/HTTP_PROXY, retrying any
 * dropped chunk without losing progress. npm still verifies every package's
 * SHA-512 integrity hash from package-lock.json.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const UPSTREAM_ORIGIN = 'https://registry.npmjs.org';
const CHUNK_BYTES = 512 * 1024; // 512 KiB per Range request to stay well under proxy timeouts
const CHUNK_CONCURRENCY = 3;
const MAX_UPSTREAM_CONCURRENCY = 4;
const MAX_RETRIES = 12;
const REQUEST_TIMEOUT_MS = 30_000;

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= limit) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

const limitUpstream = createSemaphore(MAX_UPSTREAM_CONCURRENCY);

function parseArgs(argv) {
  let runtimeDir = null;
  const separator = argv.indexOf('--');
  const own = separator === -1 ? [] : argv.slice(0, separator);
  const npmArgs = separator === -1 ? argv : argv.slice(separator + 1);
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--runtime-dir' && own[i + 1]) {
      runtimeDir = own[++i];
    } else {
      throw new Error(`Unknown option: ${own[i]}`);
    }
  }
  if (npmArgs.length === 0) {
    throw new Error('Usage: node tools/npm-resumable-install.mjs [--runtime-dir DIR] -- <npm args>');
  }
  return { runtimeDir, npmArgs };
}

function getProxyUrl() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  return raw ? new URL(raw) : null;
}

function openConnectTunnel(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });
    const fail = (err) => {
      req.destroy();
      reject(err);
    };
    req.once('timeout', () => fail(new Error(`Proxy CONNECT timeout to ${targetHost}:${targetPort}`)));
    req.once('error', fail);
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
        return;
      }
      if (head && head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

async function fetchOnce(targetUrl, extraHeaders, proxyUrl, redirectsLeft = 4) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const port = Number(parsed.port) || (isHttps ? 443 : 80);

  let tunnelSocket = null;
  if (proxyUrl && isHttps) {
    tunnelSocket = await openConnectTunnel(proxyUrl, parsed.hostname, port, REQUEST_TIMEOUT_MS);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'user-agent': 'entropydrop-resumable-npm/1',
        'accept-encoding': 'identity',
        ...extraHeaders,
      },
      agent: false,
      timeout: REQUEST_TIMEOUT_MS,
    };

    if (tunnelSocket) {
      options.createConnection = () =>
        tls.connect({
          socket: tunnelSocket,
          servername: parsed.hostname,
        });
    } else if (proxyUrl && !isHttps) {
      options.hostname = proxyUrl.hostname;
      options.port = Number(proxyUrl.port) || 80;
      options.path = targetUrl;
      options.headers.host = parsed.host;
    }

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        fetchOnce(nextUrl, extraHeaders, proxyUrl, redirectsLeft - 1).then(
          (value) => finish(null, value),
          (err) => finish(err),
        );
        return;
      }
      const chunks = [];
      let total = 0;
      let timer = setTimeout(() => {
        req.destroy(new Error(`Read timeout for ${targetUrl}`));
      }, REQUEST_TIMEOUT_MS);
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          req.destroy(new Error(`Read stalled for ${targetUrl}`));
        }, REQUEST_TIMEOUT_MS);
      };
      res.on('data', (chunk) => {
        resetTimer();
        chunks.push(chunk);
        total += chunk.length;
      });
      res.once('error', (err) => {
        clearTimeout(timer);
        finish(err);
      });
      res.once('aborted', () => {
        clearTimeout(timer);
        finish(new Error(`Response aborted for ${targetUrl}`));
      });
      res.once('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks, total);
        const expected = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
        if (expected !== null && Number.isFinite(expected) && body.length !== expected) {
          finish(new Error(`Truncated body for ${targetUrl}: got ${body.length}/${expected}`));
          return;
        }
        finish(null, { statusCode: res.statusCode || 500, headers: res.headers, body });
      });
    });

    req.once('timeout', () => req.destroy(new Error(`Request timeout for ${targetUrl}`)));
    req.once('error', (err) => {
      if (tunnelSocket && !tunnelSocket.destroyed) tunnelSocket.destroy();
      finish(err);
    });
    req.end();
  });
}

async function withRetries(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await limitUpstream(fn);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      const delay = Math.min(4000, 300 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${lastError?.message || lastError}`);
}

function parseContentRange(header) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header || '');
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function downloadTarballToFile(urlPath, cacheFile, proxyUrl) {
  const targetUrl = UPSTREAM_ORIGIN + urlPath;
  const first = await withRetries(`GET ${urlPath} [0..${CHUNK_BYTES - 1}]`, async () => {
    const res = await fetchOnce(targetUrl, { Range: `bytes=0-${CHUNK_BYTES - 1}` }, proxyUrl);
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return res;
  });

  const tmpFile = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    if (first.statusCode === 200) {
      fs.writeFileSync(tmpFile, first.body);
      fs.renameSync(tmpFile, cacheFile);
      return first.body.length;
    }

    const range = parseContentRange(first.headers['content-range']);
    if (!range || range.start !== 0 || first.body.length !== range.end - range.start + 1) {
      throw new Error(`Unexpected Content-Range for ${urlPath}: ${first.headers['content-range']}`);
    }

    const total = range.total;
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, first.body, 0, first.body.length, 0);
      const ranges = [];
      for (let start = first.body.length; start < total; start += CHUNK_BYTES) {
        ranges.push([start, Math.min(total - 1, start + CHUNK_BYTES - 1)]);
      }

      let cursor = 0;
      const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, ranges.length) }, async () => {
        while (cursor < ranges.length) {
          const [start, end] = ranges[cursor++];
          const expectedLen = end - start + 1;
          const part = await withRetries(`GET ${urlPath} [${start}..${end}/${total}]`, async () => {
            const res = await fetchOnce(targetUrl, { Range: `bytes=${start}-${end}` }, proxyUrl);
            if (res.statusCode !== 206 || res.body.length !== expectedLen) {
              throw new Error(`HTTP ${res.statusCode} len=${res.body.length}/${expectedLen}`);
            }
            return res.body;
          });
          fs.writeSync(fd, part, 0, part.length, start);
        }
      });
      await Promise.all(workers);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpFile, cacheFile);
    if (total >= 2 * 1024 * 1024) {
      console.error(`[npm-resumable] fetched ${urlPath} (${(total / (1024 * 1024)).toFixed(1)} MiB)`);
    }
    return total;
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
}

function startRelay(proxyUrl, cacheDir) {
  const inFlight = new Map();
  let localOrigin = '';

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url || '/';
      if (urlPath.endsWith('.tgz')) {
        const key = Buffer.from(urlPath).toString('base64url');
        const cacheFile = path.join(cacheDir, `${key}.tgz`);
        if (!fs.existsSync(cacheFile)) {
          let pending = inFlight.get(urlPath);
          if (!pending) {
            pending = downloadTarballToFile(urlPath, cacheFile, proxyUrl).finally(() => {
              inFlight.delete(urlPath);
            });
            inFlight.set(urlPath, pending);
          }
          await pending;
        }
        const stat = fs.statSync(cacheFile);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
        });
        fs.createReadStream(cacheFile).pipe(res);
        return;
      }

      const headers = {};
      if (req.headers.accept) headers.accept = req.headers.accept;
      const upstream = await withRetries(`GET ${urlPath}`, async () => {
        const result = await fetchOnce(UPSTREAM_ORIGIN + urlPath, headers, proxyUrl);
        if (result.statusCode >= 500 || result.statusCode === 429) {
          throw new Error(`HTTP ${result.statusCode}`);
        }
        return result;
      });
      let body = upstream.body;
      const contentType = upstream.headers['content-type'] || 'application/json';
      if (contentType.includes('json')) {
        body = Buffer.from(body.toString('utf8').replaceAll(UPSTREAM_ORIGIN, localOrigin), 'utf8');
      }
      res.writeHead(upstream.statusCode, {
        'content-type': contentType,
        'content-length': String(body.length),
      });
      res.end(body);
    } catch (err) {
      console.error(`[npm-resumable] error on ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(err.message);
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      localOrigin = `http://127.0.0.1:${port}`;
      resolve({ server, localOrigin });
    });
  });
}

function runNpm(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args[0]} exited with ${signal || code}`));
    });
  });
}

async function main() {
  const { runtimeDir, npmArgs } = parseArgs(process.argv.slice(2));
  const proxyUrl = getProxyUrl();

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-resumable-'));
  const lockPath = path.resolve('package-lock.json');
  const originalLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  let relay = null;

  try {
    relay = await startRelay(proxyUrl, cacheDir);
    if (originalLock !== null) {
      fs.writeFileSync(lockPath, originalLock.replaceAll(UPSTREAM_ORIGIN, relay.localOrigin), 'utf8');
    }

    const childEnv = {
      ...process.env,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      npm_config_registry: relay.localOrigin,
      npm_config_fetch_timeout: '600000',
      npm_config_fetch_retries: '5',
      npm_config_maxsockets: '4',
    };

    await runNpm(npmArgs, process.cwd(), childEnv);

    if (runtimeDir) {
      const runtimePkg = JSON.parse(fs.readFileSync(path.resolve('server/space/runtime/package.json'), 'utf8'));
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(
        path.join(runtimeDir, 'package.json'),
        JSON.stringify({ private: true, type: 'module', dependencies: runtimePkg.dependencies }),
      );
      await runNpm(
        ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        runtimeDir,
        childEnv,
      );
    }
  } finally {
    if (originalLock !== null) {
      fs.writeFileSync(lockPath, originalLock, 'utf8');
    }
    if (relay) {
      await new Promise((r) => relay.server.close(r));
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[npm-resumable] ${err.stack || err.message}`);
  process.exit(1);
});
