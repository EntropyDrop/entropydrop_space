import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { bendPointForView, setTorusViewCorrection, setWorldProjection } from '../src/torus/TorusWorld.ts';
import { setGeometryKernelMode } from '../src/wasm/GeometryKernels.ts';

function host() {
  return Object.assign(Object.create(World.prototype), {
    rayBentPoint: new THREE.Vector3(), rayFlatPoint: new THREE.Vector3(), aimRaycastCachingEnabled: false,
  });
}

test('overlap skipping preserves exact hits and cell-read order at seams, edges and height limits', () => {
  const world = host(), previous = setGeometryKernelMode('js');
  let cases = 0, hits = 0;
  try {
    for (const kernel of ['js', 'wasm'] as const) for (const projection of ['flat', 'torus'] as const) {
      setGeometryKernelMode(kernel); setWorldProjection(projection);
      for (const corrected of [false, true]) for (const divisions of [1, 8]) {
        for (const [x, y, z] of [[100, 35, 100], [16383, 35, 2047], [0, 35, 0], [300, 0, 300], [300, 255, 300]]) {
          setTorusViewCorrection(corrected ? new THREE.Vector3(x, y + 3, z) : null);
          const cell = [x * divisions, y * divisions, z * divisions], size = 1 / divisions;
          for (const edge of [0, .001, .5, .999, 1]) {
            const origin = bendPointForView(x + edge * size, y + 3, z + .5 * size);
            const direction = bendPointForView(x + edge * size, y + .5 * size, z + .5 * size).sub(origin).normalize();
            const run = (optimized: boolean) => {
              world.aimRaycastDiscoveryOptimized = optimized;
              const reads: string[] = [];
              const hit = world.raycastBentVoxelFaces(origin, direction, 6, divisions, (a: number, b: number, c: number) => {
                reads.push(`${a},${b},${c}`);
                return a === cell[0] && b === cell[1] && c === cell[2] ? 0 : null;
              }, (v: number | null) => v !== null);
              return { hit, reads };
            };
            const expected = run(false), actual = run(true);
            assert.deepEqual(actual, expected, `${kernel}/${projection}/${corrected}/${divisions}/${x}/${y}/${edge}`);
            cases++; if (actual.hit) hits++;
          }
        }
      }
    }
    assert.equal(cases, 400); assert.ok(hits > 200, 'exercise actual intersections, not just misses');
  } finally { setTorusViewCorrection(null); setWorldProjection('torus'); setGeometryKernelMode(previous); }
});

test('sparse diagonal and moving rays preserve discovery while eliminating repeated air classification', () => {
  const world = host();
  setTorusViewCorrection(null);
  for (const divisions of [1, 8]) for (let i = 0; i < 32; i++) {
    const origin = bendPointForView(100 + i / 17, 210 + i / 23, 100 + i / 19);
    const direction = bendPointForView(96 + i / 17, 194 + i / 23, 108 + i / 19).sub(origin).normalize();
    const run = (optimized: boolean) => {
      world.aimRaycastDiscoveryOptimized = optimized;
      const reads: string[] = []; let classifications = 0;
      const hit = world.raycastBentVoxelFaces(origin, direction, 16, divisions,
        (x: number, y: number, z: number) => { reads.push(`${x},${y},${z}`); return null; },
        () => { classifications++; return false; });
      return { hit, reads, classifications };
    };
    const reference = run(false), optimized = run(true);
    assert.equal(optimized.hit, null); assert.deepEqual(optimized.reads, reference.reads);
    assert.ok(optimized.classifications < reference.classifications * .6);
  }
});
