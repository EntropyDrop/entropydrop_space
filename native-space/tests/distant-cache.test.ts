import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { DistantCoverageCache, decodeVoxelCache } from '../tools/distant-cache.ts';
import { packDistantTile } from '../tools/distant-packing.ts';
import { encodeVoxelLevels } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import type { VoxelLodTile } from '../../engine/src/render/VoxelLodPlanner.ts';

const identity = { world: 'test', seed: 42, generator: 1, source_hash: 'fixture-v1' };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'space-native-lod-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function mips() {
  return [1, 2, 4, 8, 16, 32, 64].map(cellSize => {
    const faces = Buffer.alloc(16); faces.writeUInt16LE(cellSize * 8, 6); faces.writeUInt16LE(cellSize * 8, 8);
    faces[10] = 3; faces[12] = 123; faces[13] = 45; faces[14] = 67;
    return { cellSize, faces };
  });
}

test('coverage cache restores only verified source-scoped data and retains a complete index during refinement', t => {
  const dir = fixture(t), cache = new DistantCoverageCache(dir, identity), levels = mips();
  for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) assert.ok(cache.store(x, z, levels));
  const reopened = new DistantCoverageCache(dir, identity);
  assert.deepEqual(reopened.read(31, 3), [{ cellSize: 64, faces: new Uint8Array(levels.at(-1)!.faces) }]);
  assert.ok(reopened.store(0, 0, levels));
  const index = JSON.parse(readFileSync(join(dir, 'coverage-v1.json'), 'utf8'));
  assert.equal(index.complete, true); assert.equal(index.zones.length, 128);
  for (const change of [{ seed: 7 }, { generator: 3 }, { source_hash: 'other' }, { world: 'other' }])
    assert.equal(new DistantCoverageCache(dir, { ...identity, ...change }).read(0, 0), undefined);
  const path = join(dir, '0_0.overview.vxl.gz'), corrupt = readFileSync(path); corrupt[corrupt.length - 1] ^= 1;
  writeFileSync(path, corrupt); assert.equal(reopened.read(0, 0), undefined);
  assert.ok(reopened.read(1, 0));
  assert.ok(reopened.store(0, 0, levels)); assert.ok(reopened.read(0, 0));
  writeFileSync(join(dir, 'coverage-v1.json'), '{broken');
  assert.equal(new DistantCoverageCache(dir, identity).read(1, 0), undefined);
});

test('cache failures are optional and bounded decoders reject malformed levels', t => {
  const dir = fixture(t), file = join(dir, 'not-a-directory'); writeFileSync(file, 'fixture');
  const cache = new DistantCoverageCache(file, identity);
  assert.equal(cache.store(0, 0, mips()), false); assert.equal(cache.read(0, 0), undefined);
  const valid = encodeVoxelLevels(mips());
  assert.equal(decodeVoxelCache(valid).length, 7);
  for (const length of [0, 7, 9, valid.length - 1]) assert.throws(() => decodeVoxelCache(valid.subarray(0, length)));
  const bad = valid.slice(); bad[8] = 3; assert.throws(() => decodeVoxelCache(bad));
  const extra = new Uint8Array(valid.length + 1); extra.set(valid); assert.throws(() => decodeVoxelCache(extra));
});

export function packingFixture(count: number): VoxelLodTile {
  const tile: VoxelLodTile = { key: '0,0', token: 1, tile: 0, count, bounds: [0,0,0,1], flatBounds: [0,0,0,1],
    offset: new Uint16Array(count*3), span: new Uint16Array(count*2), color: new Uint8Array(count*3),
    direction: new Uint8Array(count), emission: new Uint8Array(count), visibility: new Float32Array(Math.ceil(count/16)*12) };
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) { tile.offset[i*3+c] = (i*37+c*251)&65535; tile.color[i*3+c] = (i*71+c*99)&255; }
    tile.span[i*2] = i&65535; tile.span[i*2+1] = 65535-(i&65535); tile.direction[i] = i%6; tile.emission[i] = i%2;
  }
  for (let i = 0; i < tile.visibility!.length; i++) tile.visibility![i] = (i%19-9)/7;
  return tile;
}
test('packed IPC bytes match the previous writer at group boundaries and full integer ranges', () => {
  for (const count of [0, 1, 15, 16, 17, 257, 65536]) {
    const tile = packingFixture(count); assert.deepEqual(packDistantTile(tile), packDistantTile(tile, true));
  }
  const invalid = packingFixture(17); invalid.visibility = new Float32Array(12);
  assert.throws(() => packDistantTile(invalid));
});

test('cached coverage publishes before fine sources; final tiles and moving refinements match the legacy loader', { timeout: 30000 }, async t => {
  const root = fixture(t), dir = join(root, 'distant', identity.source_hash); mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(identity));
  const levels = mips(), cache = new DistantCoverageCache(dir, identity);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
    writeFileSync(join(dir, `${x}_${z}.vxl.gz`), gzipSync(encodeVoxelLevels(levels))); cache.store(x,z,levels);
  }
  async function run(legacy: boolean) {
    const child = spawn(process.execPath, [resolve('native-space/tools/distant.ts'), root, ...(legacy ? ['--legacy-loading'] : [])], { stdio: ['pipe','pipe','pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator](); let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const ended = new Promise<void>(r => child.once('exit', () => r()));
    const state = new Map<string, Buffer>();
    const request = async (camera = [256,100,256], edits: unknown[] = []) => {
      child.stdin.write(JSON.stringify({ camera, height: 720, torus: true, edits })+'\n');
      const row = await lines.next(); assert.ok(!row.done, errors);
      const frame = JSON.parse(row.value); assert.equal(frame.ok, true, frame.error);
      for (const tile of frame.tiles) state.set(tile.key, readFileSync(join(dir, tile.file)));
      return frame;
    };
    try {
      let frame = await request();
      assert.equal(frame.refinedZones, legacy ? 1 : 0);
      assert.equal(frame.zones, legacy ? 1 : 128);
      for (let n = 0; !frame.ready && n < 129; n++) frame = await request();
      assert.equal(frame.ready, true); assert.equal(frame.refinedZones, 128);
      const settled = new Map(state);
      const idle = await request(); assert.equal(idle.tiles.length, 0);
      if (!legacy) assert.equal(idle.unchanged, true);
      for (const camera of [[300,100,256],[300,120,320],[256,100,256]]) await request(camera);
      return { settled, moved: state };
    } finally { child.kill(); await ended; }
  }
  const reference = await run(true), candidate = await run(false);
  assert.deepEqual(candidate.settled, reference.settled);
  assert.deepEqual(candidate.moved, reference.moved);
  // A saved terrain edit must not briefly restore stale base coverage for its zone.
  const child = spawn(process.execPath, [resolve('native-space/tools/distant.ts'), root], { stdio: ['pipe','pipe','pipe'] });
  const ended = new Promise<void>(r => child.once('exit', () => r()));
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(JSON.stringify({ camera: [256,100,256], height: 720, torus: true,
      edits: [[{x: 1, y: 2, z: 3, micro: false}, 0]] })+'\n');
    const row = await lines.next(); assert.ok(!row.done);
    const frame = JSON.parse(row.value); assert.equal(frame.ok, true);
    assert.equal(frame.cacheRestoredZones, 127);
    assert.ok(frame.tiles.every((tile: {key: string}) => !tile.key.startsWith('far:0,0:')));
    assert.ok(new DistantCoverageCache(dir, identity).read(0,0), 'Base cache is retained, never overwritten by edits');
  } finally { child.kill(); await ended; }
});
