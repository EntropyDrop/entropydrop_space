import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NetworkPayloadTooLargeError,
  readJsonResponse,
  readResponseBytes,
  resolveSafeHttpUrl,
  sha256Hex,
} from '../src/bootstrap/NetworkSafety.ts';

test('bounded network readers reject declared and streamed payload overflow', async () => {
  await assert.rejects(
    () => readResponseBytes(new Response('tiny', { headers: { 'Content-Length': '100' } }), 10),
    NetworkPayloadTooLargeError
  );
  await assert.rejects(
    () => readResponseBytes(new Response('12345678901'), 10),
    NetworkPayloadTooLargeError
  );
  assert.deepEqual(
    await readJsonResponse(new Response('{"ok":true}'), 64),
    { ok: true }
  );
});

test('external resource URLs require HTTPS except on local development hosts', () => {
  assert.equal(resolveSafeHttpUrl('https://cdn.example.test/a.pb').protocol, 'https:');
  assert.equal(resolveSafeHttpUrl('http://localhost:8000/a.pb').protocol, 'http:');
  assert.throws(() => resolveSafeHttpUrl('http://cdn.example.test/a.pb'), /HTTPS/);
  assert.throws(() => resolveSafeHttpUrl('data:text/plain,nope'), /HTTPS/);
});

test('bounded readers report incremental bytes before a streamed response finishes', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const progress: number[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const reading = readResponseBytes(response, 8, bytes => progress.push(bytes));
  controller.enqueue(new Uint8Array([1, 2]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(progress, [0, 2]);
  controller.enqueue(new Uint8Array([3, 4, 5]));
  controller.close();
  assert.deepEqual([...await reading], [1, 2, 3, 4, 5]);
  assert.deepEqual(progress, [0, 2, 5]);

  progress.length = 0;
  const fallback = { headers: new Headers(), async arrayBuffer() { return new Uint8Array([6, 7]).buffer; } } as Response;
  await readResponseBytes(fallback, 8, bytes => progress.push(bytes));
  assert.deepEqual(progress, [0, 2]);
  progress.length = 0;
  await assert.rejects(() => readResponseBytes(new Response(new Uint8Array(9)), 8,
    bytes => progress.push(bytes)), NetworkPayloadTooLargeError);
  assert.deepEqual(progress, [0], 'unsafe bytes must not be reported as accepted progress');
});

test('sha256Hex returns a stable lowercase digest', async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
