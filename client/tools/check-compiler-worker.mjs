import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

if (!isMainThread) {
  // Run the production asset with browser worker globals. Hiding process makes
  // the bundled compiler dependencies take their browser initialization paths.
  globalThis.process = undefined;
  globalThis.self = globalThis;
  globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
  globalThis.postMessage = message => parentPort.postMessage(message);
  await import(workerData.url);
  parentPort.on('message', data => globalThis.onmessage({ data }));
  parentPort.postMessage({ kind: 'booted' });
} else {
  const assets = process.argv[2]
    ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/assets/', import.meta.url));
  const files = (await readdir(assets)).filter(file => /^AssemblyScriptCompiler\.worker-.*\.js$/.test(file));
  assert.equal(files.length, 1, 'Expected exactly one production compiler worker');
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { url: pathToFileURL(resolve(assets, files[0])).href },
  });
  const receive = async () => (await once(worker, 'message', { signal: AbortSignal.timeout(30_000) }))[0];
  const request = async message => {
    const reply = receive();
    worker.postMessage(message);
    const result = await reply;
    assert.equal(result.id, message.id);
    return result;
  };
  try {
    assert.equal((await receive()).kind, 'booted');
    assert.equal((await request({ id: 1, kind: 'preload' })).kind, 'ready');
    const compiled = await request({ id: 2, kind: 'compile', source: 'while (true) {}' });
    assert.equal(compiled.kind, 'compiled', compiled.error);
    assert.ok(compiled.module instanceof WebAssembly.Module, 'WASM module must survive structured cloning');
    const sections = WebAssembly.Module.customSections(compiled.module, 'entity-memory-pages');
    assert.equal(sections.length, 1);
    const pages = new Uint8Array(sections[0])[0];
    assert.ok(pages >= 1 && pages <= 64);
    const instance = new WebAssembly.Instance(compiled.module, {
      env: { memory: new WebAssembly.Memory({ initial: pages, maximum: 64 }),
        abort() { throw new Error('Unexpected WASM abort'); }, seed: () => 0, trace() {} },
      entity: { budget() { throw new Error('fuel budget exhausted'); } },
    });
    instance.exports.__setFuel(0);
    assert.throws(() => instance.exports.__tick(0, 0), /fuel budget exhausted/);
    assert.equal((await request({ id: 3, kind: 'compile', source: 'invalid syntax!!!' })).kind, 'error');
    const retry = await request({ id: 4, kind: 'compile', source: '' });
    assert.equal(retry.kind, 'compiled', retry.error);
    console.log('Production compiler worker passed: preload, WASM transfer, fuel, and compile-error recovery.');
  } finally {
    await worker.terminate();
  }
}
