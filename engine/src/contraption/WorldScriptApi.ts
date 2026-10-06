import { MICRO_DIVISIONS } from '../voxel/MicroGrid.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { ActionDomain, executeBasicAction } from '../actions/BasicActions.ts';
import { ContraptionMode } from './Contraption.ts';
import type { ContraptionManager } from './ContraptionManager.ts';
import { isFiniteVector3Array, isMicroOffset, readRecord } from './EntityInput.ts';

function scriptEditResult(field: 'placed' | 'removed', count: number, reason: string) {
  return Object.freeze({ ok: count > 0, [field]: count, reason });
}

function getWorldVoxelCell(location: unknown) {
  if (!isFiniteVector3Array(location)) return null;
  const cell = {
    x: Math.floor(Number(location[0])),
    y: Math.floor(Number(location[1])),
    z: Math.floor(Number(location[2]))
  };
  return cell.y >= 0 && cell.y < CHUNK_SIZE_Y ? cell : null;
}

export function createWorldScriptCapabilities(manager: ContraptionManager) {
    // World capability exposed to entity programs. V2 separates standard and
    // micro voxels so one namespace never implicitly overwrites the other.
    const worldVoxels = Object.freeze({
      get: (location: unknown) => {
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'get-standard',
          cell: location,
          actor: { source: 'script' }
        });
        return Object.freeze(result);
      },
      set: (location: unknown, options: unknown = null) => {
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'place-standard',
          cell: location,
          options,
          actor: { source: 'script' }
        });
        return scriptEditResult('placed', result.placed || 0, result.reason);
      },
      clear: (location: unknown) => {
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'remove-standard',
          cell: location,
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      paint: (location: unknown, options: unknown = null) => {
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'paint-standard',
          cell: location,
          options,
          actor: { source: 'script' }
        });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      },
      clearCell: (location: unknown) => {
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell: location,
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      subdivide: (location: unknown, clearOffset: unknown = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || (clearOffset !== null && !isMicroOffset(clearOffset))) {
          return Object.freeze({ ok: false, subdivided: 0, removed: 0, reason: 'invalid_position' });
        }
        const micro = clearOffset === null ? null : [
          cell.x * MICRO_DIVISIONS + Number(clearOffset[0]),
          cell.y * MICRO_DIVISIONS + Number(clearOffset[1]),
          cell.z * MICRO_DIVISIONS + Number(clearOffset[2])
        ];
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'subdivide-standard',
          cell,
          micro,
          actor: { source: 'script' }
        });
        return Object.freeze({
          ok: result.ok,
          subdivided: result.subdivided || 0,
          removed: result.removed || 0,
          reason: result.reason
        });
      }
    });
    const worldMicroVoxels = Object.freeze({
      get: (location: unknown, microOffset: unknown) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return Object.freeze({ block: BlockTypes.AIR, color: 0x000000 });
        }
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'get-micro',
          micro: [
            cell.x * MICRO_DIVISIONS + Number(microOffset[0]),
            cell.y * MICRO_DIVISIONS + Number(microOffset[1]),
            cell.z * MICRO_DIVISIONS + Number(microOffset[2])
          ],
          actor: { source: 'script' }
        });
        return Object.freeze(result);
      },
      set: (location: unknown, microOffset: unknown, options: unknown = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return scriptEditResult('placed', 0, 'invalid_position');
        }
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'place-micro',
          micro: [
            cell.x * MICRO_DIVISIONS + Number(microOffset[0]),
            cell.y * MICRO_DIVISIONS + Number(microOffset[1]),
            cell.z * MICRO_DIVISIONS + Number(microOffset[2])
          ],
          options,
          actor: { source: 'script' }
        });
        return scriptEditResult('placed', result.placed || 0, result.reason);
      },
      clear: (location: unknown, microOffset: unknown) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return scriptEditResult('removed', 0, 'invalid_position');
        }
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'remove-micro',
          micro: [
            cell.x * MICRO_DIVISIONS + Number(microOffset[0]),
            cell.y * MICRO_DIVISIONS + Number(microOffset[1]),
            cell.z * MICRO_DIVISIONS + Number(microOffset[2])
          ],
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      paint: (location: unknown, microOffset: unknown, options: unknown = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
        }
        const result = executeBasicAction({ manager, world: manager.world }, {
          domain: ActionDomain.WORLD,
          action: 'paint-micro',
          micro: [
            cell.x * MICRO_DIVISIONS + Number(microOffset[0]),
            cell.y * MICRO_DIVISIONS + Number(microOffset[1]),
            cell.z * MICRO_DIVISIONS + Number(microOffset[2])
          ],
          options,
          actor: { source: 'script' }
        });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      }
    });

    // Backward-compatible callable nearby query plus explicit random-id/chunk methods.
    const list = (chunkId: unknown) => manager.getEntityDescriptorsInChunk(chunkId);
    const worldEntities = Object.assign(
      (origin: unknown, radius = 16) => manager.getNearbyEntityDescriptors(origin, radius),
      { get: (entityId: unknown, chunkId: unknown = null) => manager.getEntityDescriptorById(entityId, chunkId), list, inChunk: list }
    );
    Object.freeze(worldEntities);

    const world = Object.freeze({
      apiVersion: 3,
      getInfo: () => manager.getWorldInfo(),
      voxels: worldVoxels,
      microVoxels: worldMicroVoxels,
      entities: worldEntities,
      raycast: (origin: unknown, direction: unknown, maxDistanceOrOptions: unknown = 24) => {
        if (!Array.isArray(origin) || !Array.isArray(direction)) return null;
        const options = maxDistanceOrOptions && typeof maxDistanceOrOptions === 'object'
          ? readRecord(maxDistanceOrOptions)
          : null;
        const maxDistance = options ? options.maxDistance : maxDistanceOrOptions;
        const include = options?.include === 'all' || options?.include === 'entities'
          ? options.include
          : 'world';
        const voxelKinds = Array.isArray(options?.voxelKinds)
          ? options.voxelKinds.filter(kind => kind === 'standard' || kind === 'micro')
          : ['standard'];
        const space = options?.space === 'bent' ? 'bent' : 'world';
        const query = manager.performBasicAction({
          domain: ActionDomain.QUERY,
          action: 'raycast',
          origin,
          direction,
          maxDistance,
          space,
          include,
          voxelKinds: voxelKinds.length > 0 ? voxelKinds : ['standard'],
          actor: { source: 'script' }
        });
        if (!query?.hit) return null;
        if (query.kind === 'entity') {
          const hit = query.entityHit;
          const point = hit?.point;
          const normal = hit?.worldNormal || hit?.normal;
          return Object.freeze({
            kind: 'entity',
            voxelKind: hit?.kind || null,
            entityId: hit?.contraption?.publicId ?? null,
            runtimeId: hit?.contraption?.id ?? null,
            nodeId: hit?.entityId ?? hit?.entityNode?.id ?? hit?.contraption?.rootComponentId ?? null,
            block: hit?.block?.block ?? BlockTypes.COLOR_BLOCK,
            color: Number(hit?.color) || 0,
            normal: Object.freeze([
              Number(normal?.x) || 0,
              Number(normal?.y) || 0,
              Number(normal?.z) || 0
            ]),
            position: Object.freeze([
              Number(point?.x) || 0,
              Number(point?.y) || 0,
              Number(point?.z) || 0
            ]),
            distance: Number(hit?.distance) || 0
          });
        }
        const hit = query.worldHit;
        if (!hit?.hit) return null;
        return Object.freeze({
          kind: 'world',
          voxelKind: hit.kind || 'standard',
          entityId: null,
          runtimeId: null,
          nodeId: null,
          block: hit.block ?? BlockTypes.COLOR_BLOCK,
          color: Number(hit.color) || 0,
          normal: Object.freeze([hit.normal.x, hit.normal.y, hit.normal.z]),
          position: Object.freeze([hit.hitPos.x, hit.hitPos.y, hit.hitPos.z]),
          distance: hit.distance
        });
      }
    });

    const runSelection = (action: string, extra: Record<string, unknown> = {}) => manager.performBasicAction({
      domain: ActionDomain.SELECTION,
      action,
      actor: { source: 'script' },
      ...extra
    });
    const selection = Object.freeze({
      get: () => Object.freeze(runSelection('get')),
      clear: () => {
        const result = runSelection('clear');
        return Object.freeze({ ok: result.ok, cleared: result.cleared || 0, reason: result.reason });
      },
      cornerA: (point: unknown, options: { micro?: boolean } | null = {}) => {
        const result = runSelection('corner-a', { point, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      cornerB: (point: unknown, options: { micro?: boolean } | null = {}) => {
        const result = runSelection('corner-b', { point, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, clamped: !!result.clamped, reason: result.reason });
      },
      box: (cornerA: unknown, cornerB: unknown, options: { micro?: boolean } | null = {}) => {
        const result = runSelection('box', { cornerA, cornerB, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, clamped: !!result.clamped, reason: result.reason });
      },
      cells: (cells: unknown) => {
        const result = runSelection('cells', { cells });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      toggle: (point: unknown, options: { micro?: boolean } | null = {}) => {
        const result = runSelection('toggle-cell', { point, micro: options?.micro === true });
        return Object.freeze({
          ok: result.ok,
          selected: result.selection?.count || 0,
          reason: result.reason
        });
      },
      entity: (entityId: unknown, nodeId: unknown = null) => {
        const result = runSelection('entity-subtree', { entityId, nodeId });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      entityBox: (entityId: unknown, nodeId: unknown, cornerA: unknown, cornerB: unknown, space = 'node-local', options: { micro?: boolean } | null = {}) => {
        const result = runSelection('entity-box', {
          entityId,
          nodeId,
          a: cornerA,
          b: cornerB,
          space,
          micro: options?.micro === true
        });
        return Object.freeze({
          ok: result.ok,
          selected: result.selected || 0,
          components: Object.freeze([...(result.components || [])]),
          reason: result.reason
        });
      },
      delete: () => {
        const result = runSelection('delete');
        return Object.freeze({
          ok: result.ok,
          removed: result.removed || 0,
          standard: result.standard || 0,
          micro: result.micro || 0,
          entities: result.entities || 0,
          components: result.components || 0,
          entityId: result.entityId ?? null,
          nodeId: result.nodeId ?? null,
          reason: result.reason
        });
      },
      paint: (options: unknown = null) => {
        const result = runSelection('paint', { options });
        return Object.freeze({
          ok: result.ok,
          painted: result.painted || 0,
          standard: result.standard || 0,
          micro: result.micro || 0,
          reason: result.reason
        });
      },
      fill: (options: unknown = null) => {
        const result = runSelection('fill', { options });
        return Object.freeze({
          ok: result.ok,
          placed: result.placed || 0,
          standard: result.standard || 0,
          micro: result.micro || 0,
          reason: result.reason
        });
      },
      assemble: (mode = ContraptionMode.PROGRAMMABLE, options = {}) => {
        const result = runSelection('assemble', { mode, options });
        return Object.freeze({
          ok: result.ok,
          assembled: result.assembled || 0,
          entityId: result.entityId ?? null,
          runtimeId: result.runtimeId ?? null,
          reason: result.reason
        });
      },
      createChild: (id: unknown = null) => {
        const result = runSelection('create-child', { id });
        return Object.freeze({ ok: result.ok, childId: result.childId ?? null, reason: result.reason });
      }
    });
    return { world, selection };
}
