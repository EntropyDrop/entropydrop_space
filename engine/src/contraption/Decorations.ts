import { MAX_ENTITY_BOUNDS, MAX_ENTITY_DECORATIONS, MAX_IMPORT_COORDINATE } from '../constants/SpaceConstants.ts';

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
  if (materialId !== 0 && materialId !== 1) throw new Error('Decoration material must be 0 or 1.');
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
