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

test('sha256Hex returns a stable lowercase digest', async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
