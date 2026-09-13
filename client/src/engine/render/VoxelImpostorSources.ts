import * as THREE from 'three';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { wrapChunkX, wrapChunkZ, wrapX, wrapZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { type ImpostorSource } from './CrossPlaneImpostor.ts';
import { DetachedBlockImpostors } from './DetachedBlockImpostors.ts';

export class VoxelImpostorSources {
  private detached = new DetachedBlockImpostors();
  private microIsolation = new WeakMap<THREE.Mesh, { version: number; isolated: boolean }>();

  private isolatedMicroMesh(world: any, key: string, mesh: THREE.Mesh, bounds: THREE.Box3) {
    const [cx, cz, cy] = key.split(',').map(Number);
    const span = mesh.userData.bentSpan;
    // Mesh publication can lag behind the terrain edit counter. Always check
    // published neighbors, including the other side of the periodic boundary.
    for (const [dx, dz, dy] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
      const neighborX = wrapX((cx + dx) * span) / span;
      const neighborZ = wrapZ((cz + dz) * span) / span;
      if (world.microVoxels.meshChunks.has(`${neighborX},${neighborZ},${cy + dy}`)) return false;
    }
    const cached = this.microIsolation.get(mesh);
    if (cached?.version === world.terrainVersion) return cached.isolated;
    let isolated = true;
    // Conservatively keep micro terrain attached to standard terrain in 3D.
    // Use loaded chunk data only; a render optimization must never stream data.
    for (let x = Math.floor(bounds.min.x) - 1; isolated && x <= Math.floor(bounds.max.x); x++) {
      for (let z = Math.floor(bounds.min.z) - 1; isolated && z <= Math.floor(bounds.max.z); z++) {
        const chunk = world.chunks?.get(`${wrapChunkX(Math.floor(x / CHUNK_SIZE_X))},${wrapChunkZ(Math.floor(z / CHUNK_SIZE_Z))}`);
        if (!chunk) continue;
        for (let y = Math.floor(bounds.min.y) - 1; y <= Math.floor(bounds.max.y); y++) {
          if (chunk.getLocalBlock((x % CHUNK_SIZE_X + CHUNK_SIZE_X) % CHUNK_SIZE_X, y, (z % CHUNK_SIZE_Z + CHUNK_SIZE_Z) % CHUNK_SIZE_Z)) {
            isolated = false;
            break;
          }
        }
      }
    }
    this.microIsolation.set(mesh, { version: world.terrainVersion, isolated });
    return isolated;
  }

  *sources(world: any, contraptions: any[], camera: THREE.Vector3, protectedEntities: Set<any>, manager?: any,
    retainRemote?: (publicId: string) => boolean): Generator<ImpostorSource> {
    for (const entity of contraptions) {
      const publicId = String(entity.publicId || entity.id);
      for (const node of entity.entityNodes?.values() || []) {
        const parent = node.voxelChunkGroup;
        if (!parent || !node.voxelChunks?.size || !entity.minLocal || !entity.maxLocal) continue;
        yield {
          key: `entity:${publicId}:${node.id}`, kind: 'entity', parent, meshes: [...node.voxelChunks.values()],
          bounds: new THREE.Box3(entity.minLocal.clone().sub(node.pivotLocal), entity.maxLocal.clone().sub(node.pivotLocal)),
          protected: protectedEntities.has(entity) || entity.isWrenchGrabbed,
          visible: entity.rootGroup.visible && node.group.visible,
          retain: manager ? () => manager.hasDormantPublicId(publicId) || !!retainRemote?.(publicId) : undefined,
        };
      }
    }
    yield* this.detached.sources(world, camera);
    for (const [key, mesh] of world.microVoxels?.meshChunks || []) {
      const span = mesh.userData.bentSpan;
      if (!Number.isFinite(span) || !Number.isFinite(mesh.userData.occupiedMinY) || !Number.isFinite(mesh.userData.occupiedMaxY)) continue;
      const standardKey = mesh.userData.standardChunkKey;
      if (world.activeChunkKeys && !world.activeChunkKeys.has(standardKey)) continue;
      const bounds = new THREE.Box3(
        new THREE.Vector3(mesh.position.x, mesh.userData.occupiedMinY, mesh.position.z),
        new THREE.Vector3(mesh.position.x + span, mesh.userData.occupiedMaxY, mesh.position.z + span),
      );
      if (!this.isolatedMicroMesh(world, key, mesh, bounds)) continue;
      yield { key: mesh, parent: mesh.parent, meshes: [mesh], bounds, visible: mesh.visible };
    }
  }

  dispose() {
    this.detached.dispose();
    this.microIsolation = new WeakMap();
  }
}
