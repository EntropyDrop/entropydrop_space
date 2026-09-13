import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import { normalizeInventoryName, inventoryNameLength, MAX_INVENTORY_NAME_LENGTH } from '@entropydrop/space-engine/storage/InventoryName.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import {
  ContraptionMode,
  isValidComponentId,
  isValidConstraintId,
  MAX_ENTITY_BOUNDS,
  MAX_ENTITY_COMPONENTS
} from '@entropydrop/space-engine/contraption/Contraption.ts';
import { BlockTypes, DEFAULT_BLOCK_COLOR, normalizeColor } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';

export const SPACE_BUILD_PLAN_VERSION = 1;
export const MAX_BUILD_PLAN_VOXELS = 65_536;
export const MAX_BUILD_PLAN_CONSTRAINTS = 256;
export const MAX_BUILD_SCRIPT_BYTES = 64 * 1024;
export const MAX_BUILD_TOTAL_SCRIPT_BYTES = 512 * 1024;
export const BUILD_OPERATIONS_PER_FRAME = 1024;
export const BUILD_FRAME_BUDGET_MS = 5;

export type SpaceBuildKind = 'structure' | 'entity';
export type SpaceBuildAnchor = 'crosshair' | [number, number, number];

export interface SpaceBuildVoxelInput {
  x: number;
  y: number;
  z: number;
  size?: 1 | typeof MICRO_SIZE;
  color?: number | string;
  componentId?: string;
}

export interface SpaceBuildPrimitiveInput {
  type: 'box' | 'line';
  from: [number, number, number];
  to: [number, number, number];
  hollow?: boolean;
  size?: 1 | typeof MICRO_SIZE;
  color?: number | string;
  componentId?: string;
}

export interface SpaceBuildComponentInput {
  id: string;
  name?: string;
  parentId?: string | null;
  pivot?: [number, number, number];
  bodyType?: 'dynamic' | 'kinematic';
  mass?: number;
  restitution?: number;
  friction?: number;
  useGravity?: boolean;
  collisionEnabled?: boolean;
  seats?: Array<[number, number, number] | {
    position: [number, number, number];
    /** Rider orientation `[x,y,z,w]` in the component pivot frame; default identity. */
    rotation?: [number, number, number, number];
    /** When true a mounted rider's yaw follows the seat's solved world orientation. */
    fixedOrientation?: boolean;
  }>;
  script?: string;
  scriptEnabled?: boolean;
}

export interface SpaceBuildConstraintInput {
  id: string;
  type: 'point' | 'hinge' | 'weld';
  /** Null selects the external world anchor; strings always name components. */
  bodyA: string | null;
  bodyB: string;
  anchorA?: [number, number, number];
  anchorB?: [number, number, number];
  axisA?: [number, number, number];
  axisB?: [number, number, number];
  limits?: { min: number; max: number };
  stiffness?: number;
  collideConnected?: boolean;
}

export interface SpaceBuildPlanInput {
  version?: number;
  kind: SpaceBuildKind;
  name?: string;
  anchor?: SpaceBuildAnchor;
  blocks?: SpaceBuildVoxelInput[];
  primitives?: SpaceBuildPrimitiveInput[];
  components?: SpaceBuildComponentInput[];
  constraints?: SpaceBuildConstraintInput[];
  bodyType?: 'dynamic' | 'kinematic';
  mass?: number;
  restitution?: number;
  friction?: number;
  useGravity?: boolean;
  collisionEnabled?: boolean;
}

export interface NormalizedBuildVoxel {
  x: number;
  y: number;
  z: number;
  size: 1 | typeof MICRO_SIZE;
  color: number;
  componentId: string;
}

export interface NormalizedSpaceBuildPlan {
  version: 1;
  kind: SpaceBuildKind;
  name: string;
  anchor: SpaceBuildAnchor;
  blocks: NormalizedBuildVoxel[];
  components: SpaceBuildComponentInput[];
  constraints: SpaceBuildConstraintInput[];
  bodyType: 'dynamic' | 'kinematic';
  mass?: number;
  restitution: number;
  friction: number;
  useGravity: boolean;
  collisionEnabled: boolean;
}

export interface SpaceBuildValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: NormalizedSpaceBuildPlan | null;
  slot: any;
  summary: {
    name: string;
    kind: SpaceBuildKind | null;
    voxelCount: number;
    standardCount: number;
    microCount: number;
    componentCount: number;
    scriptCount: number;
    constraintCount: number;
    bounds: { min: number[]; max: number[]; size: number[] } | null;
  };
}

export interface SpaceBuilderJobStatus {
  id: string;
  label: string;
  kind: 'structure' | 'entity' | 'rollback';
  phase: 'preparing' | 'applying' | 'waiting' | 'rolling_back' | 'complete' | 'failed' | 'cancelled';
  processed: number;
  total: number;
  changed: number;
  detail?: string;
  commitId?: string | null;
  entityId?: string | null;
}

type AppliedVoxel = {
  size: 1 | typeof MICRO_SIZE;
  cell?: { x: number; y: number; z: number };
  micro?: { x: number; y: number; z: number };
  color: number;
};

type BuildReceipt = {
  id: string;
  kind: SpaceBuildKind;
  name: string;
  applied: AppliedVoxel[];
  entity: any;
};

type BuilderJob = {
  id: string;
  label: string;
  kind: 'structure' | 'entity' | 'rollback';
  phase: SpaceBuilderJobStatus['phase'];
  plan: NormalizedSpaceBuildPlan | null;
  slot: any;
  position: THREE.Vector3 | null;
  processed: number;
  total: number;
  changed: number;
  applied: AppliedVoxel[];
  preparedBlocks: any[];
  rollback: AppliedVoxel[];
  receipt?: BuildReceipt;
  error?: string;
  entity?: any;
  rollbackFinalPhase?: 'complete' | 'failed' | 'cancelled';
};

function finiteVector(value: any): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const vector = value.map(Number);
  return vector.every(Number.isFinite) ? vector as [number, number, number] : null;
}

/** Seat rider orientation: any unit quaternion, not a stopped-grid rotation. */
function finiteUnitQuaternion(value: any): boolean {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const quaternion = value.map(Number);
  if (!quaternion.every(Number.isFinite)) return false;
  const lengthSq = quaternion.reduce((sum, component) => sum + component * component, 0);
  return lengthSq > 1e-12 && Math.abs(lengthSq - 1) <= 1e-3;
}

function clampedUnit(value: any, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function closedBuildComponent(raw: any): SpaceBuildComponentInput {
  const component: any = {
    id: raw?.id,
    parentId: raw?.parentId,
  };
  for (const field of [
    'name',
    'pivot',
    'bodyType',
    'mass',
    'restitution',
    'friction',
    'useGravity',
    'collisionEnabled',
    'seats',
    'script',
    'scriptEnabled',
  ] as const) {
    if (raw?.[field] !== undefined) component[field] = raw[field];
  }
  return component;
}

function closedBuildConstraint(raw: any): SpaceBuildConstraintInput {
  const constraint: any = {
    id: String(raw?.id || ''),
    type: raw?.type,
    bodyA: raw?.bodyA == null ? null : String(raw.bodyA),
    bodyB: String(raw?.bodyB || ''),
  };
  for (const field of ['anchorA', 'anchorB', 'axisA', 'axisB'] as const) {
    if (raw?.[field] !== undefined) constraint[field] = raw[field];
  }
  if (raw?.limits !== undefined) constraint.limits = raw.limits;
  if (raw?.stiffness !== undefined) constraint.stiffness = raw.stiffness;
  if (raw?.collideConnected !== undefined) constraint.collideConnected = raw.collideConnected;
  return constraint;
}

function runtimeConstraint(constraint: SpaceBuildConstraintInput): SpaceBuildConstraintInput {
  const output: any = {
    id: constraint.id,
    type: constraint.type,
    bodyA: constraint.bodyA,
    bodyB: constraint.bodyB,
    stiffness: constraint.stiffness,
    collideConnected: constraint.collideConnected === true,
  };
  for (const field of ['anchorA', 'anchorB', 'axisA', 'axisB'] as const) {
    if (constraint[field] !== undefined) output[field] = [...constraint[field]!];
  }
  if (constraint.limits !== undefined) output.limits = { ...constraint.limits };
  return output;
}

/** Runtime seat shape shared by AI build plans: position plus optional rider pose. */
function builderSeat(seat: any): any {
  if (Array.isArray(seat)) return { position: [...seat] };
  return {
    position: [...seat.position],
    ...(Array.isArray(seat.rotation) && seat.rotation.length === 4 ? { rotation: [...seat.rotation] } : {}),
    ...(seat.fixedOrientation === true ? { fixedOrientation: true } : {}),
  };
}

function normalizedGridCoordinate(value: any, size: 1 | typeof MICRO_SIZE): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const units = size < 1 ? Math.round(number * MICRO_DIVISIONS) : Math.round(number);
  const normalized = size < 1 ? units / MICRO_DIVISIONS : units;
  return Math.abs(normalized - number) <= 1e-6 ? normalized : null;
}

function voxelKey(voxel: NormalizedBuildVoxel): string {
  const scale = voxel.size < 1 ? MICRO_DIVISIONS : 1;
  return `${voxel.componentId}:${voxel.size}:${Math.round(voxel.x * scale)},${Math.round(voxel.y * scale)},${Math.round(voxel.z * scale)}`;
}

function standardParentKey(voxel: NormalizedBuildVoxel): string {
  return `${voxel.componentId}:${Math.floor(voxel.x + 1e-6)},${Math.floor(voxel.y + 1e-6)},${Math.floor(voxel.z + 1e-6)}`;
}

function expandLine(from: number[], to: number[]): number[][] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return [[...from]];
  const result: number[][] = [];
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    result.push([
      Math.round(from[0] + dx * t),
      Math.round(from[1] + dy * t),
      Math.round(from[2] + dz * t)
    ]);
  }
  return result;
}

function expandPrimitive(primitive: SpaceBuildPrimitiveInput): SpaceBuildVoxelInput[] {
  const size: 1 | typeof MICRO_SIZE = primitive?.size === MICRO_SIZE ? MICRO_SIZE : 1;
  const scale = size < 1 ? MICRO_DIVISIONS : 1;
  const rawFrom = finiteVector(primitive?.from);
  const rawTo = finiteVector(primitive?.to);
  if (!rawFrom || !rawTo
    || rawFrom.some(value => normalizedGridCoordinate(value, size) === null)
    || rawTo.some(value => normalizedGridCoordinate(value, size) === null)) return [];
  const from = rawFrom.map(value => Math.round(value * scale));
  const to = rawTo.map(value => Math.round(value * scale));
  if (!from || !to) return [];
  const extents = from.map((value, axis) => Math.abs(to[axis] - value) + 1);
  if (extents.some(extent => extent > MAX_ENTITY_BOUNDS * scale)
    || extents.reduce((product, extent) => product * extent, 1) > MAX_BUILD_PLAN_VOXELS) {
    return [];
  }
  const shared = {
    size,
    color: primitive.color,
    componentId: primitive.componentId
  };
  const points: number[][] = [];
  if (primitive.type === 'line') {
    points.push(...expandLine(from, to));
  } else if (primitive.type === 'box') {
    const min = from.map((value, axis) => Math.min(value, to[axis]));
    const max = from.map((value, axis) => Math.max(value, to[axis]));
    for (let x = min[0]; x <= max[0]; x++) {
      for (let y = min[1]; y <= max[1]; y++) {
        for (let z = min[2]; z <= max[2]; z++) {
          const boundary = x === min[0] || x === max[0]
            || y === min[1] || y === max[1]
            || z === min[2] || z === max[2];
          if (!primitive.hollow || boundary) points.push([x, y, z]);
        }
      }
    }
  }
  return points.map(point => ({
    x: point[0] / scale,
    y: point[1] / scale,
    z: point[2] / scale,
    ...shared
  }));
}

function planSummary(plan: NormalizedSpaceBuildPlan | null) {
  if (!plan || plan.blocks.length === 0) {
    return {
      name: plan?.name || '',
      kind: plan?.kind || null,
      voxelCount: 0,
      standardCount: 0,
      microCount: 0,
      componentCount: plan?.components.length || 0,
      scriptCount: plan?.components.filter(component => !!component.script).length || 0,
      constraintCount: plan?.constraints.length || 0,
      bounds: null
    };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let standardCount = 0;
  for (const block of plan.blocks) {
    if (block.size >= 1) standardCount++;
    for (let axis = 0; axis < 3; axis++) {
      const value = axis === 0 ? block.x : axis === 1 ? block.y : block.z;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value + block.size);
    }
  }
  return {
    name: plan.name,
    kind: plan.kind,
    voxelCount: plan.blocks.length,
    standardCount,
    microCount: plan.blocks.length - standardCount,
    componentCount: plan.components.length,
    scriptCount: plan.components.filter(component => !!component.script).length,
    constraintCount: plan.constraints.length,
    bounds: {
      min,
      max,
      size: max.map((value, axis) => value - min[axis])
    }
  };
}

function componentDepth(id: string, parents: Map<string, string | null>): number {
  const visited = new Set<string>();
  let current: string | null | undefined = id;
  let depth = 0;
  while (current !== null) {
    if (current === undefined || !parents.has(current)) return Infinity;
    if (visited.has(current)) return Infinity;
    visited.add(current);
    current = parents.get(current);
    if (current !== null) depth++;
  }
  return depth;
}

function runtimeSlot(plan: NormalizedSpaceBuildPlan): any {
  if (plan.kind === 'structure') {
    return Object.freeze({
      kind: 'blockset',
      name: plan.name,
      blockCount: plan.blocks.length,
      blocks: plan.blocks.map(block => Object.freeze({
        dx: block.x,
        dy: block.y,
        dz: block.z,
        size: block.size,
        block: BlockTypes.COLOR_BLOCK,
        color: block.color
      }))
    });
  }
  const root = plan.components.find(component => component.parentId === null)!;
  const rootComponentId = root.id;
  const children = plan.components.filter(component => component.parentId !== null);
  const scripts = plan.components
    .filter(component => typeof component.script === 'string' && component.script.length > 0)
    .map(component => ({ id: component.id, code: component.script }));
  return Object.freeze({
    kind: 'entity',
    name: root.name ?? '',
    rootComponentId,
    mode: scripts.length > 0 ? ContraptionMode.PROGRAMMABLE : ContraptionMode.FREE_PHYSICS,
    blockCount: plan.blocks.length,
    nodeCount: plan.components.length,
    blocks: plan.blocks.map(block => ({
      localX: block.x,
      localY: block.y,
      localZ: block.z,
      size: block.size,
      block: BlockTypes.COLOR_BLOCK,
      color: block.color,
      entityId: block.componentId
    })),
    childEntities: children.map(component => ({
      id: component.id,
      name: component.name ?? '',
      parentId: component.parentId,
      ...(component.pivot ? { pivot: [...component.pivot] } : {}),
      bodyType: component.bodyType || 'kinematic',
      ...(component.mass !== undefined ? { mass: component.mass } : {}),
      restitution: component.restitution ?? plan.restitution,
      friction: component.friction ?? plan.friction,
      useGravity: component.useGravity ?? false,
      collisionEnabled: component.collisionEnabled ?? true,
      seats: (component.seats || []).map(seat => builderSeat(seat))
    })),
    scripts,
    enabled: scripts.map(script => ({
      id: script.id,
      enabled: plan.components.find(component => component.id === script.id)?.scriptEnabled !== false
    })),
    constraints: plan.constraints.map(runtimeConstraint),
    bodyType: root.bodyType || plan.bodyType,
    mass: root.mass ?? plan.mass,
    restitution: root.restitution ?? plan.restitution,
    friction: root.friction ?? plan.friction,
    useGravity: root.useGravity ?? plan.useGravity,
    collisionEnabled: root.collisionEnabled ?? plan.collisionEnabled,
    seats: (root.seats || []).map(seat => builderSeat(seat))
  });
}

export function validateSpaceBuildPlan(input: any): SpaceBuildValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const kind: SpaceBuildKind | null = input?.kind === 'structure' || input?.kind === 'entity'
    ? input.kind
    : null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) errors.push('Build plan must be an object.');
  if (input?.version !== undefined && Number(input.version) !== SPACE_BUILD_PLAN_VERSION) {
    errors.push(`Build plan version must be ${SPACE_BUILD_PLAN_VERSION}.`);
  }
  if (!kind) errors.push("kind must be 'structure' or 'entity'.");

  const rawAnchor = input?.anchor ?? 'crosshair';
  const anchor = rawAnchor === 'crosshair' ? 'crosshair' : finiteVector(rawAnchor);
  if (!anchor) errors.push("anchor must be 'crosshair' or a finite [x,y,z] vector.");

  const rawBlocks = Array.isArray(input?.blocks) ? [...input.blocks] : [];
  const rawPrimitives = Array.isArray(input?.primitives) ? input.primitives : [];
  for (const primitive of rawPrimitives) {
    if (primitive?.type !== 'box' && primitive?.type !== 'line') {
      errors.push("Primitive type must be 'box' or 'line'.");
      continue;
    }
    const expanded = expandPrimitive(primitive);
    if (expanded.length === 0) errors.push('Primitive coordinates must be finite grid vectors.');
    rawBlocks.push(...expanded);
    if (rawBlocks.length > MAX_BUILD_PLAN_VOXELS) break;
  }
  if (rawBlocks.length === 0) errors.push('Build plan must contain at least one block or primitive.');
  if (rawBlocks.length > MAX_BUILD_PLAN_VOXELS) {
    errors.push(`Build plan may contain at most ${MAX_BUILD_PLAN_VOXELS.toLocaleString()} voxels.`);
  }

  const components: SpaceBuildComponentInput[] = kind === 'entity'
    ? (Array.isArray(input?.components) && input.components.length > 0
        ? input.components.map(closedBuildComponent)
        : [{ id: 'component', parentId: null, bodyType: input?.bodyType || 'dynamic' }])
    : [];
  if (components.length > MAX_ENTITY_COMPONENTS) {
    errors.push(`Entity may contain at most ${MAX_ENTITY_COMPONENTS} components.`);
  }
  const componentIds = new Set<string>();
  const parents = new Map<string, string | null>();
  let totalScriptBytes = 0;
  const encoder = new TextEncoder();
  if (input?.bodyType !== undefined && input.bodyType !== 'dynamic' && input.bodyType !== 'kinematic') {
    errors.push('bodyType must be dynamic or kinematic.');
  }
  if (input?.mass !== undefined && (!(Number(input.mass) >= 0.1) || !Number.isFinite(Number(input.mass)))) {
    errors.push('mass must be a finite number of at least 0.1 kg.');
  }
  for (const component of components) {
    const id = String(component?.id || '');
    if (!isValidComponentId(id)) {
      errors.push(`Invalid component id '${id || '(empty)'}'.`);
      continue;
    }
    if (componentIds.has(id)) errors.push(`Duplicate component id '${id}'.`);
    component.id = id;
    if (component.name !== undefined && (typeof component.name !== 'string'
      || inventoryNameLength(component.name) > MAX_INVENTORY_NAME_LENGTH)) {
      errors.push(`Component '${id}' name must contain at most ${MAX_INVENTORY_NAME_LENGTH} characters.`);
    }
    if (component.name !== undefined) component.name = normalizeInventoryName(component.name);
    componentIds.add(id);
    const parentId = component.parentId === null
      ? null
      : String(component.parentId ?? '');
    component.parentId = parentId;
    parents.set(id, parentId);
    if (component.pivot !== undefined && !finiteVector(component.pivot)) {
      errors.push(`Component '${id}' has an invalid pivot.`);
    }
    if (component.bodyType !== undefined && component.bodyType !== 'dynamic' && component.bodyType !== 'kinematic') {
      errors.push(`Component '${id}' has an invalid bodyType.`);
    }
    if (component.mass !== undefined && (!(Number(component.mass) >= 0.1) || !Number.isFinite(Number(component.mass)))) {
      errors.push(`Component '${id}' has an invalid mass.`);
    }
    for (const field of ['restitution', 'friction'] as const) {
      if (component[field] !== undefined && (!Number.isFinite(Number(component[field]))
        || Number(component[field]) < 0 || Number(component[field]) > 1)) {
        errors.push(`Component '${id}' has an invalid ${field}.`);
      }
    }
    for (const seat of component.seats || []) {
      if (!finiteVector(Array.isArray(seat) ? seat : seat?.position)) {
        errors.push(`Component '${id}' has an invalid seat.`);
        continue;
      }
      if (Array.isArray(seat)) continue;
      if (seat.rotation !== undefined && !finiteUnitQuaternion(seat.rotation)) {
        errors.push(`Component '${id}' has a seat with an invalid rotation.`);
      }
      if (seat.fixedOrientation !== undefined && typeof seat.fixedOrientation !== 'boolean') {
        errors.push(`Component '${id}' has a seat with an invalid fixedOrientation.`);
      }
    }
    if (component.script !== undefined) {
      if (typeof component.script !== 'string') {
        errors.push(`Component '${id}' script must be a string.`);
      } else {
        const bytes = encoder.encode(component.script).byteLength;
        totalScriptBytes += bytes;
        if (bytes > MAX_BUILD_SCRIPT_BYTES) errors.push(`Component '${id}' script exceeds 64 KiB.`);
      }
    }
  }
  const roots = components.filter(component => component.parentId === null);
  // The plan title is only a creation default, never a second stored entity name.
  if (roots.length === 1 && roots[0].name === undefined) {
    roots[0].name = normalizeInventoryName(input?.name);
  }
  if (kind === 'entity' && roots.length !== 1) {
    errors.push('Entity components must contain exactly one structural root (parentId: null).');
  }
  const rootComponentId = roots.length === 1 ? roots[0].id : null;
  if (totalScriptBytes > MAX_BUILD_TOTAL_SCRIPT_BYTES) errors.push('Entity scripts exceed 512 KiB in total.');
  for (const component of components) {
    if (component.parentId !== null && !componentIds.has(String(component.parentId))) {
      errors.push(`Component '${component.id}' references missing parent '${component.parentId}'.`);
    }
    if (componentDepth(component.id, parents) > 16) {
      errors.push(`Component '${component.id}' is cyclic or exceeds hierarchy depth 16.`);
    }
  }

  const normalizedBlocks: NormalizedBuildVoxel[] = [];
  const exact = new Set<string>();
  const standards = new Set<string>();
  const microParents = new Set<string>();
  for (const raw of rawBlocks.slice(0, MAX_BUILD_PLAN_VOXELS)) {
    if (raw?.size !== undefined && Number(raw.size) !== 1 && Number(raw.size) !== MICRO_SIZE) {
      errors.push('Voxel size must be 1 or 0.125.');
      continue;
    }
    const size: 1 | typeof MICRO_SIZE = Number(raw?.size) === MICRO_SIZE ? MICRO_SIZE : 1;
    const x = normalizedGridCoordinate(raw?.x, size);
    const y = normalizedGridCoordinate(raw?.y, size);
    const z = normalizedGridCoordinate(raw?.z, size);
    if (x === null || y === null || z === null) {
      errors.push('Every voxel coordinate must lie on its 1 m or 0.125 m grid.');
      continue;
    }
    const componentId = kind === 'entity'
      ? String(raw?.componentId ?? rootComponentId ?? '')
      : '';
    if (kind === 'entity' && !componentIds.has(componentId)) {
      errors.push(`Voxel references missing component '${componentId}'.`);
      continue;
    }
    const voxel: NormalizedBuildVoxel = {
      x,
      y,
      z,
      size,
      color: normalizeColor(raw?.color, DEFAULT_BLOCK_COLOR),
      componentId
    };
    const key = voxelKey(voxel);
    const parent = standardParentKey(voxel);
    if (exact.has(key) || (size >= 1 ? microParents.has(parent) : standards.has(parent))) {
      errors.push(`Duplicate or overlapping voxel at ${x},${y},${z} in '${componentId}'.`);
      continue;
    }
    exact.add(key);
    if (size >= 1) standards.add(parent);
    else microParents.add(parent);
    normalizedBlocks.push(voxel);
  }

  const constraints: SpaceBuildConstraintInput[] = Array.isArray(input?.constraints)
    ? input.constraints.map(closedBuildConstraint)
    : [];
  if (constraints.length > MAX_BUILD_PLAN_CONSTRAINTS) {
    errors.push(`Entity may contain at most ${MAX_BUILD_PLAN_CONSTRAINTS} constraints.`);
  }
  const constraintIds = new Set<string>();
  for (const constraint of constraints.slice(0, MAX_BUILD_PLAN_CONSTRAINTS)) {
    constraint.id = String(constraint?.id || '');
    constraint.bodyA = constraint?.bodyA === null || constraint?.bodyA === undefined
      ? null
      : String(constraint.bodyA);
    constraint.bodyB = String(constraint?.bodyB || '');
    if (!isValidConstraintId(constraint.id) || constraintIds.has(constraint.id)) {
      errors.push(`Invalid or duplicate constraint id '${constraint.id}'.`);
    }
    constraintIds.add(constraint.id);
    if (!['point', 'hinge', 'weld'].includes(constraint.type)) {
      errors.push(`Constraint '${constraint.id}' has an invalid type.`);
    }
    if ((constraint.bodyA !== null && !componentIds.has(constraint.bodyA))
      || !componentIds.has(constraint.bodyB)
      || (constraint.bodyA !== null && constraint.bodyA === constraint.bodyB)) {
      errors.push(`Constraint '${constraint.id}' references an invalid component.`);
    }
    for (const field of ['anchorA', 'anchorB', 'axisA', 'axisB'] as const) {
      if (constraint[field] !== undefined) {
        const normalized = finiteVector(constraint[field]);
        if (!normalized) errors.push(`Constraint '${constraint.id}' has an invalid ${field}.`);
        else constraint[field] = normalized;
      }
    }
    if (constraint.limits !== undefined) {
      const min = Number(constraint.limits?.min);
      const max = Number(constraint.limits?.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(min) > 10_000 || Math.abs(max) > 10_000) {
        errors.push(`Constraint '${constraint.id}' has invalid limits.`);
      } else {
        constraint.limits = { min: Math.min(min, max), max: Math.max(min, max) };
      }
    }
    constraint.stiffness = clampedUnit(constraint.stiffness, 0.9);
    constraint.collideConnected = constraint.collideConnected === true;
  }

  const plan: NormalizedSpaceBuildPlan | null = kind && anchor && errors.length === 0
    ? {
        version: 1,
        kind,
        name: (String(input?.name || '').trim() || (kind === 'entity' ? 'AI Entity' : 'AI Structure')).slice(0, 80),
        anchor: anchor as SpaceBuildAnchor,
        blocks: normalizedBlocks,
        components,
        constraints: constraints.slice(0, MAX_BUILD_PLAN_CONSTRAINTS),
        bodyType: input?.bodyType === 'kinematic' ? 'kinematic' : 'dynamic',
        ...(input?.mass !== undefined && Number.isFinite(Number(input.mass)) && Number(input.mass) >= 0.1
          ? { mass: Number(input.mass) }
          : {}),
        restitution: clampedUnit(input?.restitution, 0.1),
        friction: clampedUnit(input?.friction, 0.7),
        useGravity: input?.useGravity !== false,
        collisionEnabled: input?.collisionEnabled !== false
      }
    : null;
  if (plan && planSummary(plan).bounds?.size.some(size => size > MAX_ENTITY_BOUNDS)) {
    errors.push(`Build bounds may not exceed ${MAX_ENTITY_BOUNDS} m per axis.`);
  }
  if (kind === 'structure' && Array.isArray(input?.components) && input.components.length > 0) {
    warnings.push('Structure plans ignore component definitions.');
  }
  const finalPlan = errors.length === 0 ? plan : null;
  return {
    ok: errors.length === 0 && !!finalPlan,
    errors: [...new Set(errors)].slice(0, 32),
    warnings: [...new Set(warnings)],
    plan: finalPlan,
    slot: finalPlan ? runtimeSlot(finalPlan) : null,
    summary: planSummary(finalPlan)
  };
}

function worldCellFor(position: THREE.Vector3, block: NormalizedBuildVoxel) {
  return {
    x: Math.round(position.x + block.x),
    y: Math.round(position.y + block.y),
    z: Math.round(position.z + block.z)
  };
}

function worldMicroFor(position: THREE.Vector3, block: NormalizedBuildVoxel) {
  return {
    x: Math.round((position.x + block.x) * MICRO_DIVISIONS),
    y: Math.round((position.y + block.y) * MICRO_DIVISIONS),
    z: Math.round((position.z + block.z) * MICRO_DIVISIONS)
  };
}

export class SpaceBuilder {
  world: any;
  contraptions: any;
  controller: any;
  previewPlacement: any;
  validation: SpaceBuildValidation | null;
  job: BuilderJob | null;
  history: BuildReceipt[];
  onStatus: ((status: SpaceBuilderJobStatus | null) => void) | null;
  sequence: number;

  constructor(options: { world: any; contraptions: any; controller: any; onStatus?: (status: SpaceBuilderJobStatus | null) => void }) {
    this.world = options.world;
    this.contraptions = options.contraptions;
    this.controller = options.controller;
    this.previewPlacement = null;
    this.validation = null;
    this.job = null;
    this.history = [];
    this.onStatus = options.onStatus || null;
    this.sequence = 0;
  }

  validate(plan: SpaceBuildPlanInput): SpaceBuildValidation {
    return validateSpaceBuildPlan(plan);
  }

  private resolvePosition(validation: SpaceBuildValidation): THREE.Vector3 | null {
    const anchor = validation.plan?.anchor;
    if (Array.isArray(anchor)) {
      const position = new THREE.Vector3().fromArray(anchor);
      if (validation.plan?.kind === 'structure') {
        position.set(Math.round(position.x), Math.round(position.y), Math.round(position.z));
      }
      return position;
    }
    const pose = this.controller?.getInventoryPlacementPose?.(validation.slot);
    return pose?.position?.clone?.() || (pose?.position ? new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z) : null);
  }

  private validateWorldPlacement(validation: SpaceBuildValidation, position: THREE.Vector3) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const plan = validation.plan;
    if (!plan) return { errors, warnings };
    const playerAabb = this.controller?.physics?.getAABB?.();
    let occupied = 0;
    let overlapsPlayer = false;
    for (const block of plan.blocks) {
      const y = position.y + block.y;
      if (y < 0 || y + block.size > CHUNK_SIZE_Y) {
        errors.push(`The preview extends outside the buildable world height [0,${CHUNK_SIZE_Y}).`);
        break;
      }
      const x = position.x + block.x;
      const z = position.z + block.z;
      if (playerAabb && x + block.size > playerAabb.minX && x < playerAabb.maxX
        && y + block.size > playerAabb.minY && y < playerAabb.maxY
        && z + block.size > playerAabb.minZ && z < playerAabb.maxZ) {
        overlapsPlayer = true;
      }
      if (plan.kind !== 'structure') continue;
      if (block.size < 1) {
        const micro = worldMicroFor(position, block);
        const parent = {
          x: Math.floor(micro.x / MICRO_DIVISIONS),
          y: Math.floor(micro.y / MICRO_DIVISIONS),
          z: Math.floor(micro.z / MICRO_DIVISIONS)
        };
        if ((this.world?.getBlock?.(parent.x, parent.y, parent.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
          || this.world?.getMicroBlock?.(micro.x, micro.y, micro.z)) occupied++;
      } else {
        const cell = worldCellFor(position, block);
        if ((this.world?.getBlock?.(cell.x, cell.y, cell.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
          || this.world?.hasMicroInStandardCell?.(cell.x, cell.y, cell.z)) occupied++;
      }
    }
    if (overlapsPlayer) errors.push('The preview intersects the local player. Aim at a clear placement surface.');
    if (occupied >= plan.blocks.length && plan.blocks.length > 0) {
      errors.push('Every planned voxel is already occupied at this placement.');
    } else if (occupied > 0) {
      warnings.push(`${occupied.toLocaleString()} occupied voxel targets will be skipped.`);
    }
    return { errors, warnings };
  }

  preview(plan: SpaceBuildPlanInput): SpaceBuildValidation {
    const validation = validateSpaceBuildPlan(plan);
    this.validation = validation;
    this.previewPlacement = null;
    if (!validation.ok) return validation;
    const position = this.resolvePosition(validation);
    if (!position) {
      const failed = {
        ...validation,
        ok: false,
        errors: [...validation.errors, 'Aim at terrain or an entity surface to place this build.']
      };
      this.validation = failed;
      return failed;
    }
    const placement = this.validateWorldPlacement(validation, position);
    if (placement.errors.length > 0) {
      const failed = {
        ...validation,
        ok: false,
        errors: [...validation.errors, ...placement.errors],
        warnings: [...validation.warnings, ...placement.warnings]
      };
      this.validation = failed;
      return failed;
    }
    const placedValidation = placement.warnings.length > 0
      ? { ...validation, warnings: [...validation.warnings, ...placement.warnings] }
      : validation;
    this.validation = placedValidation;
    this.previewPlacement = Object.freeze({
      slot: placedValidation.slot,
      kind: placedValidation.plan?.kind === 'entity' ? 'entity' : 'blockset',
      position
    });
    return placedValidation;
  }

  getRenderPreview() {
    return this.previewPlacement;
  }

  clearPreview() {
    this.previewPlacement = null;
    this.validation = null;
  }

  private status(): SpaceBuilderJobStatus | null {
    const job = this.job;
    if (!job) return null;
    return Object.freeze({
      id: job.id,
      label: job.label,
      kind: job.kind,
      phase: job.phase,
      processed: job.processed,
      total: job.total,
      changed: job.changed,
      detail: job.error || (job.kind === 'entity' ? 'Preparing validated entity voxels' : undefined),
      commitId: job.phase === 'complete' ? job.id : null,
      entityId: job.entity?.publicId ?? null
    });
  }

  private publishStatus() {
    this.onStatus?.(this.status());
  }

  getJob(jobId: string | null = null): SpaceBuilderJobStatus | null {
    if (!this.job || (jobId && this.job.id !== jobId)) return null;
    return this.status();
  }

  commit(plan: SpaceBuildPlanInput | null = null) {
    if (this.job && !['complete', 'failed', 'cancelled'].includes(this.job.phase)) {
      return Object.freeze({ ok: false, jobId: this.job.id, reason: 'build_in_progress' });
    }
    const validation = plan ? this.preview(plan) : this.validation;
    if (!validation?.ok || !validation.plan || !this.previewPlacement?.position) {
      return Object.freeze({ ok: false, jobId: null, reason: validation?.errors?.[0] || 'no_valid_preview' });
    }
    const id = `build-${++this.sequence}`;
    this.job = {
      id,
      label: validation.plan.kind === 'entity' ? `Building ${validation.plan.name}` : `Constructing ${validation.plan.name}`,
      kind: validation.plan.kind,
      phase: validation.plan.kind === 'entity' ? 'preparing' : 'applying',
      plan: validation.plan,
      slot: validation.slot,
      position: this.previewPlacement.position.clone(),
      processed: 0,
      total: validation.plan.blocks.length,
      changed: 0,
      applied: [],
      preparedBlocks: [],
      rollback: []
    };
    this.previewPlacement = null;
    this.publishStatus();
    return Object.freeze({ ok: true, jobId: id, reason: 'queued' });
  }

  private applyStructureVoxel(job: BuilderJob, block: NormalizedBuildVoxel): number {
    if (block.size < 1) {
      const micro = worldMicroFor(job.position!, block);
      const result = this.contraptions?.performBasicAction?.({
        domain: ActionDomain.WORLD,
        action: 'place-micro',
        micro,
        color: block.color,
        actor: { source: 'agent', playerId: 'local' }
      });
      if (result?.placed > 0) job.applied.push({ size: MICRO_SIZE, micro, color: block.color });
      return result?.placed || 0;
    }
    const cell = worldCellFor(job.position!, block);
    const result = this.contraptions?.performBasicAction?.({
      domain: ActionDomain.WORLD,
      action: 'place-standard',
      cell,
      block: BlockTypes.COLOR_BLOCK,
      color: block.color,
      actor: { source: 'agent', playerId: 'local' }
    });
    if (result?.placed > 0) job.applied.push({ size: 1, cell, color: block.color });
    return result?.placed || 0;
  }

  private rollbackVoxel(voxel: AppliedVoxel): number {
    if (voxel.size < 1 && voxel.micro) {
      const current = this.world?.getMicroBlock?.(voxel.micro.x, voxel.micro.y, voxel.micro.z);
      if (!current || normalizeColor(current.color) !== voxel.color) return 0;
      const result = this.contraptions?.performBasicAction?.({
        domain: ActionDomain.WORLD,
        action: 'remove-micro',
        micro: voxel.micro,
        actor: { source: 'agent', playerId: 'local' }
      });
      return result?.removed || 0;
    }
    if (!voxel.cell) return 0;
    const currentBlock = this.world?.getBlock?.(voxel.cell.x, voxel.cell.y, voxel.cell.z);
    const currentColor = this.world?.getBlockColor?.(voxel.cell.x, voxel.cell.y, voxel.cell.z);
    if (currentBlock !== BlockTypes.COLOR_BLOCK || normalizeColor(currentColor) !== voxel.color) return 0;
    const result = this.contraptions?.performBasicAction?.({
      domain: ActionDomain.WORLD,
      action: 'remove-standard',
      cell: voxel.cell,
      actor: { source: 'agent', playerId: 'local' }
    });
    return result?.removed || 0;
  }

  private complete(job: BuilderJob) {
    job.phase = job.kind === 'rollback' ? (job.rollbackFinalPhase || 'complete') : 'complete';
    const receipt: BuildReceipt = job.receipt || {
      id: job.id,
      kind: job.plan?.kind || 'structure',
      name: job.plan?.name || job.label,
      applied: [...job.applied],
      entity: job.entity || null
    };
    if (job.kind !== 'rollback') {
      this.history.push(receipt);
      if (this.history.length > 20) this.history.shift();
    }
    this.publishStatus();
  }

  update(maxOperations = BUILD_OPERATIONS_PER_FRAME, timeBudgetMs = BUILD_FRAME_BUDGET_MS) {
    const job = this.job;
    if (!job || ['complete', 'failed', 'cancelled'].includes(job.phase)) return false;
    const sync = this.world?.editPersistence?.getSyncStatus?.();
    if ((job.kind === 'structure' || job.kind === 'rollback') && sync?.backpressured) {
      job.phase = 'waiting';
      this.publishStatus();
      return true;
    }
    if (job.phase === 'waiting') job.phase = job.kind === 'rollback' ? 'rolling_back' : 'applying';
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const started = now();
    let operations = 0;
    try {
      while (job.processed < job.total
        && operations < Math.max(1, maxOperations)
        && (operations === 0 || now() - started < Math.max(0, timeBudgetMs))) {
        if (job.kind === 'structure') {
          job.changed += this.applyStructureVoxel(job, job.plan!.blocks[job.processed]);
        } else if (job.kind === 'entity') {
          job.preparedBlocks.push({ ...job.slot.blocks[job.processed] });
          job.changed++;
        } else {
          job.changed += this.rollbackVoxel(job.rollback[job.processed]);
        }
        job.processed++;
        operations++;
      }
      if (job.processed >= job.total) {
        if (job.kind === 'entity') {
          job.entity = this.contraptions?.buildFromSlot?.(
            job.slot,
            job.position,
            null,
            true,
            job.preparedBlocks
          );
          if (!job.entity) throw new Error('Entity could not be registered.');
        }
        this.complete(job);
        return false;
      }
      this.publishStatus();
      return true;
    } catch (error: any) {
      if (job.kind === 'structure' && job.applied.length > 0) {
        job.kind = 'rollback';
        job.label = `Rolling back failed ${job.plan?.name || 'build'}`;
        job.phase = 'rolling_back';
        job.rollback = [...job.applied].reverse();
        job.rollbackFinalPhase = 'failed';
        job.processed = 0;
        job.total = job.rollback.length;
        job.changed = 0;
        job.applied = [];
        job.error = error?.message || String(error);
        this.publishStatus();
        return true;
      }
      job.phase = 'failed';
      job.error = error?.message || String(error);
      this.publishStatus();
      return false;
    }
  }

  cancel(jobId: string | null = null) {
    const job = this.job;
    if (!job || (jobId && job.id !== jobId) || ['complete', 'failed', 'cancelled'].includes(job.phase)) {
      return Object.freeze({ ok: false, reason: 'job_unavailable' });
    }
    if (job.kind === 'structure' && job.applied.length > 0) {
      job.kind = 'rollback';
      job.label = `Cancelling ${job.plan?.name || 'build'}`;
      job.phase = 'rolling_back';
      job.rollback = [...job.applied].reverse();
      job.rollbackFinalPhase = 'cancelled';
      job.processed = 0;
      job.total = job.rollback.length;
      job.changed = 0;
      job.applied = [];
      this.publishStatus();
      return Object.freeze({ ok: true, reason: 'rolling_back' });
    }
    job.phase = 'cancelled';
    this.publishStatus();
    return Object.freeze({ ok: true, reason: 'cancelled' });
  }

  undo(commitId: string | null = null) {
    if (this.job && !['complete', 'failed', 'cancelled'].includes(this.job.phase)) {
      return Object.freeze({ ok: false, jobId: this.job.id, reason: 'build_in_progress' });
    }
    const index = commitId
      ? this.history.findIndex(receipt => receipt.id === commitId)
      : this.history.length - 1;
    if (index < 0) return Object.freeze({ ok: false, jobId: null, reason: 'nothing_to_undo' });
    const receipt = this.history[index];
    if (receipt.kind === 'entity') {
      const available = receipt.entity && this.contraptions?.contraptions?.includes?.(receipt.entity);
      if (!available) return Object.freeze({ ok: false, jobId: null, reason: 'entity_unavailable' });
      this.contraptions.removeContraption?.(receipt.entity);
      this.history.splice(index, 1);
      return Object.freeze({ ok: true, jobId: null, reason: 'undone' });
    }
    const id = `undo-${++this.sequence}`;
    this.history.splice(index, 1);
    this.job = {
      id,
      label: `Undoing ${receipt.name}`,
      kind: 'rollback',
      phase: 'rolling_back',
      plan: null,
      slot: null,
      position: null,
      processed: 0,
      total: receipt.applied.length,
      changed: 0,
      applied: [],
      preparedBlocks: [],
      rollback: [...receipt.applied].reverse(),
      receipt,
      rollbackFinalPhase: 'complete'
    };
    this.publishStatus();
    return Object.freeze({ ok: true, jobId: id, reason: 'queued' });
  }

  getHistory() {
    return Object.freeze(this.history.map(receipt => Object.freeze({
      id: receipt.id,
      kind: receipt.kind,
      name: receipt.name,
      changed: receipt.kind === 'entity' ? receipt.entity?.blocks?.length || 0 : receipt.applied.length,
      entityId: receipt.entity?.publicId ?? null
    })));
  }
}
