import test from 'node:test';
import assert from 'node:assert/strict';
import { voxelizeModel, type VoxelTriangle } from '../src/engine/voxel/ModelVoxelizer.ts';
import { setGeometryKernelMode } from '@entropydrop/space-engine/wasm/GeometryKernels.ts';
import { ModelVoxelKernels } from '@entropydrop/space-engine/wasm/ModelVoxelKernels.ts';
import { geometryCube } from '../../engine/test/geometry-fixtures.ts';

test('model WASM preserves complete colored voxel output across rotations, scales and hollow modes', () => {
  const previous = setGeometryKernelMode('js');
  try {
    for (const angle of [0, .17, .7]) for (const kind of ['flat', 'vertex', 'texture', 'transparent', 'gray']) {
      const triangles: VoxelTriangle[] = geometryCube(2, angle).map((t, i) => ({ ...t,
        color: kind === 'flat' ? i % 3 ? 0x123456 : 0 : 0x87c4ff,
        ...(kind !== 'flat' ? { vertexColors: [[255, 0, 64], [0, 255, 128], [64, 128, 255]] as VoxelTriangle['vertexColors'] } : {}),
        ...(['texture', 'transparent', 'gray'].includes(kind) ? {
          uvs: [[-.25, .5], [1.25, 0], [.5, 1]] as VoxelTriangle['uvs'], flipY: i % 2 === 0,
          texture: { width: 2, height: 2, channels: kind === 'gray' ? 1 : 4,
            data: kind === 'gray' ? new Uint8Array([0, 64, 128, 255])
              : new Uint8Array([255, 0, 0, kind === 'transparent' ? 0 : 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) },
        } : {}),
      }));
      for (const hollow of [false, true]) for (const micro of [false, true]) {
        const options = { hollow, micro, scale: .85 }, size = micro ? .125 : .5;
        setGeometryKernelMode('js'); const expected = voxelizeModel(triangles, size, 0x654321, options);
        setGeometryKernelMode('wasm'); const actual = voxelizeModel(triangles, size, 0x654321, options);
        assert.deepEqual(actual, expected, `${angle}/${kind}/${hollow}/${micro}`);
      }
    }
  } finally { setGeometryKernelMode(previous); }
});

test('private model arenas survive interleaved imports and reject oversized layouts before allocation', () => {
  const previous = setGeometryKernelMode('wasm');
  try {
    const triangles = geometryCube(1), buckets = new Map([['0,0', triangles.map((_, i) => i)]]);
    const dimensions = { sx: 3, sy: 3, sz: 3, minX: -1, minY: -1, minZ: -1, size: 1 };
    const first = ModelVoxelKernels.create(triangles, buckets, 2, dimensions)!;
    const second = ModelVoxelKernels.create(triangles, buckets, 2, dimensions)!;
    assert.ok(first); assert.ok(second);
    const fill = (kernel: ModelVoxelKernels) => {
      const grid = new Uint8Array(27), colors = new Int32Array(27).fill(-1);
      kernel.fill(grid, colors, 0x123456); return { grid, colors };
    };
    assert.deepEqual(fill(first), fill(second));
    const a = first.hollow(true), b = second.hollow(true);
    assert.deepEqual(a, b); assert.notEqual(a.buffer, b.buffer);
    const firstHits: number[][] = [], secondHits: number[][] = [];
    first.sampleSurface((...record) => firstHits.push(record));
    second.sampleSurface((...record) => secondHits.push(record));
    assert.deepEqual(firstHits, secondHits);
    const repeated: number[][] = [];
    first.sampleSurface((...record) => repeated.push(record));
    assert.deepEqual(repeated, firstHits);
    assert.equal(ModelVoxelKernels.create(triangles, buckets, 2, { ...dimensions, sx: 32768, sy: 1024, sz: 1 }), null);
    assert.equal(ModelVoxelKernels.create(triangles, buckets, 2, { ...dimensions, minX: 1e20 }), null);
  } finally { setGeometryKernelMode(previous); }
});
