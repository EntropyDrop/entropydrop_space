import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Quaternion, Vector3 } from 'three';
import { encodeInventoryResource, runtimeEntityToPortable } from '../../engine/src/storage/InventoryProtobuf.ts';
import { stats } from './benchmark.ts';

export async function measureDesktopBridge(fixture) {
  const world = await mkdtemp(join(tmpdir(), 'space-physics-bridge-'));
  try {
    const floor = Buffer.alloc(16 + 65536 * 4);
    floor.write('SPC1');
    for (let i = 0; i < 256; i++) floor.writeUInt32LE(0x01aaaaaa, 16 + i * 4);
    await mkdir(join(world, 'chunks'));
    await writeFile(join(world, 'chunks', '0_0.bin.gz'), gzipSync(floor));
    await writeFile(join(world, 'manifest.json'), JSON.stringify({ world: 'physics-bench', seed: 1, generator: 1 }));

    const template = runtimeEntityToPortable({
      rootComponentId: 'root', bodyType: 'dynamic', useGravity: true, mass: 10, friction: 0.7, restitution: 0,
      blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xaaaaaa, entityId: 'root' }],
    });
    const bytes = [...encodeInventoryResource('entity', template)];
    const entities = fixture.bodies.map((body, index) => {
      const rotation = new Quaternion().fromArray(body.rotation);
      const pivot = new Vector3(0.5, 0.5, 0.5).applyQuaternion(rotation);
      const position = new Vector3().fromArray(body.position).sub(pivot).toArray();
      return { id: `cube_${index}`, position, rotation: body.rotation, running: true, bytes };
    });

    const worker = fileURLToPath(new URL('../../native-space/tools/runtime-worker.ts', import.meta.url));
    const child = spawn(process.execPath, [worker, `--world-dir=${world}`], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exit = once(child, 'exit');
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const replies = lines[Symbol.asyncIterator]();

    let epoch = 0;
    async function request(steps, definitions) {
      const start = performance.now();
      const data = { epoch: epoch++, chunks: [[0, 0]], edits: [], steps, down: [], player: [8, 4, 8],
        ...(definitions === undefined ? {} : { entities: definitions }) };
      child.stdin.write(JSON.stringify(data) + '\n');
      const line = await replies.next();
      if (line.done) throw Error('The desktop runtime exited before sending a frame');
      const result = JSON.parse(line.value);
      const elapsed = performance.now() - start;
      assert.equal(result.ok, true, result.error);
      assert.equal(result.epoch, data.epoch);
      return { elapsed, result, bytes: Buffer.byteLength(line.value) + 1 };
    }

    try {
      const withoutStep = [], withStep = [], responseSize = [];
      for (let round = -6; round < fixture.rounds; round++) {
        await request(0, []);
        const initial = await request(0, entities);
        assert.equal(initial.result.entities.length, entities.length);
        for (let i = 0; i < fixture.warmup; i++) await request(3);
        for (let i = 0; i < fixture.ticks; i++) {
          for (const steps of (round % 2 === 0 ? [0, 3] : [3, 0])) {
            const { elapsed, result, bytes: responseBytes } = await request(steps);
            assert.equal(result.entities.length, entities.length);
            if (round < 0) continue;
            (steps ? withStep : withoutStep).push(elapsed);
            if (steps) responseSize.push(responseBytes);
          }
        }
        const after = await request(0);
        const top = after.result.entities.find(entity => entity.id === 'cube_3').position[1];
        assert.ok(top > 4.3 && top < initial.result.entities[3].position[1], `Unexpected stack height ${top}`);
      }
      return {
        withoutStep: stats(withoutStep), threeManagerUpdates: stats(withStep),
        responseBytes: Math.round(responseSize.reduce((sum, value) => sum + value, 0) / responseSize.length),
        raw: { withoutStep, threeManagerUpdates: withStep, responseSize },
      };
    } finally {
      child.stdin.end();
      const [status] = await exit;
      lines.close();
      if (status !== 0) throw Error(`Desktop runtime exit status ${status}`);
    }
  } finally {
    await rm(world, { recursive: true, force: true });
  }
}
