import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserScriptCompiler, type CompilerRequest, type CompilerResponse } from '../src/scripting/AssemblyScriptCompiler.browser.ts';
import { compileEntityScript, getCompiledEntityScript } from '../src/scripting/AssemblyScriptCompiler.ts';

const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
type WorkerPort = ReturnType<NonNullable<ConstructorParameters<typeof BrowserScriptCompiler>[0]>>;
function fixture(timeoutMs = 30_000) {
  const workers: ReturnType<typeof worker>[] = [];
  function worker() {
    const requests: CompilerRequest[] = [];
    const instance = {
      onmessage: null as WorkerPort['onmessage'],
      onerror: null as WorkerPort['onerror'],
      onmessageerror: null as WorkerPort['onmessageerror'],
      terminated: false,
      postMessage(request: CompilerRequest) { requests.push(request); },
      terminate() { instance.terminated = true; },
      requests,
      respond(reply: CompilerResponse) {
        instance.onmessage?.call(instance as unknown as Worker, new MessageEvent('message', { data: reply }));
      },
      fail() { instance.onerror?.call(instance as unknown as Worker, new Event('error') as ErrorEvent); },
    };
    return instance;
  }
  const compiler = new BrowserScriptCompiler(() => {
    const next = worker(); workers.push(next); return next;
  }, timeoutMs);
  return { compiler, workers };
}

test('duplicate browser compiles share one request and failed source can retry', async () => {
  const { compiler, workers } = fixture();
  const first = compiler.compile('same');
  assert.equal(compiler.compile('same'), first);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.length, 1);
  workers[0].respond({ id: 1, kind: 'error', error: 'invalid source' });
  await assert.rejects(first, /invalid source/);
  const retry = compiler.compile('same');
  workers[0].respond({ id: 2, kind: 'compiled', module });
  assert.equal(await retry, module);
});

test('browser queue limits unique requests; one reply frees capacity', async () => {
  const { compiler, workers } = fixture();
  const pending = Array.from({ length: 64 }, (_, i) => compiler.compile(`script ${i}`));
  assert.equal(compiler.compile('script 0'), pending[0]);
  await assert.rejects(compiler.compile('overflow'), /queue is full/);
  workers[0].respond({ id: 1, kind: 'compiled', module });
  await pending[0];
  const last = compiler.compile('overflow');
  for (const request of workers[0].requests.slice(1)) workers[0].respond({ id: request.id, kind: 'compiled', module });
  await Promise.all([...pending, last]);
  assert.equal(workers[0].requests.length, 65);
});

test('worker failure rejects all requests and late responses cannot affect a replacement', async () => {
  const { compiler, workers } = fixture();
  const failed = [compiler.compile('one'), compiler.compile('two')];
  const settled = Promise.allSettled(failed);
  workers[0].fail();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.ok(workers[0].terminated);
  const retry = compiler.compile('one');
  workers[0].respond({ id: 3, kind: 'error', error: 'late response' });
  workers[1].respond({ id: 3, kind: 'compiled', module });
  assert.equal(await retry, module);
});

test('browser preload stays in the worker, coalesces, and resets after failure', async () => {
  const { compiler, workers } = fixture();
  const preload = compiler.warmup();
  assert.equal(compiler.warmup(), preload);
  assert.deepEqual(workers[0].requests, [{ id: 1, kind: 'preload' }]);
  workers[0].respond({ id: 1, kind: 'ready' });
  await preload;
  workers[0].fail();
  const retry = compiler.warmup();
  workers[1].respond({ id: 2, kind: 'ready' });
  await retry;
});

test('timeout terminates the stalled worker; oversized input never starts one', async () => {
  const { compiler, workers } = fixture(5);
  await assert.rejects(compiler.compile('x'.repeat(65537)), /64 KiB/);
  assert.equal(workers.length, 0);
  await assert.rejects(compiler.compile('stalled'), /timed out/);
  assert.ok(workers[0].terminated);
  const retry = compiler.compile('stalled');
  workers[1].respond({ id: 2, kind: 'compiled', module });
  assert.equal(await retry, module);
});

test('shared compiler facade deduplicates concurrent source and retains the compiled module', async () => {
  const source = 'self.state.setNumber("compiler-cache-check", 987);';
  const first = compileEntityScript(source);
  assert.equal(compileEntityScript(source), first);
  const compiled = await first;
  assert.equal(getCompiledEntityScript(source), compiled);
  assert.equal(await compileEntityScript(source), compiled);
});
