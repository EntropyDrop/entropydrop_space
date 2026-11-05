import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeVoxelTile, VOXEL_BAKE_SIZE, DEFAULT_VOXEL_TEXTURE_BAKE } from '../src/render/VoxelTextureBake.ts';
import { VoxelTexturePool } from '../src/render/VoxelTexturePool.ts';
import { VoxelLodPlanner, voxelTileTransfers, type VoxelLodTile } from '../src/render/VoxelLodPlanner.ts';
import { SurfaceBatch } from '../src/render/SurfaceBatch.ts';
import { createVoxelSurfaceMaterial } from '../src/render/DistantVoxelLayer.ts';
import * as THREE from 'three/webgpu';

function finish<T>(generator: Generator<unknown, T>): T {
  while (true) { const result = generator.next(); if (result.done) return result.value; }
}
function tile(): VoxelLodTile {
  const positions: number[] = [], spans: number[] = [], dirs: number[] = [], emissions: number[] = [], colors: number[] = [];
  for (let dir = 0; dir < 6; dir++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    if (x === 3 && y === 3) continue;
    const dim = dir >> 1, p = [0, 0, 0]; p[dim] = 16 + dir; p[(dim + 1) % 3] = 64 + x; p[(dim + 2) % 3] = 64 + y;
    positions.push(...p.map(v => v * 8)); spans.push(8, 8); dirs.push(dir); emissions.push(y > 5 ? 1 : 0);
    colors.push(x * 31, y * 31, dir * 40);
  }
  return { key: '0,0', token: 1, tile: 0, count: dirs.length, offset: Uint16Array.from(positions), span: Uint16Array.from(spans),
    direction: Uint8Array.from(dirs), emission: Uint8Array.from(emissions), color: Uint8Array.from(colors),
    bounds: [0, 0, 0, 100], flatBounds: [0, 128, 0, 128] };
}
function coverage(t: Pick<VoxelLodTile, 'count' | 'offset' | 'span' | 'direction' | 'color' | 'emission'>, pixels?: Uint8Array) {
  const result = new Map<string, string>();
  for (let i = 0; i < t.count; i++) {
    const dir = t.direction[i] & 7, dim = dir >> 1, u = (dim + 1) % 3, v = (dim + 2) % 3;
    const p = [...t.offset.subarray(i * 3, i * 3 + 3)].map(v => v / 8), rgb = t.color.subarray(i * 3, i * 3 + 3);
    for (let y = 0; y < t.span[i * 2 + 1] / 8; y++) for (let x = 0; x < t.span[i * 2] / 8; x++) {
      const q = [...p]; q[u] += x; q[v] += y;
      const key = `${dir}/${q.join(',')}`; assert.equal(result.has(key), false);
      let color = [...rgb];
      if (t.direction[i] & 128) {
        assert.ok(pixels); const at = ((rgb[1] + Math.floor((y + .5) * rgb[2] / 8)) * Math.sqrt(pixels.length / 4) + rgb[0] + Math.floor((x + .5) * rgb[2] / 8)) * 4;
        color = [...pixels.subarray(at, at + 3)];
      }
      result.set(key, `${t.emission[i]}/${color.join(',')}`);
    }
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b));
}
for (const edge of [8, 16, 24, 32]) for (const density of [1, 2]) test(`bake ${edge}m/${density} restores six orientations, holes, color and emission`, () => {
  const source = tile(), original = source.offset.slice(), baked = finish(bakeVoxelTile(source, edge, density));
  assert.ok(baked); assert.ok(baked.count < source.count / 2);
  assert.deepEqual(coverage(baked, baked.pixels), coverage(source)); assert.deepEqual(source.offset, original);
  const transfer = voxelTileTransfers({ ...source, baked });
  assert.ok(transfer.includes(baked.pixels.buffer as ArrayBuffer)); assert.equal(new Set(transfer).size, transfer.length);
});

test('overlapping or invalid source geometry keeps the original tile', () => {
  const source = tile(); source.offset.set(source.offset.subarray(0, 3), 3);
  assert.equal(finish(bakeVoxelTile(source)), undefined);
  assert.throws(() => finish(bakeVoxelTile(source, 40)), /Invalid/);
});

test('coarse proxies project detailed colors from the nearest matching depth layer', () => {
  const original = tile();
  // One coarse quad replaces a complete 8x8 roof, displaced by one metre.
  // A second roof at another depth must keep its own colors.
  const detail = { ...original, count: 128, offset: new Uint16Array(128 * 3), span: new Uint16Array(128 * 2).fill(8),
    direction: new Uint8Array(128).fill(3), emission: new Uint8Array(128), color: new Uint8Array(128 * 3) };
  for (let roof = 0; roof < 2; roof++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
    const i = roof * 64 + z * 8 + x;
    detail.offset.set([x * 8, (20 + roof * 8) * 8, z * 8], i * 3);
    detail.color.set([roof * 200, x * 20, z * 20], i * 3);
  }
  const coarse = { ...original, count: 2, offset: new Uint16Array([0,21*8,0,0,29*8,0]), span: new Uint16Array([64,64,64,64]),
    direction: new Uint8Array([3,3]), emission: new Uint8Array(2), color: new Uint8Array(6) };
  const baked = finish(bakeVoxelTile(coarse, 16, 1, detail, 2)); assert.ok(baked);
  assert.equal(baked.count, 2); assert.equal(baked.originalFaces, 128);
  const projected = coverage(baked, baked.pixels);
  const expected = coverage(detail).map(([key,value]) => {
    const [dir, xyz] = key.split('/'), p = xyz.split(',').map(Number); p[1]++;
    return [`${dir}/${p.join(',')}`,value];
  });
  assert.deepEqual(projected, expected);
  assert.equal(finish(bakeVoxelTile(coarse, 16, 1, detail, .5)), undefined, 'out-of-range colors keep the uniform fallback');
});

test('coarse cells retain exact colors without duplicating one texel per metre', () => {
  const source=tile();source.offset=Uint16Array.from(source.offset,v=>v*4);source.span.fill(32);
  const baked=finish(bakeVoxelTile(source,16,1));assert.ok(baked);
  assert.deepEqual(coverage(baked,baked.pixels),coverage(source));
  for(let i=0;i<baked.count;i++)if(baked.direction[i]&128)assert.equal(baked.color[i*3+2],2,'one texel per four metres');
});

test('pool does not overwrite live layers and releases each slot only once', () => {
  const pool = new VoxelTexturePool(8, false), pixels = new Uint8Array(256 * 256 * 4), leases = [];
  for (let i = 0; i < 32; i++) { pixels.fill(i); const lease = pool.acquire(pixels); assert.ok(lease); leases.push(lease); }
  assert.equal(pool.acquire(pixels), null); assert.equal(pool.stats.used, 32);
  assert.equal(pool.texture.image.data![0], 0);
  leases[4].release(); leases[4].release(); assert.equal(pool.stats.used, 31);
  const next = pool.acquire(pixels); assert.equal(next?.layer, leases[4].layer);
  next?.release(); for (const lease of leases) lease.release(); assert.equal(pool.stats.used, 0); pool.dispose();
});

test('small atlases share layers without overwriting neighboring live generations', () => {
  const pool = new VoxelTexturePool(8, false), small = new Uint8Array(64 * 64 * 4).fill(23);
  const a = pool.acquire(small, 64)!, b = pool.acquire(new Uint8Array(128 * 128 * 4).fill(71), 128)!;
  assert.equal(a.layer, b.layer); assert.equal(pool.stats.used, 2); assert.equal(pool.stats.layers, 1);
  const data = pool.texture.image.data!, sample = (x:number,y:number) => data[(y*256+x)*4];
  assert.equal(sample(a.x,a.y),23); assert.equal(sample(b.x,b.y),71);
  a.release(); a.release(); assert.equal(pool.stats.used,1); assert.equal(pool.stats.layers,1);
  const c=pool.acquire(new Uint8Array(64*64*4).fill(42),64)!;
  assert.deepEqual([c.x,c.y],[a.x,a.y]); assert.equal(sample(c.x,c.y),42); assert.equal(sample(b.x,b.y),71);
  b.release();c.release();assert.equal(pool.stats.layers,0);pool.dispose();
});

test('retired baked materials detach from the texture pool and handoff mask', () => {
  const pool=new VoxelTexturePool(8,false),mask=new THREE.DataTexture(new Uint8Array(4),1,1);
  const material=createVoxelSurfaceMaterial(mask,new THREE.Vector2(0,1),new THREE.Vector3(),{value:true},true,undefined,pool.texture);
  let disposals=0;material.addEventListener('dispose',()=>disposals++);
  material.dispose();pool.dispose();mask.dispose();assert.equal(disposals,1);
});

test('surface generations retain texture ownership through fade and GPU buffer retirement', () => {
  const root = new THREE.Group(), batch = new SurfaceBatch(root, 'bake', new THREE.Sphere(), () => new THREE.Mesh(
    new THREE.InstancedBufferGeometry(), new THREE.MeshStandardNodeMaterial()), 100);
  let released = 0;
  const attrs = () => ({ voxelDirection: new THREE.InstancedBufferAttribute(new Float32Array([131]), 1) });
  batch.submitPrepared(attrs(), 1, false, 0, { releaseResources: () => released++ });
  batch.top.geometry.dispose(); assert.equal(released, 0, 'arena migration must retain its texture');
  batch.submitPrepared(attrs(), 1, true, 10, { releaseResources: () => released++ });
  batch.advance(60); assert.equal(released, 0);
  batch.advance(110); assert.equal(released, 1);
  batch.dispose(); assert.equal(released, 2);
});

test('planner republishes texture policy revisions without modifying source mips', () => {
  const t = tile(), faces = new Uint8Array(t.count * 16), view = new DataView(faces.buffer);
  // Use one brick/direction so the source follows the production range ordering.
  const count = 64;
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) view.setUint16(i * 16 + d * 2, t.offset[i * 3 + d], true);
    view.setUint16(i * 16 + 6, 8, true); view.setUint16(i * 16 + 8, 8, true);
    faces[i * 16 + 10] = t.direction[i]; faces.set(t.color.subarray(i * 3, i * 3 + 3), i * 16 + 12);
  }
  const planner = new VoxelLodPlanner(); finish(planner.install({ key: '0,0', x: 0, z: 0, token: 1, mips: [{ cellSize: 1, faces: faces.slice(0, count * 16) }] }));
  const camera: [number, number, number] = [3000, 1000, 3000];
  const config = { camera, focal: 720, area: 1, distance: 32768, faceBudget: 10000, hasView: true,
    projection: 'flat' as const, fixedCellSize: 1, bake: { ...DEFAULT_VOXEL_TEXTURE_BAKE, textureProxyEnabled: true } };
  const published = (revision: number) => [...planner.build({ ...config, bakeRevision: revision })].filter(Boolean) as VoxelLodTile[];
  const first=published(1);assert.ok(first.some(tile=>tile.baked));
  assert.equal(published(1).length, 0); assert.ok(published(2).length);
});
