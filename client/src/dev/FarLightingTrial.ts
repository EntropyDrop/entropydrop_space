/** Explicit offline experiment. Geometry, visibility and near terrain stay owned by production. */
import * as THREE from 'three/webgpu';
import { dot, max, varying, vec3 } from 'three/tsl';
import { interceptMethod } from './FrameDiagnostics.ts';

if (import.meta.hot) import.meta.hot.accept();
export const LIGHTING_MODES = ['pbr', 'lambert', 'face'] as const;
export type FarLightingMode = typeof LIGHTING_MODES[number];

export function createFarLightingTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  if (!game.world.distantSurface.isEnabled() || !layer.arena?.stats.residentFaces)
    throw new Error('Enable distant terrain and wait for resident faces first.');
  const cache = new Map<any, Record<FarLightingMode, any>>();
  let mode: FarLightingMode = 'pbr', closed = false;
  const stats = { materials: 0, draws: 0, farTriangles: 0, switches: 0 };
  function variants(source: any) {
    let entry = cache.get(source);
    if (entry) return entry;
    if (!source.userData.torusNode || !source.userData.flatNormalNode)
      throw new Error('Expected already bent production far material.');
    const make = (kind: 'lambert' | 'face') => {
      const material: any = kind === 'lambert' ? new THREE.MeshLambertNodeMaterial() : new THREE.MeshBasicNodeMaterial();
      // Share exactly the existing position, mask, emission and normal nodes.
      // Material.copy JSON-clones userData (which contains nodes), so copy the
      // relevant render state explicitly instead of serializing that graph.
      for (const key of ['positionNode', 'normalNode', 'colorNode', 'maskNode', 'outputNode', 'opacityNode',
        'depthNode', 'vertexColors', 'side', 'depthTest', 'depthWrite', 'depthFunc', 'colorWrite', 'transparent',
        'opacity', 'alphaTest', 'alphaToCoverage', 'blending', 'fog', 'toneMapped', 'flatShading']) material[key] = source[key];
      material.color.copy(source.color);
      material.userData = { ...source.userData };
      material.name = `FarLighting.${kind}.${source.id}`;
      if (kind === 'face') {
        // Constant artistic light in the unbent terrain frame. Computed per
        // vertex, interpolated over faces; no scene-light or BRDF evaluation.
        const brightness = varying(max(dot(source.userData.flatNormalNode, vec3(.4, .8, .3).normalize()), 0).mul(.55).add(.45));
        material.colorNode = (source.colorNode ?? vec3(1)).mul(brightness);
        material.lights = false;
      }
      return material;
    };
    entry = { pbr: source, lambert: make('lambert'), face: make('face') };
    cache.set(source, entry); stats.materials += 2;
    return entry;
  }
  const undo = interceptMethod(renderer, 'render', (original, args) => {
    if (args[0] !== scene.scene) return original(...args);
    const restore: [any, any][] = [];
    stats.draws = 0; stats.farTriangles = 0;
    try {
      // Run the same swap loop in all three modes, after ordinary LOD/culling.
      for (const mesh of layer.group.children) {
        if (!mesh.visible || !mesh.isMesh) continue;
        const source = mesh.material;
        restore.push([mesh, source]); mesh.material = variants(source)[mode];
        stats.draws++;
        const geometry = mesh.geometry;
        stats.farTriangles += Math.min(geometry.index?.count ?? 0, geometry.drawRange.count) / 3 * (geometry.instanceCount ?? 1);
      }
      return original(...args);
    } finally { for (const [mesh, source] of restore) mesh.material = source; }
  });
  return {
    stats,
    get mode() { return mode; },
    set(next: FarLightingMode) {
      if (closed || !LIGHTING_MODES.includes(next)) throw new Error('Invalid lighting trial state.');
      if (mode !== next) layer.group.needsUpdate = true;
      mode = next; stats.switches++;
    },
    dispose() {
      if (closed) return;
      closed = true; undo(); layer.group.needsUpdate = true;
      for (const entry of cache.values()) { entry.lambert.dispose(); entry.face.dispose(); }
      cache.clear();
    },
  };
}
export type FarLightingTrial = ReturnType<typeof createFarLightingTrial>;

export async function saveLightingAsset(name: string, value: Blob) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('space-lighting-experiment-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      transaction.objectStore('files').put(value, name);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
