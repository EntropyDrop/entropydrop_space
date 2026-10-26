/** Offline-only trial: deterministically retain one original triangle per far quad. */
import * as THREE from 'three/webgpu';
import { storage, vertexIndex, instanceIndex, uint, float, vec2, vec3, varying, min, uniform, wgslFn } from 'three/tsl';
import { interceptMethod } from './FrameDiagnostics.ts';
import { VOXEL_FACE_BLOCK } from '@entropydrop/space-engine/render/VoxelFaceVisibility.ts';

if (import.meta.hot) import.meta.hot.accept();
export const HALF_MODES = ['original', 'half'] as const;
export type HalfMode = typeof HALF_MODES[number];
const unpack = wgslFn('fn halfTrialColor(value: u32) -> vec3<f32> { return unpack4x8unorm(value).xyz; }');
// Hash stable face coordinates, not page slots or visibility order. No per-frame randomness.
const choose = wgslFn(`fn halfTrialChoice(position: vec3<f32>, span: vec2<f32>, direction: u32) -> u32 {
  let p = bitcast<vec3<u32>>(vec3<i32>(round(position * 8.0)));
  var h = (p.x * 73856093u) ^ (p.y * 19349663u) ^ (p.z * 83492791u);
  h = h ^ (u32(span.x) * 2654435761u) ^ (u32(span.y) * 2246822519u) ^ (direction * 3266489917u);
  h = (h ^ (h >> 16u)) * 2146121005u;
  h = (h ^ (h >> 15u)) * 2221713035u;
  return (h ^ (h >> 16u)) & 1u;
}`);

function halfMesh(arena: any, data: any, map: any) {
  const records = storage(data, 'uvec4' as 'vec4', data.count).toReadOnly();
  const remap = storage(map, 'vec4', map.count).toReadOnly();
  const base = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaBase ?? 0);
  const runFaces = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaFaces ?? 0);
  const faceIndex = vertexIndex.div(uint(3)).add(instanceIndex.mul(uint(arena.instanceFaces)));
  const bounded = uint(min(float(faceIndex), float(runFaces).sub(1)));
  const blockIndex = bounded.div(uint(VOXEL_FACE_BLOCK)).add(base).mul(2), block = remap.element(blockIndex);
  const origin = vec3(block.z, block.w, remap.element(blockIndex.add(1)).x);
  const local = bounded.mod(uint(VOXEL_FACE_BLOCK));
  const valid = local.lessThan(uint(block.y)).and(faceIndex.lessThan(runFaces));
  const face = uint(block.x).add(uint(min(float(local), block.y.sub(1))));
  const record = records.element(face);
  const offset = vec3(float(uint(record.x).bitAnd(65535)), float(uint(record.x).shiftRight(16)), float(uint(record.y).bitAnd(65535)));
  const span = vec2(float(uint(record.y).shiftRight(16)), float(uint(record.z).bitAnd(65535)));
  const direction = uint(record.z).shiftRight(16).bitAnd(255);
  const localCorner = vertexIndex.mod(uint(3));
  // Original triangles are [0,1,2] and [0,2,3], preserving winding and diagonal.
  const corner = localCorner.add(uint(choose(origin.add(offset.mul(.125)), span, direction)).mul(uint(localCorner.greaterThan(0))));
  return arena.make({ origin, offset, span, direction: float(direction),
    emission: float(uint(record.z).shiftRight(24)), color: varying(unpack(uint(record.w))), valid,
    quad: vec2(float(corner.equal(1).or(corner.equal(2))), float(corner.greaterThanEqual(2))) });
}

export function createHalfTriangleTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels, arena = layer.arena;
  if (!game.world.distantSurface.isEnabled() || !arena?.stats.residentFaces || !arena.blockInstancing || arena.compactMaps
    || layer.getTorusBackfaceCullingEnabled()) throw new Error('Expected enabled original packed far terrain, backface culling off.');
  const facesPerInstance = arena.instanceFaces;
  const index = new THREE.BufferAttribute(Uint32Array.from({ length: facesPerInstance * 3 }, (_, i) => i), 1);
  const materials: any[] = [], variants = new Map<any, any>(), pages = new Map<any, any>(), geometries = new Map<any, any>();
  let mode: HalfMode = 'original', closed = false;
  const stats = { materials: 0, draws: 0, farTriangles: 0, fallbackDraws: 0, switches: 0 };
  function prepare() {
    for (const page of arena.pages) {
      const prior = pages.get(page);
      if (prior?.data === page.data && prior?.map === page.map) continue;
      const mesh = halfMesh(arena, page.data, page.map);
      for (const name of ['opaqueMaterial', 'maskedMaterial']) {
        variants.set(page.mesh.userData[name], mesh.userData[name]); materials.push(mesh.userData[name]);
      }
      mesh.geometry.dispose(); pages.set(page, { data: page.data, map: page.map });
    }
    stats.materials = materials.length;
  }
  prepare();
  const undo = interceptMethod(renderer, 'render', (original, args) => {
    if (args[0] !== scene.scene) return original(...args);
    if (!arena.blockInstancing || arena.compactMaps || arena.instanceFaces !== facesPerInstance) throw new Error('Far layout changed.');
    prepare();
    const restore: [any, any, any][] = []; stats.draws = stats.farTriangles = stats.fallbackDraws = 0;
    try {
      for (const mesh of layer.group.children) {
        if (!mesh.visible || !mesh.isMesh) continue;
        const candidate = variants.get(mesh.material);
        if (!candidate) { stats.fallbackDraws++; continue; }
        restore.push([mesh, mesh.material, mesh.geometry]);
        if (mode === 'half') {
          let geometry = geometries.get(mesh.geometry);
          if (!geometry) { geometry = new THREE.InstancedBufferGeometry(); geometry.setIndex(index); geometries.set(mesh.geometry, geometry); }
          geometry.instanceCount = mesh.geometry.instanceCount;
          geometry.setDrawRange(0, mesh.geometry.drawRange.count / 2);
          mesh.material = candidate; mesh.geometry = geometry;
        }
        stats.draws++;
        stats.farTriangles += Math.min(mesh.geometry.index.count, mesh.geometry.drawRange.count) / 3 * mesh.geometry.instanceCount;
      }
      return original(...args);
    } finally { for (const [mesh, material, geometry] of restore) { mesh.material = material; mesh.geometry = geometry; } }
  });
  return { stats, metadata: { facesPerInstance, faceRecordBytes: 16, choice: 'world-coordinate-hash', fallback: 'original' },
    get mode() { return mode; },
    set(next: HalfMode) { if (closed || !HALF_MODES.includes(next)) throw new Error('Invalid half-triangle mode.');
      if (next !== mode) layer.group.needsUpdate = true; mode = next; stats.switches++; },
    dispose() { if (closed) return; closed = true; undo(); layer.group.needsUpdate = true;
      for (const material of materials) material.dispose(); for (const geometry of geometries.values()) geometry.dispose(); },
  };
}
export type HalfTriangleTrial = ReturnType<typeof createHalfTriangleTrial>;
