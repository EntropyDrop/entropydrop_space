import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NativeRuntime, type Request } from '../tools/runtime-core.ts';
import { encodeInventoryResource } from '../../engine/src/storage/InventoryProtobuf.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'space-native-runtime-'));
  mkdirSync(join(dir, 'chunks'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ world: 'test', seed: 42, generator: 1 }));
  const data = Buffer.alloc(16 + 65536 * 4);
  data.write('SPC1');
  for (let i = 0; i < 256; i++) data.writeUInt32LE(0x01777777, 16 + i * 4);
  writeFileSync(join(dir, 'chunks/0_0.bin.gz'), gzipSync(data));
  const runtime = new NativeRuntime(dir);
  t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const request: Request = { epoch: 1, chunks: [[0, 0]], edits: [], entities: [], steps: 0,
    down: [], player: [4, 10, 4] };
  return { runtime, request };
}
function entity(extra: any = {}) {
  const portable: any = { type: 'space-entity', version: 8,
    root: { id: 'root', name: 'Native fixture', body: { type: 'dynamic', mass: 1 },
      blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xff5566 }], children: [], seats: [], ...extra }, constraints: [] };
  return { id: '10000000-0000-4000-8000-000000000001',
    bytes: [...encodeInventoryResource('entity', portable)], position: [4, 5, 4],
    rotation: [0, 0, 0, 1], running: false };
}

test('native chunk collision, Run, stable GPU geometry and Stop use shared physics', async t => {
  const { runtime, request } = fixture(t); const e = entity(); request.entities = [e];
  const first = await runtime.step(request);
  assert.deepEqual(first.entities[0].nodes[0].model.slice(12, 15), [4, 5, 4]);
  assert.equal(first.entities[0].nodes[0].voxels?.length, 1);
  e.running = true; request.steps = 5;
  let frame = await runtime.step(request);
  request.entities = undefined;
  for (let i = 0; i < 90; i++) frame = await runtime.step(request);
  const root = frame.entities[0].nodes[0];
  assert.ok(root.model[13] >= 0.95 && root.model[13] <= 1.1, `Cube should rest on floor: ${root.model[13]}`);
  assert.equal(root.voxels, null, 'unchanged geometry must not cross IPC every frame');
  e.running = false; request.entities = [e]; await runtime.step(request);
  request.entities = undefined;
  const stopped = await runtime.step(request);
  assert.equal(stopped.entities[0].running, false);
  const y = stopped.entities[0].position[1];
  assert.equal((await runtime.step(request)).entities[0].position[1], y);
});

test('AssemblyScript executes in the shared bounded sandbox, and compilation errors reach native UI', async t => {
  const { runtime, request } = fixture(t);
  const e = entity({ body: { type: 'dynamic', mass: 1, useGravity: false },
    scriptLanguage: 'assemblyscript', script: 'self.state.setNumber("ticks", self.state.getNumber("ticks") + 1); self.applyForce([0, 10, 0]);' });
  e.running = true; request.entities = [e]; request.steps = 1;
  await runtime.step(request); request.entities = undefined;
  for (let i = 0; i < 10; i++) await runtime.step(request);
  const c = runtime.manager.contraptions[0];
  assert.ok(Number(c.componentVariables.get('root')?.ticks) > 0);
  assert.ok(c.velocity.y > 0, 'guest force must affect the shared rigid body');
  const broken = entity({ scriptLanguage: 'assemblyscript', script: 'this is not valid code !!!' });
  broken.running = true; request.entities = [broken];
  const frame = await runtime.step(request);
  assert.ok(frame.entities[0].error, 'compile errors must be visible, not silently ignored');
});

test('micro terrain edits, hierarchy pivots and seats survive the native simulation boundary', async t => {
  const { runtime, request } = fixture(t);
  const e = entity({ body: { type: 'kinematic' }, pivot: [0.5, 0.5, 0.5],
    seats: [{ position: [0, 1, 0] }],
    children: [{ id: 'arm', pivot: [2.5, 0.5, 0.5], body: { type: 'kinematic' },
      blocks: [{ dx: 2, dy: 0, dz: 0, color: 0x48dbfb }], children: [], seats: [] }] });
  request.entities = [e];
  request.edits = [[{ x: 16, y: 16, z: 16, micro: true }, 0x01abcdef]];
  const frame = await runtime.step(request);
  assert.equal(runtime.world.microVoxels.get(16, 16, 16), 0xabcdef);
  assert.equal(frame.entities[0].nodes.length, 2);
  assert.ok(frame.entities[0].nodes.every(n => n.model.slice(12, 15).every(Number.isFinite)));
  assert.equal(frame.entities[0].nodes[0].seats.length, 1);
  request.entities = undefined;
  request.edits = [[{ x: 2, y: 2, z: 2, micro: false }, 0],
    [{ x: 16, y: 16, z: 16, micro: true }, 0x01abcdef]];
  await runtime.step(request);
  request.edits = []; request.chunks = []; await runtime.step(request);
  request.chunks = [[0, 0]]; await runtime.step(request);
  assert.equal(runtime.world.microVoxels.get(16, 16, 16), 0xabcdef, 'undo-restored micro detail survives unload/reload');
  request.edits = [[{ x: 16, y: 16, z: 16, micro: true }, 0]];
  request.entities = undefined; await runtime.step(request);
  assert.equal(runtime.world.microVoxels.get(16, 16, 16), null);
});
