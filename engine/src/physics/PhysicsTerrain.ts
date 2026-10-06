import type * as THREE from 'three';
import type { World } from '../voxel/World.ts';
import type { MicroVoxelLayer } from '../voxel/MicroVoxelLayer.ts';

/** The physics solver consumes collision data without owning terrain streaming or rendering. */
export type TerrainRayHit = { hit: false; distance?: number } | {
  hit: true; distance: number; hitPos?: { x: number; y: number; z: number }; normal?: { x: number; y: number; z: number };
};
export interface PhysicsTerrain extends Pick<World, 'getBlock'>,
  Partial<Pick<World, 'getMicroCollisionBlock' | 'getMicroBlock' | 'getMicroBlocksInAABB'
    | 'getMicroCollisionBoxesInAABB' | 'terrainVersion' | 'activeChunkKeys' | 'getTerrainCollisionStamp'>> {
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, distance: number): TerrainRayHit;
  raycastMicro(origin: THREE.Vector3, direction: THREE.Vector3, distance: number): TerrainRayHit;
  raycastMicroCollision?(origin: THREE.Vector3, direction: THREE.Vector3, distance: number): TerrainRayHit;
  microVoxels?: Pick<MicroVoxelLayer, 'get'>;
}
export type PlayerTerrain = Pick<World, 'getBlock' | 'getMicroBlocksInAABB'>
  & Partial<Pick<World, 'preparePlayerSpawnArea'>>;
