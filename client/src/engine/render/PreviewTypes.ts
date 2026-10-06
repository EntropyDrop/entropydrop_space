import type * as THREE from 'three';
import type { InventoryInput } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import type { CuteCharacter, SkinModel } from './CuteCharacter.ts';
import type { RemotePlayerLod } from './RemotePlayerLod.ts';
import type { RemotePlayerMotionSample } from './RemotePlayerMotion.ts';

export interface Point3 { x: number; y: number; z: number }
export interface SelectionFrame {
  object?: THREE.Object3D;
  pivot?: THREE.Vector3;
  bounds?: { min: number[] | THREE.Vector3; max: number[] | THREE.Vector3 } | null;
}
export interface MicroCarvePreview {
  cellOrigin: Point3; microCenter?: Point3 | null; quaternion?: THREE.Quaternion | null;
}
export interface InventoryPlacementPreview {
  slot: InventoryInput; position: Point3; quaternion?: THREE.Quaternion | null;
}
interface PreviewPointer { pointerId: number; active: boolean }
export interface PreviewForceInteraction extends PreviewPointer {
  mode: 'force'; startX: number; startY: number; localPoint: THREE.Vector3;
  force: THREE.Vector3; appliedFrames: number;
}
export type PreviewInteraction = PreviewForceInteraction | (PreviewPointer & {
  mode: 'orbit'; lastX: number; lastY: number;
});
export interface RemotePlayerRecord {
  id: string; group: THREE.Group; character: CuteCharacter | null; fallback: THREE.Group | null;
  nameTag: THREE.Sprite; targetPosition: THREE.Vector3; targetYaw: number; currentYaw: number;
  targetPitch: number; currentPitch: number; lastSeen: number;
  lastMotionSample: RemotePlayerMotionSample; lastMotionSampleAt: number; sampleVelocity: THREE.Vector3;
  skinUrl: string; skinModel: SkinModel; loadedSkinUrl: string | null; loadedSkinModel: SkinModel | null;
  highDetail: boolean; lod: RemotePlayerLod | null; inView: boolean; speed: number; loadingSkin: object | null;
}
