import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkTraffic, bodyByteLength, formatByteRate, recordResourceTransfer,
  sendRealtimeBytes, trackHttpUploads } from '../src/bootstrap/NetworkTraffic.ts';

test('bandwidth combines HTTP and realtime traffic, samples elapsed time and returns to zero', () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  recordResourceTransfer({ transferSize: 1024 }, traffic);
  traffic.receive(1024);
  traffic.send(512);
  now = 500;
  assert.equal(traffic.sample().downloadBytesPerSecond, 0);
  now = 1000;
  assert.deepEqual(traffic.sample(), { downloadBytesPerSecond: 2048, uploadBytesPerSecond: 512 });
  traffic.receive(4096);
  now = 3000;
  assert.equal(traffic.sample().downloadBytesPerSecond, 2048, 'use actual elapsed time after a delayed frame');
  now = 4000;
  assert.deepEqual(traffic.sample(), { downloadBytesPerSecond: 0, uploadBytesPerSecond: 0 });
});

test('cached resources and invalid transfer sizes do not create fictitious traffic', () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  recordResourceTransfer({ transferSize: 0, decodedBodySize: 1024 * 1024 } as PerformanceResourceTiming, traffic);
  traffic.receive(NaN); traffic.receive(-1); traffic.send(Infinity);
  now = 1000;
  assert.deepEqual(traffic.sample(), { downloadBytesPerSecond: 0, uploadBytesPerSecond: 0 });
});

test('HTTP upload tracking preserves response identity, stream ownership and request options', async () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  const response = new Response('response body');
  const init: RequestInit = { method: 'POST', body: 'é', credentials: 'include', signal: new AbortController().signal };
  const tracked = trackHttpUploads(async (input, options) => {
    assert.equal(input, '/upload'); assert.equal(options, init);
    return response;
  }, traffic);
  assert.equal(await tracked('/upload', init), response);
  assert.equal(response.bodyUsed, false);
  now = 1000;
  assert.equal(traffic.sample().uploadBytesPerSecond, 2, 'count UTF-8 bytes, not character count');
  const rejected = trackHttpUploads(async () => { throw new Error('aborted'); }, traffic);
  await assert.rejects(rejected('/upload', init));
  now = 2000;
  assert.equal(traffic.sample().uploadBytesPerSecond, 0);
});

test('binary realtime sends count payload once and do not count rejected sends', () => {
  let now = 0;
  const traffic = new NetworkTraffic(() => now);
  const payload = new Uint8Array(256);
  sendRealtimeBytes({ send(data) { assert.equal(data, payload); } }, payload, traffic);
  assert.throws(() => sendRealtimeBytes({ send() { throw new Error('closed'); } }, payload, traffic));
  now = 1000;
  assert.equal(traffic.sample().uploadBytesPerSecond, 256);
});

test('payload sizes and rate units cover text and binary world uploads', () => {
  assert.equal(bodyByteLength(new Uint8Array(100).subarray(10, 20)), 10);
  assert.equal(bodyByteLength(new ArrayBuffer(123)), 123);
  assert.equal(bodyByteLength(new Blob(['é'])), 2);
  assert.equal(bodyByteLength(undefined), 0);
  assert.equal(formatByteRate(0), '0 B/s');
  assert.equal(formatByteRate(1536), '1.5 KiB/s');
  assert.equal(formatByteRate(2 * 1024 * 1024), '2.0 MiB/s');
});
