import type { InventoryChild, InventoryConstraint } from '../storage/InventoryTypes.ts';
import type * as THREE from 'three';
import type { VoxelMeshNode } from './EntityVoxelMeshes.ts';

/** Construction-space voxel. Ownership defaults to the root on installation. */
export interface RuntimeVoxel {
  localX: number; localY: number; localZ: number;
  entityId?: string;
  size?: number;
  block?: number;
  color?: number | string;
  materialId?: number;
  part?: string | null;
}
export interface CollisionEntry { x: number; y: number; z: number; span: number; entityId: string }

/**
 * A node in the entity hierarchy. The tree describes ownership and authored
 * parent-relative transforms; each node also owns a kinematic or dynamic body.
 */
export interface EntityNode extends VoxelMeshNode {
  id: string;
  parentId: string | null;
  pivotLocal: THREE.Vector3;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  /** Authored mounting frame in this component's local coordinates. */
  anchorQuaternion: THREE.Quaternion;
  localAngularVelocity: THREE.Vector3;
  commandedThisFrame?: boolean;
  initialLocalPosition?: THREE.Vector3;
  initialLocalQuaternion?: THREE.Quaternion;
  group: THREE.Group;
  children: Set<string>;
  previousWorldMatrix?: THREE.Matrix4;
  previousLocalPosition?: THREE.Vector3;
  previousLocalQuaternion?: THREE.Quaternion;
  bodyType: string;
  blocks?: Set<RuntimeVoxel>;
  volume?: number;
  weightedCenterSum?: THREE.Vector3;
  maxRadiusSq?: number;
}

export interface EntityRigidBody {
  id: string;
  nodeId: string;
  type: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  appliedForces: THREE.Vector3;
  appliedTorques: THREE.Vector3;
  mass: number;
  inverseInertia: number;
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  centerOfMassLocal: THREE.Vector3;
  previousKinematicPosition: THREE.Vector3;
  previousKinematicQuaternion: THREE.Quaternion;
  isOnGround: boolean;
  /** False while the entity is stopped. The authored body type is preserved,
   * but the solver treats this body as an immovable static collider. */
  simulationEnabled: boolean;
}


export interface RuntimeSeat {
  position: [number, number, number];
  rotation: [number, number, number, number];
  fixedOrientation: boolean;
}

export interface VoxelEditOptions {
  color?: unknown;
  r?: unknown; g?: unknown; b?: unknown;
  materialId?: unknown;
  material?: unknown;
}

/** Constructor input may carry a quaternion or legacy ownership cell selector. */
export interface ChildDefinitionInput extends Omit<Partial<InventoryChild>, 'localRotation' | 'anchorRotation'> {
  localRotation?: number[] | THREE.Quaternion;
  anchorRotation?: number[] | THREE.Quaternion;
  /** Legacy import hints, normalized before they enter the component tree. */
  kind?: string;
  blockKeys?: Array<string | Array<string | number>>;
}
export interface RuntimeChild extends InventoryChild {
  bodyType: 'dynamic' | 'kinematic';
  restitution: number;
  friction: number;
  useGravity: boolean;
  collisionEnabled: boolean;
  seats: RuntimeSeat[];
}
export interface ConstraintInput extends Omit<Partial<InventoryConstraint>, 'limits' | 'type'> {
  type?: string;
  parentId?: string | null;
  limits?: { min: number; max: number } | null;
}
export interface RuntimeConstraint extends Omit<InventoryConstraint, 'limits'> {
  anchorA: number[]; anchorB: number[];
  axisA: number[]; axisB: number[];
  referenceA: number[]; referenceB: number[];
  limits: { min: number; max: number } | null;
  stiffness: number;
  collideConnected: boolean;
}
export interface ContraptionScene {
  add(object: THREE.Object3D): unknown;
  remove(object: THREE.Object3D): unknown;
}
export interface ContraptionOptions extends Omit<ChildDefinitionInput, 'id' | 'parentId'> {
  publicId?: string;
  rootComponentId?: string;
  rootComponentName?: string;
  localCenter?: number[];
  rootPivotOverride?: number[] | null;
  collisionSimulationEnabled?: boolean;
  physicsSimulationEnabled?: boolean;
  mode?: string;
  scriptCode?: string;
  scriptCommandSequence?: number;
  behaviorPrompt?: string;
  agentInterpretation?: string;
  particleSystem?: unknown;
  childEntities?: ChildDefinitionInput[];
  constraints?: ConstraintInput[];
}
