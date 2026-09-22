import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkTraffic, DownloadProgress, formatByteRate, recordResourceTransfer,
  sendRealtimeBytes, trackFetchDownloads } from '../src/bootstrap/NetworkTraffic.ts';
import { readResponseBytes } from '../src/bootstrap/NetworkSafety.ts';
import { canTrackUpload, uploadWithProgress } from '../src/bootstrap/UploadProgress.ts';

const timing = (values: Partial<PerformanceResourceTiming>) => ({ transferSize: 300,
  decodedBodySize: 0, responseStart: 0, responseEnd: 0, ...values }) as PerformanceResourceTiming;

test('rolling rates do not depend on HUD cadence and expire after a stalled frame', () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  for (let i = 1; i <= 50; i++) {
    now = i * 100;
    traffic.receive(1024); traffic.send(512);
    if (i > 10) assert.equal(traffic.sample().downloadBytesPerSecond, 10240);
  }
  assert.equal(traffic.sample().uploadBytesPerSecond, 5120);
  now += 5000;
  assert.deepEqual(traffic.sample(), { downloadBytesPerSecond: 0, uploadBytesPerSecond: 0 });
  traffic.receive(100);
  assert.equal(traffic.sample().downloadBytesPerSecond, 100, 'resume must not average over the paused interval');
});

test('stream downloads contribute before completion and preserve response/cancellation semantics', async () => {
  let now = 0, controller!: ReadableStreamDefaultController<Uint8Array>;
  const traffic = new NetworkTraffic(() => now);
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  const fetch = trackFetchDownloads(async () => response, traffic);
  assert.equal(await fetch('http://localhost/terrain'), response, 'native response identity is preserved');
  const result = readResponseBytes(response, 20000);
  for (let i = 1; i <= 15; i++) {
    now = i * 100;
    controller.enqueue(new Uint8Array(1024));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(traffic.sample().downloadBytesPerSecond, Math.min(i, 10) * 1024);
  }
  controller.close();
  assert.equal((await result).byteLength, 15 * 1024);
  now += 1001;
  assert.equal(traffic.sample().downloadBytesPerSecond, 0, 'no completion spike');
});

test('download accounting retains bounded-reader cancellation and partial failed transfers', async () => {
  let cancelled = false;
  const traffic = new NetworkTraffic(() => 100);
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  }));
  const fetch = trackFetchDownloads(async () => response, traffic);
  await assert.rejects(readResponseBytes(await fetch('http://localhost/too-large'), 512));
  assert.equal(cancelled, true);
  assert.equal(traffic.sample().downloadBytesPerSecond, 1024);
});

test('cache reconciliation removes streamed bytes; compressed transfers are not counted twice', () => {
  let now = 100;
  const traffic = new NetworkTraffic(() => now);
  const cached = new DownloadProgress(traffic);
  cached.read(65536);
  cached.completeTiming(timing({ transferSize: 0, decodedBodySize: 65536 }));
  cached.finish();
  assert.equal(traffic.sample().downloadBytesPerSecond, 0);
  const network = new DownloadProgress(traffic);
  network.read(4096);
  network.completeTiming(timing({ transferSize: 1200, encodedBodySize: 900, decodedBodySize: 4096 }));
  network.finish(); network.finish();
  assert.equal(traffic.sample().downloadBytesPerSecond, 4096, 'one consistent payload measurement, not payload plus wire bytes');
  const hiddenTiming = new DownloadProgress(traffic);
  hiddenTiming.read(1024);
  hiddenTiming.completeTiming(timing({ transferSize: 0, decodedBodySize: 0 }));
  assert.equal(traffic.sample().downloadBytesPerSecond, 5120, 'unavailable cross-origin timing must not erase real progress');
  now += 2000;
  assert.equal(traffic.sample().downloadBytesPerSecond, 0);
});

test('delayed resource timing uses its original interval and never adds a completion burst', () => {
  let now = 10000;
  const traffic = new NetworkTraffic(() => now);
  recordResourceTransfer(timing({ decodedBodySize: 100000, responseStart: 0, responseEnd: 10000 }), traffic);
  assert.ok(Math.abs(traffic.sample().downloadBytesPerSecond - 10000) <= 100);
  now = 15000;
  recordResourceTransfer(timing({ decodedBodySize: 100000, responseStart: 0, responseEnd: 10000 }), traffic);
  assert.equal(traffic.sample().downloadBytesPerSecond, 0);
  const lateReader = new DownloadProgress(traffic);
  lateReader.completeTiming(timing({ decodedBodySize: 100000, responseStart: 0, responseEnd: 10000 }));
  lateReader.finish();
  lateReader.read(100000);
  assert.equal(traffic.sample().downloadBytesPerSecond, 0, 'reading an already downloaded body is not another transfer');
});

test('WebSocket bandwidth counts queue drain, not send calls or discarded bytes', () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  const socket = { readyState: 1, bufferedAmount: 0,
    send(data: any) { this.bufferedAmount += data.byteLength; } };
  sendRealtimeBytes(socket, new Uint8Array(4096), traffic);
  assert.equal(traffic.sample().uploadBytesPerSecond, 0);
  now = 100; socket.bufferedAmount = 3072;
  assert.equal(traffic.sample().uploadBytesPerSecond, 1024);
  sendRealtimeBytes(socket, new Uint8Array(1024), traffic);
  now = 200; socket.bufferedAmount = 2048;
  assert.equal(traffic.sample().uploadBytesPerSecond, 3072);
  now = 300; socket.readyState = 3; socket.bufferedAmount = 0;
  assert.equal(traffic.sample().uploadBytesPerSecond, 3072, 'closed sockets must not report dropped buffers');
  now = 1300;
  assert.equal(traffic.sample().uploadBytesPerSecond, 0);
});

function xhrFixture() {
  let sent!: (body: Blob) => void;
  const started = new Promise<Blob>(resolve => { sent = resolve; });
  const xhr: any = { upload: {}, status: 200, statusText: 'OK', responseURL: 'http://localhost/upload',
    response: new Blob(['ok']), headers: new Map(),
    open(method: string, url: string) { this.method = method; this.url = url; },
    setRequestHeader(key: string, value: string) { this.headers.set(key, value); },
    send(body: Blob) { sent(body); },
    abort() { this.onabort?.(); },
    getAllResponseHeaders() { return 'content-type: text/plain\r\n'; },
  };
  return { xhr, started };
}

test('HTTP upload progresses before the response, preserves credentials and avoids final double counting', async () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now), { xhr, started } = xhrFixture();
  const pending = uploadWithProgress('http://localhost/upload', { method: 'POST', body: new Uint8Array(4096),
    credentials: 'include', headers: { Authorization: 'Bearer fixture' } }, traffic, () => xhr);
  assert.equal((await started).size, 4096);
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers.get('authorization'), 'Bearer fixture');
  now = 100; xhr.upload.onprogress({ loaded: 1024 });
  assert.equal(traffic.sample().uploadBytesPerSecond, 1024);
  now = 200; xhr.upload.onprogress({ loaded: 4096 }); xhr.upload.onload({ loaded: 4096 });
  assert.equal(traffic.sample().uploadBytesPerSecond, 4096);
  now = 2500;
  assert.equal(traffic.sample().uploadBytesPerSecond, 0, 'server processing is not upload time');
  xhr.onload();
  const response = await pending;
  assert.equal(response.url, xhr.responseURL);
  assert.equal(await response.text(), 'ok');
  assert.equal(traffic.sample().uploadBytesPerSecond, 0);
});

test('Request and multipart bodies retain encoding; abort keeps only the transmitted portion', async () => {
  let now = 100;
  const traffic = new NetworkTraffic(() => now), { xhr, started } = xhrFixture();
  const abort = new AbortController(), form = new FormData();
  form.set('name', 'fixture'); form.set('file', new Blob(['abcdef']), 'fixture.bin');
  const request = new Request('http://localhost/upload', { method: 'POST', body: form, signal: abort.signal });
  const pending = uploadWithProgress(request, undefined, traffic, () => xhr);
  const body = await started;
  assert.match(xhr.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.match(await body.text(), /fixture.bin/);
  xhr.upload.onprogress({ loaded: 100 });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(traffic.sample().uploadBytesPerSecond, 100);
  now += 1001;
  assert.equal(traffic.sample().uploadBytesPerSecond, 0);
});

test('byte-rate labels use explicit binary units', () => {
  assert.equal(formatByteRate(0), '0 B/s');
  assert.equal(formatByteRate(1536), '1.5 KiB/s');
  assert.equal(formatByteRate(2 * 1024 * 1024), '2.0 MiB/s');
});

test('upload instrumentation preserves native fetch for unsupported security and lifecycle options', () => {
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = function () {} as any;
  try {
    const url = 'http://localhost/upload', base: RequestInit = { method: 'POST', body: 'payload' };
    assert.equal(canTrackUpload(url, base), true);
    for (const extra of [{ keepalive: true }, { mode: 'no-cors' }, { credentials: 'omit' },
      { redirect: 'manual' }, { redirect: 'error' }, { integrity: 'sha256-fixture' },
      { referrer: '' }, { referrerPolicy: 'no-referrer' }]) {
      assert.equal(canTrackUpload(url, { ...base, ...extra } as RequestInit), false);
    }
    assert.equal(canTrackUpload(url, { method: 'POST' }), false);
    assert.equal(canTrackUpload(url, { ...base, body: new ReadableStream() }), false);
    assert.equal(canTrackUpload(new Request(url, { ...base, referrerPolicy: 'no-referrer' })), false);
  } finally { globalThis.XMLHttpRequest = previous; }
});

test('upload transport keeps HTTP errors readable and enforces the response-size bound', async () => {
  const traffic = new NetworkTraffic(() => 100), { xhr, started } = xhrFixture();
  const pending = uploadWithProgress('http://localhost/upload', { method: 'POST', body: 'test' }, traffic, () => xhr);
  await started;
  xhr.status = 401; xhr.statusText = 'Unauthorized'; xhr.onload();
  assert.equal((await pending).status, 401, 'the auth interceptor must receive a normal 401 response');
  const large = xhrFixture();
  const oversized = uploadWithProgress('http://localhost/upload', { method: 'POST', body: 'test' }, traffic, () => large.xhr);
  await large.started;
  large.xhr.onprogress({ loaded: 16 * 1024 * 1024 + 1 });
  await assert.rejects(oversized, /safety limit/);
});
