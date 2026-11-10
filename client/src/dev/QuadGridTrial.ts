/** Local experiment: identical terrain, unlit fill, or depth-hidden quad edges. */
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { StaticTerrainGroup } from '@entropydrop/space-engine/render/StaticTerrainGroup.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { quadPerimeterIndices } from './QuadGridGeometry.ts';

export const QUAD_GRID_MODES = ['original', 'unlit', 'grid'] as const;
export type QuadGridMode = typeof QUAD_GRID_MODES[number];

export function createQuadGridTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw Error('Offline DEV required');
  const scene = game.sceneRenderer, renderer = scene.renderer, root = game.world.worldGroup;
  const lines = new StaticTerrainGroup();
  lines.name = 'QuadGridEdges'; lines.userData.spaceOpaqueTerrain = true;
  // Three executes opaque terrain bundles in traversal order. This final bundle
  // follows EVERY original terrain depth draw, including the distant arena.
  lines.renderOrder = 10000; scene.scene.add(lines);
  const materials = new Map<any, { unlit: any; depth: any; line: any }>();
  const entries = new Map<any, { geometry: any; index: any; version: number; line: any; sourceMaterial: any }>();
  let mode: QuadGridMode = 'original', closed = false, depthEnabled = true;
  const stats = { materials: 0, geometries: 0, terrainDraws: 0, terrainTriangles: 0, lineSegments: 0, nearDraws: 0, farDraws: 0, hookMs: 0 };
  function variants(source: any) {
    let result = materials.get(source);
    if (result) return result;
    if (!source.userData.torusNode) throw Error('Expected production torus material');
    function make(kind: 'unlit' | 'depth' | 'line') {
      const material: any = kind === 'line' ? new THREE.LineBasicNodeMaterial() : new THREE.MeshBasicNodeMaterial();
      for (const key of ['positionNode', 'colorNode', 'maskNode', 'outputNode', 'opacityNode', 'depthNode',
        'vertexColors', 'side', 'depthTest', 'depthWrite', 'depthFunc', 'colorWrite', 'transparent',
        'opacity', 'alphaTest', 'alphaToCoverage', 'blending', 'fog', 'toneMapped']) material[key] = source[key];
      material.color.copy(source.color); material.userData = { ...source.userData };
      material.name = `QuadGrid.${kind}.${source.id}`;
      if (kind === 'depth') {
        material.colorWrite = false; material.vertexColors = false;
        material.colorNode = vec3(0); material.outputNode = null;
        material.depthWrite = true;
        // Push filled depth slightly away from coplanar edges. The measured
        // path includes this depth geometry; it is never a transparent overlay.
        material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1;
      }
      if (kind === 'line') { material.depthWrite = false; material.depthTest = true; }
      return material;
    }
    result = { unlit: make('unlit'), depth: make('depth'), line: make('line') };
    materials.set(source, result); stats.materials += 3;
    return result;
  }
  function invalidate() {
    root.traverse((object: any) => { if (object.isBundleGroup) object.needsUpdate = true; });
    lines.needsUpdate = true;
  }
  function lineFor(mesh: any) {
    const geometry = mesh.geometry, index = geometry.index;
    if (!index) throw Error(`Non-indexed terrain: ${mesh.name}`);
    let entry = entries.get(mesh);
    if (entry && (entry.geometry !== geometry || entry.index !== index || entry.version !== index.version)) {
      entry.line.removeFromParent(); entry.line.geometry.dispose(); entries.delete(mesh); entry = undefined;
    }
    if (!entry) {
      const edges = geometry.isInstancedBufferGeometry ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) edges.setAttribute(name, attribute as any);
      edges.setIndex(new THREE.BufferAttribute(quadPerimeterIndices(index.array), 1));
      for (const group of geometry.groups) {
        if (group.start % 6 || group.count % 6) throw Error('Material boundary splits a quad');
        edges.addGroup(group.start / 6 * 8, group.count / 6 * 8, group.materialIndex);
      }
      edges.boundingSphere = geometry.boundingSphere?.clone() ?? new THREE.Sphere();
      const line = new THREE.LineSegments(edges);
      line.name = `QuadGrid.${mesh.name}`; line.frustumCulled = false; line.matrixAutoUpdate = false;
      // Position and mask graphs use per-object arena origin/run uniforms.
      line.userData = mesh.userData; lines.add(line); lines.registerStaticLeaf(line);
      entry = { geometry, index, version: index.version, line, sourceMaterial: null }; entries.set(mesh, entry);
      stats.geometries++;
      geometry.addEventListener('dispose', () => {
        const current = entries.get(mesh);
        if (!current || current.geometry !== geometry) return;
        current.line.removeFromParent(); current.line.geometry.dispose(); entries.delete(mesh); lines.needsUpdate = true;
      });
      lines.needsUpdate = true;
    }
    const line = entry.line;
    if (entry.sourceMaterial !== mesh.material) {
      line.material = Array.isArray(mesh.material) ? mesh.material.map((m: any) => variants(m).line) : variants(mesh.material).line;
      entry.sourceMaterial = mesh.material; lines.needsUpdate = true;
    }
    if (!line.matrix.equals(mesh.matrixWorld)) {
      line.matrix.copy(mesh.matrixWorld); line.matrixWorldNeedsUpdate = true; lines.needsUpdate = true;
    }
    const count = geometry.drawRange.count / 6 * 8, start = geometry.drawRange.start / 6 * 8;
    if (line.geometry.instanceCount !== geometry.instanceCount || line.geometry.drawRange.count !== count || line.geometry.drawRange.start !== start) {
      line.geometry.instanceCount = geometry.instanceCount; line.geometry.setDrawRange(start, count); lines.needsUpdate = true;
    }
    return line;
  }
  const undo = interceptMethod(renderer, 'render', (original, args) => {
    if (args[0] !== scene.scene) return original(...args);
    const begin = performance.now(), restore: [any, any][] = [], active = new Set<any>();
    stats.terrainDraws = stats.terrainTriangles = stats.lineSegments = stats.nearDraws = stats.farDraws = 0;
    // Refresh original world matrices before borrowing them for the edge bundle.
    root.updateMatrixWorld();
    try {
      root.traverseVisible((mesh: any) => {
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry, instances = geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
        const count = Math.min(geometry.index?.count ?? 0, geometry.drawRange.count);
        if (!instances || !count) return;
        const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const groups = Array.isArray(mesh.material) ? geometry.groups : [{ count, materialIndex: 0 }];
        for (const group of groups) {
          const source = sources[group.materialIndex ?? 0];
          if (!group.count || !source?.visible) continue;
          if (source.transparent) throw Error(`Transparent terrain unsupported by opaque depth trial: ${mesh.name}`);
          stats.terrainDraws++;
        }
        stats.terrainTriangles += count / 3 * instances;
        if (mesh.userData.voxelArena || mesh.userData.voxelOrigin) stats.farDraws++; else stats.nearDraws++;
        // Equal collection/cache lookup overhead for every role. Geometry is
        // immutable and created once per publication, never once per frame.
        const line = lineFor(mesh); active.add(line);
        if (mode === 'grid') stats.lineSegments += count / 6 * 4 * instances;
        restore.push([mesh, mesh.material]);
        if (mode !== 'original') mesh.material = Array.isArray(mesh.material)
          ? sources.map((m: any) => variants(m)[mode === 'unlit' ? 'unlit' : 'depth'])
          : variants(mesh.material)[mode === 'unlit' ? 'unlit' : 'depth'];
      });
      for (const entry of entries.values()) {
        const visible = active.has(entry.line);
        if (entry.line.visible !== visible) { entry.line.visible = visible; lines.needsUpdate = true; }
      }
      lines.visible = mode === 'grid';
      stats.hookMs = performance.now() - begin;
      return original(...args);
    } finally { for (const [mesh, source] of restore) mesh.material = source; }
  });
  return {
    stats, get mode() { return mode; },
    set(next: QuadGridMode) {
      if (closed || !QUAD_GRID_MODES.includes(next)) throw Error('Invalid grid trial mode');
      if (mode !== next) invalidate(); mode = next;
    },
    setDepthEnabled(enabled: boolean) {
      depthEnabled = enabled;
      for (const variants of materials.values()) { variants.depth.depthWrite = enabled; variants.depth.needsUpdate = true; }
      invalidate();
    },
    get depthEnabled() { return depthEnabled; },
    dispose() {
      if (closed) return; closed = true; undo(); lines.removeFromParent(); invalidate();
      for (const entry of entries.values()) entry.line.geometry.dispose();
      for (const variants of materials.values()) for (const material of Object.values(variants)) material.dispose();
      entries.clear(); materials.clear();
    },
  };
}
