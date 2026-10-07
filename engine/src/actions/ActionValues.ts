import * as THREE from 'three';
import type { Contraption } from '../contraption/Contraption.ts';
import { readRecord } from '../contraption/EntityInput.ts';
import type { RuntimeVoxel } from '../contraption/EntityTypes.ts';
import { DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import { normalizeVoxelMaterialId } from '../voxel/VoxelMaterials.ts';
import type { ActionOutcome, BasicActionContext, EntityTarget } from './ActionContracts.ts';

export function actionResult(action: string, changed: number, reason: string, extra: Partial<ActionOutcome> = {}): ActionOutcome {
  return {
    ok: changed > 0,
    action,
    changed,
    reason,
    ...extra
  };
}

export function finiteCell(value: unknown, boundedY = false) {
  const parts = Array.isArray(value)
    ? value
    : value && [readRecord(value).x, readRecord(value).y, readRecord(value).z];
  if (!Array.isArray(parts) || parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(Number(part)))) {
    return null;
  }
  const cell = {
    x: Math.floor(Number(parts[0]) + 1e-6),
    y: Math.floor(Number(parts[1]) + 1e-6),
    z: Math.floor(Number(parts[2]) + 1e-6)
  };
  if (boundedY && (cell.y < 0 || cell.y >= CHUNK_SIZE_Y)) return null;
  return cell;
}

export function finiteMicro(value: unknown) {
  const parts = Array.isArray(value)
    ? value
    : value && [readRecord(value).x ?? readRecord(value).mx, readRecord(value).y ?? readRecord(value).my, readRecord(value).z ?? readRecord(value).mz];
  if (!Array.isArray(parts) || parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(Number(part)))) {
    return null;
  }
  return {
    x: Math.round(Number(parts[0])),
    y: Math.round(Number(parts[1])),
    z: Math.round(Number(parts[2]))
  };
}

export function resolveColor(value: unknown, fallback = DEFAULT_BLOCK_COLOR) {
  const record = readRecord(value);
  if (Number.isFinite(Number(record.color))) return Number(record.color) & 0xffffff;
  if (record.r !== undefined || record.g !== undefined || record.b !== undefined) {
    return ((Number(record.r) || 0) & 255) << 16
      | ((Number(record.g) || 0) & 255) << 8
      | ((Number(record.b) || 0) & 255);
  }
  if (Number.isFinite(Number(value))) return Number(value) & 0xffffff;
  return fallback;
}

export function blockCell(block: RuntimeVoxel) {
  return {
    x: Math.floor(Number(block.localX) + 1e-6),
    y: Math.floor(Number(block.localY) + 1e-6),
    z: Math.floor(Number(block.localZ) + 1e-6)
  };
}

export function blockInCell(block: RuntimeVoxel, cell: { x: number; y: number; z: number }) {
  const own = blockCell(block);
  return own.x === cell.x && own.y === cell.y && own.z === cell.z;
}

export function entityRootId(contraption: Contraption | null): string {
  const explicit = contraption?.rootComponentId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const structural = [...(contraption?.entityNodes?.values?.() || [])]
    .find(node => node?.parentId === null)?.id;
  return typeof structural === 'string' ? structural : '';
}

export function blockOwnerId(contraption: Contraption, block: RuntimeVoxel): string {
  return String(block?.entityId ?? entityRootId(contraption));
}

export function requestedNodeId(contraption: Contraption | null, ...values: unknown[]): string {
  const selected = values.find(value => value !== undefined && value !== null);
  return String(selected ?? entityRootId(contraption));
}

export function commandMaterialId(options: unknown) {
  return normalizeVoxelMaterialId(readRecord(options).materialId);
}

export function resolveContraption(context: BasicActionContext, target: EntityTarget | null | undefined): Contraption | null {
  if (target?.contraption) return target.contraption;
  if (context?.contraption) return context.contraption;
  const id = target?.entityId ?? target?.id;
  if (id === undefined || id === null) return null;
  return context?.manager?.contraptions?.find((item: Contraption) => (
    String(item.publicId) === String(id) || String(item.id) === String(id)
  )) || null;
}

export function toPoint(value: unknown) {
  const point = readRecord(value);
  const parts = Array.isArray(value) ? value : [point.x, point.y, point.z];
  if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(Number(part)))) return null;
  return new THREE.Vector3(Number(parts[0]), Number(parts[1]), Number(parts[2]));
}
