import {
  MAX_ENTITY_BOUNDS,
  MAX_ENTITY_COMPONENTS,
  MAX_ENTITY_DECORATIONS,
  MAX_IMPORT_COORDINATE,
  MAX_INVENTORY_BLOCKS,
  MAX_INVENTORY_CONSTRAINTS,
  MAX_INVENTORY_IMPORT_BYTES,
  MAX_INVENTORY_SCRIPT_BYTES,
  MAX_INVENTORY_TOTAL_SCRIPT_BYTES,
  MAX_PORTABLE_BODY_MASS,
  MAX_PORTABLE_CONSTRAINT_VALUE,
  MAX_PORTABLE_VECTOR_COMPONENT,
} from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { normalizeDecorations } from '@entropydrop/space-engine/contraption/Decorations.ts';
import { isValidComponentId, isValidConstraintId } from '@entropydrop/space-engine/contraption/PortableIds.ts';
import {
  inventoryNameLength,
  MAX_INVENTORY_NAME_LENGTH,
  trimInventoryName,
  truncateInventoryName,
} from '@entropydrop/space-engine/storage/InventoryName.ts';
import {
  decodeInventoryResource,
  encodeInventoryResource,
  INVENTORY_PROTOBUF_SCHEMA_VERSION,
  portableEntityToRuntime,
  wrapLegacyInventoryResource,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import type {
  BlockSetVoxel,
  EntityVoxel,
  FlatPortableEntity,
  InventoryBlockSet,
  InventoryColorSet,
  InventoryConstraint,
  InventoryEntity,
  InventoryItem,
  InventoryKind,
  InventoryResource,
  InventoryResourceMap,
  PortableBlockSet,
  PortableColorSet,
  PortableComponent,
  PortableEntity,
  PortableItem,
  PortableResource,
  PortableVoxel,
} from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MICRO_DIVISIONS } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { normalizePaletteEntry } from '@entropydrop/space-engine/voxel/Palette.ts';
import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import * as THREE from 'three';
import {
  getInventoryPreviewBlocks,
  isStoppedGridQuaternion,
  STOPPED_GRID_EPSILON,
  validateInventoryVoxelBounds,
  validateStoppedEntityGrid,
  validateVoxelOccupancy,
  withinEntityBounds,
} from './InventoryGeometry.ts';

const HEX_COLOR = /^#?[0-9a-f]{6}$/i;

export type InventoryImportResult<T = InventoryResource> =
  | { ok: true; item: T; error?: never }
  | { ok: false; error: string; item?: never };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const validBaseCoordinates = (values: number[]) => values.every(value => (
  Number.isSafeInteger(value) && Math.abs(value) <= MAX_IMPORT_COORDINATE
));
const portableVector = (value: unknown, maxAbs = MAX_PORTABLE_VECTOR_COMPONENT) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3) return null;
  const vector = value.map(Number);
  return vector.every(component => Number.isFinite(component) && Math.abs(component) <= maxAbs)
    ? vector
    : null;
};
// Unit-quaternion shape check without the stopped-grid restriction, which
// applies only to authored component local/anchor rotations.
const portableUnitQuaternion = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) return null;
  const components = value.map(Number);
  const lengthSq = components.reduce((sum, component) => sum + component * component, 0);
  const unitTolerance = Math.max(1e-6, 1e-6 * Math.max(Math.abs(lengthSq), 1));
  if (!components.every(Number.isFinite)
    || !Number.isFinite(lengthSq)
    || Math.abs(lengthSq - 1) > unitTolerance) return null;
  return new THREE.Quaternion(
    components[0], components[1], components[2], components[3]
  ).normalize().toArray();
};
const portableQuaternion = (value: unknown) => {
  if (value === undefined) return undefined;
  // The backend rejects components outside -1..1 before it even checks the
  // norm, so an unnormalized rotation is mirrored here.
  if (Array.isArray(value) && value.map(Number).some(component => component < -1 || component > 1)) {
    return null;
  }
  const normalized = portableUnitQuaternion(value);
  return normalized === null || normalized === undefined
    ? null
    : (isStoppedGridQuaternion(normalized) ? normalized : null);
};
function runtimeVoxel(block: PortableVoxel): BlockSetVoxel;
function runtimeVoxel(block: PortableVoxel, ownerId: string): EntityVoxel;
function runtimeVoxel(block: PortableVoxel, ownerId: string | null = null): BlockSetVoxel | EntityVoxel {
  if (block?.block !== undefined && block.block !== BlockTypes.COLOR_BLOCK) {
    throw new Error(`Inventory v${INVENTORY_PROTOBUF_SCHEMA_VERSION} supports only color block id 1`);
  }
  const color = Number(block?.color ?? 0xf2a93b);
  if (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff) {
    throw new Error('Voxel color must be an unsigned 24-bit value');
  }
  const base = [block?.dx, block?.dy, block?.dz].map(Number);
  if (!validBaseCoordinates(base)) throw new Error('Voxel coordinates must be bounded safe integers');
  const microValues = [block?.mx, block?.my, block?.mz];
  const hasMicro = microValues.some(value => value !== undefined);
  let coordinates = base;
  if (hasMicro) {
    const micro = microValues.map(Number);
    if (!micro.every(value => Number.isInteger(value) && value >= 0 && value < MICRO_DIVISIONS)) {
      throw new Error('Micro coordinates mx/my/mz must all be integers between 0 and 7');
    }
    coordinates = base.map((value, index) => (
      (value * MICRO_DIVISIONS + micro[index]) / MICRO_DIVISIONS
    ));
  }
  const result = {
    size: hasMicro ? 1 / MICRO_DIVISIONS : 1,
    block: BlockTypes.COLOR_BLOCK,
    color,
    materialId: normalizeVoxelMaterialId(block.materialId),
  };
  if (ownerId !== null) {
    return {
      ...result,
      localX: coordinates[0],
      localY: coordinates[1],
      localZ: coordinates[2],
      entityId: ownerId
    };
  }
  return { ...result, dx: coordinates[0], dy: coordinates[1], dz: coordinates[2] };
};

function parseItem(data: PortableItem): InventoryImportResult<InventoryItem> {
  if (typeof data.id !== 'string' || !data.id.trim() || Array.from(data.id).length > 128) return fail('Item template id is invalid');
  if (typeof data.name !== 'string' || inventoryNameLength(data.name) > MAX_INVENTORY_NAME_LENGTH) return fail('Item name is invalid');
  const entityList: InventoryEntity[] = [];
  let blockSet: InventoryBlockSet | undefined;
  if (data.blockSet) {
    const parsed = parseInventoryImport(encodeInventoryResource('blockset', data.blockSet), 'blockset');
    if (parsed.ok === false) return parsed;
    blockSet = parsed.item;
  }
  let components = 0, constraints = 0, seats = 0, scriptBytes = 0, decorations = 0;
  const count = (component: PortableComponent): void => {
    components++;
    seats += (component.seats || []).length;
    decorations += (component.decorations || []).length;
    scriptBytes += new TextEncoder().encode(component.script || '').byteLength;
    for (const child of component.children || []) count(child);
  };
  for (const entity of data.entityList || []) {
    const position = portableVector(entity.root?.localPosition, MAX_IMPORT_COORDINATE) || [0, 0, 0];
    if (entity.root?.localPosition !== undefined && portableVector(entity.root.localPosition, MAX_IMPORT_COORDINATE) === null) return fail('Item entity position is invalid');
    const rotation = entity.root?.localRotation === undefined ? [0, 0, 0, 1] : portableQuaternion(entity.root.localRotation);
    if (!rotation) return fail('Item entity rotation must use 90-degree grid steps');
    const definition = { ...entity, root: { ...entity.root } };
    delete definition.root.localPosition;
    delete definition.root.localRotation;
    const parsed = parseInventoryImport(encodeInventoryResource('entity', definition), 'entity');
    if (parsed.ok === false) return parsed;
    count(definition.root);
    constraints += definition.constraints.length;
    entityList.push({ ...parsed.item, itemPosition: position, itemRotation: rotation, itemWorldConstraints: true });
  }
  const blocks = [...(blockSet?.blocks || []), ...entityList.flatMap(entity => entity.blocks)];
  if (!blocks.length || blocks.length > MAX_INVENTORY_BLOCKS) return fail('Item must contain between 1 and 65536 voxels');
  if (components > MAX_ENTITY_COMPONENTS || constraints > MAX_INVENTORY_CONSTRAINTS || seats > 256 || scriptBytes > MAX_INVENTORY_TOTAL_SCRIPT_BYTES || decorations > MAX_ENTITY_DECORATIONS) return fail('Item exceeds aggregate component, constraint, seat, decoration or script limits');
  const item: InventoryItem = {
    kind: 'item', id: data.id, name: trimInventoryName(data.name),
    blockSet, entityList, blocks, blockCount: blocks.length, nodeCount: components,
  };
  const geometry = getInventoryPreviewBlocks(item);
  const geometryError = validateInventoryVoxelBounds(geometry, false);
  if (geometryError) return fail(geometryError);
  for (const axis of ['x', 'y', 'z'] as const) {
    let minimum = Infinity, maximum = -Infinity;
    for (const entry of geometry) {
      minimum = Math.min(minimum, entry.center[axis] - entry.size / 2);
      maximum = Math.max(maximum, entry.center[axis] + entry.size / 2);
    }
    if ((maximum - minimum) * MICRO_DIVISIONS > MAX_ENTITY_BOUNDS * MICRO_DIVISIONS + STOPPED_GRID_EPSILON) {
      return fail('Item bounds exceed the portable bounds');
    }
  }
  return { ok: true, item };
}

function parseBlockset(data: PortableBlockSet): InventoryImportResult<InventoryBlockSet> {
  if (data?.type !== 'space-blockset' || data?.version !== INVENTORY_PROTOBUF_SCHEMA_VERSION) {
    return fail(`Expected a space-blockset v${INVENTORY_PROTOBUF_SCHEMA_VERSION} Protobuf file`);
  }
  if (typeof data.name !== 'string' || !trimInventoryName(data.name)) return fail('A block set must have a name');
  if (inventoryNameLength(data.name) > MAX_INVENTORY_NAME_LENGTH) {
    return fail(`A block set name may contain at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
  }
  if (!Array.isArray(data.blocks) || data.blocks.length === 0) return fail('A block set must contain voxels');
  if (data.blocks.length > MAX_INVENTORY_BLOCKS) {
    return fail(`A block set may contain at most ${MAX_INVENTORY_BLOCKS} voxels`);
  }
  let blocks;
  try {
    blocks = data.blocks.map(block => runtimeVoxel(block));
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid block set');
  }
  if (!withinEntityBounds(blocks, ['dx', 'dy', 'dz'])) {
    return fail(`Block-set bounds may not exceed ${MAX_ENTITY_BOUNDS} cells per axis`);
  }
  if (!validateVoxelOccupancy(blocks, ['dx', 'dy', 'dz'])) {
    return fail('Block set contains duplicate voxels or standard/micro overlap');
  }
  return {
    ok: true,
    item: {
      kind: 'blockset',
      name: truncateInventoryName(trimInventoryName(data.name)),
      blocks,
      blockCount: blocks.length
    }
  };
}

function parseEntity(data: PortableEntity): InventoryImportResult<InventoryEntity> {
  if (data?.type !== 'space-entity' || data?.version !== INVENTORY_PROTOBUF_SCHEMA_VERSION || !data.root) {
    return fail(`Expected a recursive space-entity v${INVENTORY_PROTOBUF_SCHEMA_VERSION} Protobuf file`);
  }
  if (Object.hasOwn(data, 'name')) return fail('Entity names belong to root.name');

  const ids = new Set();
  let componentCount = 0;
  let blockCount = 0;
  let seatCount = 0;
  let decorationCount = 0;
  let totalScriptBytes = 0;
  const validateBody = (body: PortableComponent['body'], id: string) => {
    if (!body || (body.type !== 'dynamic' && body.type !== 'kinematic')) {
      throw new Error(`Component ${id} must have a valid body config`);
    }
    if (body.mass !== undefined) {
      const mass = Number(body.mass);
      if (!Number.isFinite(mass) || mass < 0.1 || mass > MAX_PORTABLE_BODY_MASS) {
        throw new Error(`Component ${id} has invalid mass`);
      }
    }
    for (const field of ['restitution', 'friction'] as const) {
      if (body[field] === undefined) continue;
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Component ${id} has invalid ${field}`);
      }
    }
    for (const field of ['useGravity', 'collisionEnabled'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        throw new Error(`Component ${id} has invalid ${field}`);
      }
    }
  };
  const validateComponent = (component: PortableComponent, parentId: string | null, depth: number): void => {
    if (!component || typeof component !== 'object' || depth > 16) {
      throw new Error('Component hierarchy is malformed or exceeds depth 16');
    }
    const id = component.id;
    if (component.name !== undefined && (typeof component.name !== 'string'
      || inventoryNameLength(component.name) > MAX_INVENTORY_NAME_LENGTH)) {
      throw new Error(`Component ${id} name must be a string of at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
    }
    component.name = trimInventoryName(component.name ?? '');
    if (!isValidComponentId(id) || ids.has(id)) {
      throw new Error('Component ids must be unique portable identifiers');
    }
    ids.add(id);
    componentCount += 1;
    if (componentCount > MAX_ENTITY_COMPONENTS) {
      throw new Error(`An entity may contain at most ${MAX_ENTITY_COMPONENTS} components`);
    }
    const pivot = portableVector(component.pivot, MAX_IMPORT_COORDINATE);
    if (pivot === null) throw new Error(`Component ${id} has an invalid pivot`);
    const localPosition = portableVector(component.localPosition, MAX_IMPORT_COORDINATE);
    if (localPosition === null) throw new Error(`Component ${id} has an invalid local position`);
    if (parentId === null && (component.localPosition !== undefined || component.localRotation !== undefined)) {
      throw new Error('The entity root may not have a parent-relative transform');
    }
    for (const [label, value] of [
      ['local rotation', component.localRotation],
      ['anchor rotation', component.anchorRotation]
    ]) {
      if (portableQuaternion(value) === null) {
        throw new Error(`Component ${id} ${label} must use an axis-aligned 90-degree grid rotation`);
      }
    }
    validateBody(component.body, id);
    const decorations = normalizeDecorations(component.decorations);
    decorationCount += decorations.length;
    if (decorationCount > MAX_ENTITY_DECORATIONS) throw new Error(`An entity may contain at most ${MAX_ENTITY_DECORATIONS} decorations`);
    if (decorations.length) component.decorations = decorations;
    if (!Array.isArray(component.blocks) || !Array.isArray(component.children) || !Array.isArray(component.seats)) {
      throw new Error(`Component ${id} has malformed repeated fields`);
    }
    blockCount += component.blocks.length;
    if (blockCount > MAX_INVENTORY_BLOCKS) {
      throw new Error(`An entity may contain at most ${MAX_INVENTORY_BLOCKS} voxels`);
    }
    if (component.script !== undefined) {
      if (typeof component.script !== 'string') throw new Error(`Component ${id} has an invalid script`);
      const bytes = new TextEncoder().encode(component.script).byteLength;
      if (bytes > MAX_INVENTORY_SCRIPT_BYTES) {
        throw new Error(`One component script may not exceed ${MAX_INVENTORY_SCRIPT_BYTES / 1024} KiB`);
      }
      totalScriptBytes += bytes;
      if (totalScriptBytes > MAX_INVENTORY_TOTAL_SCRIPT_BYTES) {
        throw new Error(`Entity scripts may not exceed ${MAX_INVENTORY_TOTAL_SCRIPT_BYTES / 1024} KiB in total`);
      }
    }
    for (const seat of component.seats) {
      seatCount += 1;
      const position = portableVector(seat?.position, MAX_IMPORT_COORDINATE);
      if (seatCount > 256 || position === null || position === undefined) {
        throw new Error('Entity seats must be bounded 3D positions and may not exceed 256');
      }
      // Seat orientation is an arbitrary unit quaternion, unlike the
      // stopped-grid local/anchor rotations, so it uses the plain check.
      if (seat.rotation !== undefined && portableUnitQuaternion(seat.rotation) === null) {
        throw new Error('Entity seat rotations must be unit quaternions');
      }
      if (seat.fixedOrientation !== undefined && typeof seat.fixedOrientation !== 'boolean') {
        throw new Error('Entity seat fixedOrientation must be a boolean');
      }
    }
    for (const child of component.children) validateComponent(child, id, depth + 1);
  };
  try {
    validateComponent(data.root, null, 0);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid component hierarchy');
  }
  if (blockCount === 0) return fail('An entity must contain at least one voxel');

  let flat: FlatPortableEntity;
  let runtime: InventoryEntity;
  try {
    flat = portableEntityToRuntime(data);
    runtime = { ...flat, kind: 'entity', blocks: flat.blocks.map(block => runtimeVoxel(block, block.entityId)) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid recursive entity');
  }
  if (!withinEntityBounds(runtime.blocks, ['localX', 'localY', 'localZ'], 'entityId')) {
    return fail(`Entity bounds may not exceed ${MAX_ENTITY_BOUNDS} cells per axis`);
  }
  if (!validateVoxelOccupancy(runtime.blocks, ['localX', 'localY', 'localZ'], 'entityId')) {
    return fail('Entity contains duplicate voxels or standard/micro overlap');
  }
  const stoppedGridError = validateStoppedEntityGrid(runtime);
  if (stoppedGridError) return fail(stoppedGridError);

  if (!Array.isArray(data.constraints) || data.constraints.length > MAX_INVENTORY_CONSTRAINTS) {
    return fail(`An entity may contain at most ${MAX_INVENTORY_CONSTRAINTS} constraints`);
  }
  const constraintIds = new Set();
  const constraints: InventoryConstraint[] = [];
  for (const constraint of data.constraints) {
    const id = constraint?.id;
    const bodyA = constraint?.bodyA === null ? null : String(constraint?.bodyA ?? '');
    const bodyB = String(constraint?.bodyB || '');
    if (!isValidConstraintId(id) || constraintIds.has(id)) {
      return fail('Constraint ids must be unique portable identifiers');
    }
    if ((bodyA !== null && !ids.has(bodyA)) || !ids.has(bodyB) || bodyA === bodyB) {
      return fail(`Constraint ${id} references an invalid component`);
    }
    const vectors: Partial<InventoryConstraint> = {};
    for (const field of ['anchorA', 'anchorB', 'axisA', 'axisB', 'referenceA', 'referenceB'] as const) {
      if (constraint[field] === undefined) continue;
      const vector = portableVector(constraint[field]);
      if (vector === null) return fail(`Constraint ${id} has an invalid ${field}`);
      vectors[field] = vector;
    }
    let limits;
    if (constraint.limits !== undefined) {
      const min = Number(constraint.limits?.min);
      const max = Number(constraint.limits?.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)
        || Math.abs(min) > MAX_PORTABLE_CONSTRAINT_VALUE
        || Math.abs(max) > MAX_PORTABLE_CONSTRAINT_VALUE) {
        return fail(`Constraint ${id} has invalid limits`);
      }
      limits = { min: Math.min(min, max), max: Math.max(min, max) };
    }
    const stiffness = Number(constraint.stiffness ?? 0.9);
    if (!Number.isFinite(stiffness) || stiffness < 0 || stiffness > 1) {
      return fail(`Constraint ${id} has invalid stiffness`);
    }
    constraintIds.add(id);
    constraints.push({
      id,
      type: ['point', 'hinge', 'weld'].includes(constraint.type) ? constraint.type : 'point',
      bodyA,
      bodyB,
      ...vectors,
      ...(limits ? { limits } : {}),
      stiffness,
      collideConnected: constraint.collideConnected === true
    });
  }
  runtime.kind = 'entity';
  runtime.constraints = constraints;
  runtime.blockCount = runtime.blocks.length;
  runtime.nodeCount = componentCount;
  return { ok: true, item: runtime };
}

function parseColorset(data: PortableColorSet): InventoryImportResult<InventoryColorSet> {
  if (data?.type !== 'space-colorset' || data?.version !== INVENTORY_PROTOBUF_SCHEMA_VERSION) {
    return fail(`Expected a space-colorset v${INVENTORY_PROTOBUF_SCHEMA_VERSION} Protobuf file`);
  }
  if (typeof data.name !== 'string' || !trimInventoryName(data.name)) return fail('A color set must have a name');
  if (inventoryNameLength(data.name) > MAX_INVENTORY_NAME_LENGTH) {
    return fail(`A color set name may contain at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
  }
  if (!Array.isArray(data.entries) || data.entries.length !== 9) {
    return fail('A color set must contain exactly 9 palette entries');
  }
  const entries = data.entries.map(entry => normalizePaletteEntry(entry, data.name));
  if (entries.some(entry => entry.stops.length < 1 || entry.stops.length > 5
    || entry.stops.some(stop => !HEX_COLOR.test(stop.color)))) {
    return fail('Every palette entry must contain 1 to 5 valid gradient stops');
  }
  return {
    ok: true,
    item: { name: truncateInventoryName(trimInventoryName(data.name)), entries }
  };
}

/** Parse and validate an untrusted Protobuf resource without accessing player or UI state. */
export function parseInventoryImport<K extends InventoryKind>(input: unknown, category: K): InventoryImportResult<InventoryResourceMap[K]>;
export function parseInventoryImport(input: unknown, category: string): InventoryImportResult;
export function parseInventoryImport(input: unknown, category: string): InventoryImportResult {
  const encoded = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : null;
  if (!encoded) return fail('Import data must be a Protobuf binary file');
  if (encoded.byteLength > MAX_INVENTORY_IMPORT_BYTES) {
    return fail(`File exceeds ${MAX_INVENTORY_IMPORT_BYTES / (1024 * 1024)} MiB`);
  }

  let data: PortableResource;
  try {
    const decoded = decodeInventoryResource(encoded);
    if (category === 'item') {
      if (decoded.category === 'colorset') return fail('Expected item, received colorset');
      data = wrapLegacyInventoryResource(decoded.category, decoded.portable);
      if (data.type !== 'space-item') return parseInventoryImport(encoded, decoded.category);
    } else {
      if (decoded.category !== category) return fail(`Expected ${category}, received ${decoded.category}`);
      data = decoded.portable;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Not valid inventory Protobuf');
  }
  switch (data.type) {
    case 'space-item': return parseItem(data);
    case 'space-blockset': return parseBlockset(data);
    case 'space-entity': return parseEntity(data);
    case 'space-colorset': return parseColorset(data);
    default: return fail('Unknown inventory category');
  }
}
