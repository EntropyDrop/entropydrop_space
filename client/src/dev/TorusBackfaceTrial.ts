import { getWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { VOXEL_VISIBILITY_STRIDE } from '@entropydrop/space-engine/render/VoxelFaceVisibility.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { surfaceFacingProxy, surfaceBlockBackFacing, BACKFACE_PROXY_STRIDE } from './TorusBackfaceMath.ts';

if (import.meta.hot) import.meta.hot.accept();
export type BackfaceMode = 'reference' | 'culled';
export const BACKFACE_MODES: BackfaceMode[] = ['reference', 'culled'];

/** Reversible extra test inside the existing cached block visibility path.
 * No material changes, shader discard, geometry copies or production imports. */
export function createTorusBackfaceTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  const layer = game.world.distantSurface.voxels, arena = layer.arena;
  if (layer.getTorusBackfaceCullingEnabled()) throw new Error('Turn off the saved torus backface setting before running the A/B trial.');
  if (getWorldProjection() !== 'torus' || !arena?.stats.residentFaces || !arena.getViewOptimizations().cached)
    throw new Error('Settled torus Arena and cached visibility required.');
  const proxies = new WeakMap<Float32Array, Float64Array>();
  const classified = new WeakMap<object, number>();
  let mode: BackfaceMode = 'reference', closed = false;
  const stats = { draws: 0, farTriangles: 0, cacheBuilds: 0, proxyBytes: 0, proxyBuildMs: 0,
    classifiedBlocks: 0, extraBackBlocks: 0 };
  function proxy(data: Float32Array) {
    let result = proxies.get(data);
    if (result) return result;
    const start = performance.now(), count = Math.floor(data.length / VOXEL_VISIBILITY_STRIDE);
    result = new Float64Array(count * BACKFACE_PROXY_STRIDE);
    for (let block = 0; block < count; block++) {
      const at = block * VOXEL_VISIBILITY_STRIDE;
      surfaceFacingProxy(data[at+8], data[at+9], data[at+10], data[at+11], data[at], data[at+1], data[at+2], result, block * BACKFACE_PROXY_STRIDE);
    }
    proxies.set(data, result); stats.cacheBuilds++; stats.proxyBytes += result.byteLength; stats.proxyBuildMs += performance.now() - start;
    return result;
  }
  // Precompute immutable coefficients outside accepted frame measurements.
  for (const entry of arena.entries.values()) { const data = arena.visibilityData(entry); if (data) proxy(data); }
  const undo = [interceptMethod(arena, 'prepareBlockTests', (original, args) => {
    const cache = original(...args);
    if (!cache || mode !== 'culled' || getWorldProjection() !== 'torus' || classified.get(cache) === cache.position) return cache;
    const data = cache.data, coefficients = proxy(data), camera = arena.camera;
    const count = Math.min(cache.distance.length, Math.floor(data.length / VOXEL_VISIBILITY_STRIDE));
    for (let block = 0; block < count; block++) {
      if (cache.facing[block] === 1) continue;
      stats.classifiedBlocks++;
      if (surfaceBlockBackFacing(coefficients, block * BACKFACE_PROXY_STRIDE, camera.x, camera.y, camera.z,
        cache.distance[block], data[block * VOXEL_VISIBILITY_STRIDE + 3])) {
        cache.facing[block] = 1; stats.extraBackBlocks++;
      }
    }
    classified.set(cache, cache.position);
    return cache;
  }), interceptMethod(layer, 'updateView', (original, args) => {
    const result = original(...args);
    stats.draws = arena.stats.draws; stats.farTriangles = arena.stats.drawnFaces * 2;
    return result;
  })];
  function invalidate() {
    // Rebuild original facing flags and visibility lists on both switch directions.
    arena.positionEpoch++; arena.resetView = true; arena.visibilityDirty = true;
    layer.cullDirty = true; layer.group.needsUpdate = true;
  }
  return {
    stats,
    get mode() { return mode; },
    set(next: BackfaceMode) {
      if (closed || !BACKFACE_MODES.includes(next)) throw new Error('Invalid backface trial state.');
      if (next !== mode) { mode = next; invalidate(); }
    },
    dispose() { if (!closed) { mode = 'reference'; closed = true; undo.reverse().forEach(restore => restore()); invalidate(); } },
  };
}
export type TorusBackfaceTrial = ReturnType<typeof createTorusBackfaceTrial>;

export async function saveBackfaceAsset(name: string, value: Blob) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('space-backface-experiment-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite'); transaction.objectStore('files').put(value, name);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
