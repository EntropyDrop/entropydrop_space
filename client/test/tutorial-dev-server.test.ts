import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { devTutorialLevel } from '../tools/dev-tutorial-level.mjs';
import source from '../src/tutorial/tutorial-level.json' with { type: 'json' };

async function fixture(t: { after(fn: () => Promise<void>): void }, mounted = false) {
  const root = await mkdtemp(join(tmpdir(), 'tutorial-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'src/tutorial');
  const file = join(directory, 'tutorial-level.json');
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(source));
  let middleware: any;
  const plugin = devTutorialLevel(mounted ? { root } : undefined);
  const serverRoot = mounted ? join(root, 'main-site') : root;
  const base = mounted ? '/' : '/space/app/';
  (plugin.configureServer as Function)({
    config: { root: serverRoot, base },
    middlewares: { use(handler: any) { middleware = handler; } },
  });
  const request = async (options: Record<string, any> = {}) => {
    const req = Object.assign(new PassThrough(), {
      url: options.url ?? `${base}__dev/tutorial-level`,
      method: options.method ?? 'PUT',
      socket: { remoteAddress: options.address ?? '127.0.0.1' },
      headers: {
        host: 'localhost:5174', origin: 'http://localhost:5174', 'content-type': 'application/json',
        ...options.headers,
      },
    });
    let status = 0, body = '', nextCalled = false;
    const res = {
      writeHead(code: number) { status = code; },
      end(data: string) { body = data; },
    };
    const pending = middleware(req, res, () => { nextCalled = true; });
    req.end(options.body ?? JSON.stringify(source));
    await pending;
    return { status, body: body ? JSON.parse(body) : null, nextCalled };
  };
  return { directory, file, plugin, request, serverRoot };
}

test('a host app serves the writer at its base and saves to the mounted Space project', async t => {
  const { file, serverRoot, request } = await fixture(t, true);
  const level = { ...source, name: 'Mounted tutorial' };
  assert.deepEqual(await request({ body: JSON.stringify(level) }), {
    status: 200, body: { saved: true }, nextCalled: false,
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), level);
  await assert.rejects(readFile(join(serverRoot, 'src/tutorial/tutorial-level.json')), { code: 'ENOENT' });
  assert.equal((await request({ headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await request({ address: '192.168.1.2' })).status, 403);
});

test('local development saves directly over the level file with no temporary files left behind', async t => {
  const { file, directory, request, plugin } = await fixture(t);
  const level = {
    ...source, name: 'Saved lesson',
    spawn: { ...source.spawn, x_cm: 819400 },
    terrain: { ...source.terrain, standard: [[8194, 17, 1024, 1, 0xff0000]] },
  };
  assert.deepEqual(await request({ body: JSON.stringify(level) }), { status: 200, body: { saved: true }, nextCalled: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), level);
  level.name = 'Updated lesson';
  await request({ body: JSON.stringify(level) });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), level);
  assert.deepEqual(await readdir(directory), ['tutorial-level.json']);
  assert.equal(plugin.apply, 'serve');
  assert.equal('configurePreviewServer' in plugin, false);
  assert.equal((await request({ url: '/space/app/unrelated' })).nextCalled, true);
});

test('remote peers, foreign origins and non-loopback hosts cannot overwrite the lesson', async t => {
  const { file, request } = await fixture(t);
  const original = await readFile(file, 'utf8');
  for (const options of [
    { address: '192.168.1.10' },
    { address: '203.0.113.1' },
    { headers: { origin: 'https://example.com' } },
    { headers: { origin: undefined } },
    { headers: { origin: 'http://localhost:9999' } },
    { headers: { host: 'example.com', origin: 'http://example.com' } },
    { headers: { host: '192.168.1.2:5174', origin: 'http://192.168.1.2:5174' } },
  ]) {
    assert.equal((await request(options)).status, 403);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  for (const address of ['::1', '::ffff:127.0.0.1']) assert.equal((await request({ address })).status, 200);
});

test('bad requests preserve the previous lesson and write failures never report success', async t => {
  const { file, directory, request } = await fixture(t);
  const original = await readFile(file, 'utf8');
  for (const [options, status] of [
    [{ method: 'GET' }, 405],
    [{ method: 'OPTIONS' }, 405],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ body: '{broken' }, 400],
    [{ body: JSON.stringify({ ...source, version: 99 }) }, 400],
    [{ body: JSON.stringify({ ...source, spawn: { ...source.spawn, x_cm: -1 } }) }, 400],
    [{ body: Buffer.alloc(64 * 1024 * 1024 + 1, ' ') }, 413],
  ] as const) {
    assert.equal((await request(options)).status, status);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  // A directory at the destination makes rename fail without altering its contents.
  await rm(file);
  await mkdir(file);
  await writeFile(join(file, 'keep'), 'previous data');
  assert.equal((await request()).status, 500);
  assert.equal(await readFile(join(file, 'keep'), 'utf8'), 'previous data');
  assert.deepEqual(await readdir(directory), ['tutorial-level.json']);
});

test('saving invalidates the lesson module for next entry without reloading the editor', async t => {
  const { file, plugin } = await fixture(t);
  const module = { id: file };
  const invalidated: unknown[] = [];
  const context = {
    file, modules: [module],
    server: { moduleGraph: { invalidateModule(value: unknown) { invalidated.push(value); } } },
  };
  assert.deepEqual((plugin.handleHotUpdate as Function)(context), []);
  assert.deepEqual(invalidated, [module]);
  assert.equal((plugin.handleHotUpdate as Function)({ ...context, file: `${file}.tmp` }), undefined);
});
