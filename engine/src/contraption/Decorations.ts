import {
  MAX_BLOCKSET_DECORATIONS, MAX_ENTITY_BOUNDS, MAX_ENTITY_DECORATIONS, MAX_IMPORT_COORDINATE, MAX_TERRAIN_DECORATION_EXTENT,
} from '../constants/SpaceConstants.ts';

export interface DecorationDefinition {
  id: string;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  color: number;
  materialId?: number;
}

const zero = (value: number) => value === 0 ? 0 : value;

/** Closed, validated, idempotent representation shared by storage and runtime. */
export function normalizeDecoration(value: any): DecorationDefinition {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) {
    throw new Error('Decoration id must be a portable identifier.');
  }
  const result: DecorationDefinition = { id: value.id, color: value.color ?? 0 };
  if (!Number.isInteger(result.color) || result.color < 0 || result.color > 0xffffff) {
    throw new Error('Decoration color must be 0xRRGGBB.');
  }
  const materialId = value.materialId ?? 0;
  if (!Number.isInteger(materialId) || materialId < 0 || materialId > 101) throw new Error('Decoration material must be 0, 1, or 2–101.');
  if (materialId) result.materialId = materialId;
  for (const field of ['position', 'scale'] as const) {
    const vector = value[field];
    if (vector === undefined) continue;
    if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) {
      throw new Error(`Decoration ${field} must be a finite 3D vector.`);
    }
    if (field === 'position' && vector.some(component => Math.abs(component) > MAX_IMPORT_COORDINATE)) {
      throw new Error(`Decoration position must be within ±${MAX_IMPORT_COORDINATE}.`);
    }
    if (field === 'scale' && vector.some(component => component <= 0 || component > MAX_ENTITY_BOUNDS)) {
      throw new Error(`Decoration dimensions must be positive and at most ${MAX_ENTITY_BOUNDS}.`);
    }
    const identity = field === 'position' ? 0 : 1;
    if (!vector.every(component => component === identity)) result[field] = vector.map(zero) as [number, number, number];
  }
  if (value.rotation !== undefined) {
    const vector = value.rotation;
    if (!Array.isArray(vector) || vector.length !== 4 || !vector.every(Number.isFinite)) {
      throw new Error('Decoration rotation must be a finite unit quaternion.');
    }
    const lengthSq = vector.reduce((sum, component) => sum + component * component, 0);
    if (Math.abs(lengthSq - 1) > 1e-6) throw new Error('Decoration rotation must be a unit quaternion.');
    const length = Math.abs(lengthSq - 1) > 1e-12 ? Math.sqrt(lengthSq) : 1;
    const sign = [vector[3], vector[0], vector[1], vector[2]].find(component => component !== 0)! < 0 ? -1 : 1;
    const rotation = vector.map(component => zero(component / length * sign)) as [number, number, number, number];
    if (!rotation.every((component, index) => component === (index === 3 ? 1 : 0))) result.rotation = rotation;
  }
  return result;
}

export function normalizeDecorations(values: unknown): DecorationDefinition[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_ENTITY_DECORATIONS) {
    throw new Error(`At most ${MAX_ENTITY_DECORATIONS} decorations are allowed.`);
  }
  const result = values.map(normalizeDecoration);
  const ids = new Set(result.map(value => value.id));
  if (ids.size !== result.length) throw new Error('Decoration ids must be unique within a component.');
  return result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** A closed partial update: omitted fields preserve the previous value. */
export function patchDecoration(id: string, patch: unknown, previous?: DecorationDefinition): DecorationDefinition {
  const fields = new Set(['position', 'rotation', 'scale', 'color', 'materialId']);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.entries(patch).some(([key, value]) => !fields.has(key) || value == null)) {
    throw new Error('Decoration patch contains an unknown or null property.');
  }
  return normalizeDecoration({ ...previous, ...patch, id });
}

export function freezeDecorationSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDecorationSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** Rebase construction coordinates when component voxels/pivots are rebased. */
export function offsetDecorations(values: unknown, offset: number[]): DecorationDefinition[] {
  return normalizeDecorations(values).map(value => normalizeDecoration({
    ...value, position: (value.position || [0, 0, 0]).map((component, axis) => component + offset[axis]),
  }));
}

/**
 * A visual cube bound to one standard 1 m voxel of a BlockSet. `dx/dy/dz` is the
 * anchor cell in BlockSet coordinates; `position` is the cube centre relative to
 * that cell's centre. Like voxels, anchored decorations have positional identity.
 */
export interface AnchoredDecorationDefinition extends Omit<DecorationDefinition, 'id'> {
  dx: number;
  dy: number;
  dz: number;
}

/** A placed terrain decoration: world anchor cell plus an id unique in its chunk. */
export interface TerrainDecorationDefinition extends DecorationDefinition {
  x: number;
  y: number;
  z: number;
}

/** Shared transform validation, with the tighter terrain offset/dimension bound. */
function normalizeAnchoredValue(value: any, id: string): DecorationDefinition {
  const result = normalizeDecoration({ ...value, id });
  if (result.position?.some(component => Math.abs(component) > MAX_TERRAIN_DECORATION_EXTENT)) {
    throw new Error(`Anchored decoration offset must be within ±${MAX_TERRAIN_DECORATION_EXTENT}.`);
  }
  if (result.scale?.some(component => component > MAX_TERRAIN_DECORATION_EXTENT)) {
    throw new Error(`Anchored decoration dimensions must be at most ${MAX_TERRAIN_DECORATION_EXTENT}.`);
  }
  return result;
}

function integerCell(values: unknown[], label: string) {
  if (!values.every(Number.isSafeInteger)) throw new Error(`${label} must be an integer voxel cell.`);
  return values as number[];
}

export function normalizeAnchoredDecoration(value: any): AnchoredDecorationDefinition {
  const [dx, dy, dz] = integerCell([value?.dx, value?.dy, value?.dz], 'Anchored decoration anchor');
  const { id: _id, ...rest } = normalizeAnchoredValue(value, 'anchored');
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy, dz: dz === 0 ? 0 : dz, ...rest };
}

const anchoredSortKey = (value: AnchoredDecorationDefinition) => [
  value.dx, value.dy, value.dz,
  ...(value.position || [0, 0, 0]), ...(value.rotation || [0, 0, 0, 1]), ...(value.scale || [1, 1, 1]),
  value.color, value.materialId || 0,
];

/** Canonical order: anchor, then position, rotation (x,y,z,w), scale, colour and material. */
export function compareAnchoredDecorations(left: AnchoredDecorationDefinition, right: AnchoredDecorationDefinition) {
  const a = anchoredSortKey(left), b = anchoredSortKey(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function normalizeAnchoredDecorations(values: unknown): AnchoredDecorationDefinition[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_BLOCKSET_DECORATIONS) {
    throw new Error(`At most ${MAX_BLOCKSET_DECORATIONS} anchored decorations are allowed.`);
  }
  return values.map(normalizeAnchoredDecoration).sort(compareAnchoredDecorations);
}

/** Validate a terrain decoration; callers wrap x/z onto the torus. */
export function normalizeTerrainDecoration(value: any): TerrainDecorationDefinition {
  const [x, y, z] = integerCell([value?.x, value?.y, value?.z], 'Terrain decoration anchor');
  return { x, y, z, ...normalizeAnchoredValue(value, value?.id) };
}

/** Cube centre in the anchor's coordinate frame (BlockSet or world). */
export function anchoredDecorationCenter(anchor: [number, number, number], position?: [number, number, number]) {
  const offset = position || [0, 0, 0];
  return anchor.map((component, axis) => component + 0.5 + offset[axis]) as [number, number, number];
}
