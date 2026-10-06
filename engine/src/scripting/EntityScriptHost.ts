import type { ScriptCommand, ScriptSnapshot, ScriptComponentSnapshot } from './ScriptProtocol.ts';
import type { DecorationDefinition } from '../contraption/Decorations.ts';
import { readRecord } from '../contraption/EntityInput.ts';
import { normalizeDecorations, patchDecoration } from '../contraption/Decorations.ts';
import { MAX_ENTITY_DECORATIONS } from '../constants/SpaceConstants.ts';
// Trusted host API. Guest programs only reach this through the bounded WASM handle bridge.
export function createEntityScriptHost(hostWorldReadCall: (kind: string, position: unknown, offset: unknown) => unknown, hostRaycastCall: (origin: unknown, direction: unknown, options: unknown) => unknown) {
  let states: Record<string, unknown> = Object.create(null);
  let frame: ScriptSnapshot = {};
  let rootComponentId = '';
  let componentMap = new Map<string, ScriptComponentSnapshot>();
  let selfCache = new Map<string, ScriptSelf>();
  let commands: ScriptCommand[] = [];
  let nextCommandId = 1;
  let rootMessages: ReturnType<typeof prepareEntityMessages> = Object.freeze([]);
  let errors: Array<{ nodeId?: string; error?: string }> = [];
  let stopped = false;
  let worldVoxelOverlays = new Map<string, Record<string, unknown>>();
  let worldMicroVoxelOverlays = new Map<string, Record<string, unknown>>();
  let decorationOverlays = new Map<string, DecorationDefinition[]>();
  const STOP = Object.freeze({ kind: 'space-stop' });
  const MAX_COMMANDS = 256;
  const MAX_BODY_VECTOR_COMPONENT = 1e12;

  const clone = <T>(value: T): T | null | undefined => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)) as T; } catch (_) { return null; }
  };
  const harden = <T>(value: T): T => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) harden(child);
    return Object.freeze(value);
  };
  const frozenClone = <T>(value: T) => harden(clone(value));
  const collectFrozenPaths = (value: unknown, path: string[] = [], result: string[][] = []): string[][] => {
    if (!value || typeof value !== 'object') return result;
    if (Object.isFrozen(value)) result.push(path);
    for (const [key, child] of Object.entries(value)) collectFrozenPaths(child, [...path, key], result);
    return result;
  };
  const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const utf8ByteLength = (value: unknown) => {
    const text = String(value);
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    }
    return bytes;
  };
  const vector = (value: unknown) => Array.isArray(value)
    ? [finite(value[0]), finite(value[1]), finite(value[2])]
    : [0, 0, 0];
  const boundedBodyVector = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 3) return null;
    const result = value.slice(0, 3).map(Number);
    return result.every(component => Number.isFinite(component)
      && Math.abs(component) <= MAX_BODY_VECTOR_COMPONENT) ? result : null;
  };
  const emit = (scope: string, nodeId: unknown, path: string, args: unknown[]) => {
    if (commands.length >= MAX_COMMANDS) return null;
    const commandId = 'cmd-' + nextCommandId++;
    commands.push({
      commandId,
      scope,
      nodeId: nodeId === null || nodeId === undefined ? null : String(nodeId),
      path,
      args: clone(args) || []
    });
    return commandId;
  };
  const queuedEdit = (field: string, commandId: string | null, amount: unknown = 1) => Object.freeze({
    ok: !!commandId,
    [field]: commandId ? amount : 0,
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const queuedResult = <T extends object, R extends object = Record<string, never>>(commandId: string | null, values: T, rejectedValues: R = {} as R) => Object.freeze({
    ok: !!commandId,
    ...(commandId ? values : rejectedValues),
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const inputCode = (value: unknown) => {
    if (typeof value !== 'string') return '';
    const clean = value.trim();
    const aliases: Record<string, string> = { shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt' };
    const alias = aliases[clean.toLowerCase()];
    return alias || clean;
  };
  const codeActive = (list: readonly string[], requested: unknown) => {
    const code = inputCode(requested);
    if (!code) return false;
    if (code === 'Shift') return list.includes('ShiftLeft') || list.includes('ShiftRight');
    if (code === 'Control') return list.includes('ControlLeft') || list.includes('ControlRight');
    if (code === 'Alt') return list.includes('AltLeft') || list.includes('AltRight');
    return list.includes(code);
  };
  const rotateVector = (direction: unknown, quaternion: unknown) => {
    const v = vector(direction);
    const q = Array.isArray(quaternion) ? quaternion.map(finite) : [0, 0, 0, 1];
    const x = v[0], y = v[1], z = v[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return Object.freeze([
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx
    ]);
  };

  function makeVoxelApi(nodeId: string, micro: boolean) {
    const prefix = micro ? 'microVoxels.' : 'voxels.';
    const api = {
      set(...args: unknown[]) { return queuedEdit('placed', emit('component', nodeId, prefix + 'set', args)); },
      clear(...args: unknown[]) { return queuedEdit('removed', emit('component', nodeId, prefix + 'clear', args)); },
      paint(...args: unknown[]) {
        return queuedEdit('painted', emit('component', nodeId, prefix + 'paint', args));
      }
    };
    const standard = !micro ? {
      clearCell: (...args: unknown[]) => queuedEdit('removed', emit('component', nodeId, 'voxels.clearCell', args)),
      subdivide: (...args: unknown[]) => {
        const accepted = emit('component', nodeId, 'voxels.subdivide', args);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      }
    } : {};
    return Object.freeze({ ...api, ...standard });
  }

  interface ScriptSelf extends ReturnType<typeof buildSelfSurface> {
    child(childId: unknown): ScriptSelf | null;
    children(): readonly ScriptSelf[];
  }
  function getSelf(nodeId: unknown): ScriptSelf | null {
    const id = String(nodeId || rootComponentId);
    if (selfCache.has(id)) return selfCache.get(id)!;
    const node = componentMap.get(id);
    if (!node) return null;
    if (!states[id] || typeof states[id] !== 'object' || Array.isArray(states[id])) states[id] = {};
    const api = Object.freeze({
      ...buildSelfSurface(id, node),
      child: (childId: unknown) => {
        const target = String(childId || '');
        return (node.children || []).includes(target) ? getSelf(target) : null;
      },
      children: () => Object.freeze((node.children || []).map(getSelf).filter((child): child is ScriptSelf => child !== null))
    });
    selfCache.set(id, api);
    return api;
  }
  function buildSelfSurface(id: string, node: ScriptComponentSnapshot) {
    const isRoot = node.parentId === null || node.parentId === undefined;
    const api = {
      apiVersion: 3,
      id,
      parentId: node.parentId ?? null,
      state: states[id],
      applyThrust: (force: unknown) => { emit('component', id, 'applyThrust', [force]); },
      applyLocalThrust: (force: unknown) => { emit('component', id, 'applyLocalThrust', [force]); },
      getWorldPosition: () => frozenClone(node.worldPosition || [0, 0, 0]),
      getWorldRotation: () => frozenClone(node.worldRotation || [0, 0, 0, 1]),
      getPivot: () => frozenClone(node.pivot || [0, 0, 0]),
      localToWorldDirection: (direction: unknown) => rotateVector(direction, node.worldRotation),
      getBounds: () => frozenClone(node.bounds),
      setLocalPosition: (value: unknown) => { emit('component', id, 'setLocalPosition', [value]); },
      setLocalRotation: (value: unknown) => { emit('component', id, 'setLocalRotation', [value]); },
      setLocalEuler: (value: unknown) => { emit('component', id, 'setLocalEuler', [value]); },
      setLocalSpin: (axis: unknown, rpm: unknown) => { emit('component', id, 'setLocalSpin', [axis, rpm]); },
      getLocalPosition: () => frozenClone(node.localPosition || [0, 0, 0]),
      getLocalRotation: () => frozenClone(node.localRotation || [0, 0, 0, 1]),
      setPivot: (value: unknown) => { emit('component', id, 'setPivot', [value]); },
      applyForce: (force: unknown) => { emit('component', id, 'applyForce', [force]); },
      applyLocalForce: (force: unknown) => { emit('component', id, 'applyLocalForce', [force]); },
      applyForceAt: (force: unknown, point: unknown) => { emit('component', id, 'applyForceAt', [force, point]); },
      applyTorque: (torque: unknown) => { emit('component', id, 'applyTorque', [torque]); },
      setSeats: (values: unknown) => { emit('component', id, 'setSeats', [values]); },
      getSeats: () => frozenClone(node.seats || []),
      stop: () => {
        if (!isRoot) return undefined;
        emit('control', id, 'stop', []);
        stopped = true;
        throw STOP;
      },

    };
    let bodyType = node.body?.type || 'dynamic';
    let bodyMass = finite(node.body?.mass);
    let bodyMaterial = frozenClone(node.body?.material || { restitution: 0.1, friction: 0.7 });
    let gravityEnabled = node.body?.useGravity !== false;
    let collisionEnabled = node.body?.collisionEnabled !== false;
    const body = Object.freeze({
      getType: () => bodyType,
      setType: (type: unknown) => {
        if (type !== 'dynamic' && type !== 'kinematic') {
          return Object.freeze({ ok: false, type: bodyType, reason: 'invalid_body_type' });
        }
        const accepted = emit('component', id, 'body.setType', [type]);
        if (accepted) bodyType = type;
        return queuedResult(accepted, { type }, { type: bodyType });
      },
      getMass: () => bodyMass,
      setMass: (mass: unknown) => {
        const requestedMass = Number(mass);
        if (!Number.isFinite(requestedMass) || requestedMass <= 0) {
          return Object.freeze({ ok: false, mass: bodyMass, reason: 'invalid_mass' });
        }
        const safeMass = Math.max(0.1, requestedMass);
        const accepted = emit('component', id, 'body.setMass', [safeMass]);
        if (accepted) bodyMass = safeMass;
        return queuedResult(accepted, { mass: safeMass }, { mass: bodyMass });
      },
      getMaterial: () => bodyMaterial,
      setMaterial: (material: unknown) => {
        const nextMaterial = frozenClone(material);
        const accepted = emit('component', id, 'body.setMaterial', [material]);
        if (accepted) bodyMaterial = nextMaterial;
        return queuedResult(accepted, { material: nextMaterial }, { material: bodyMaterial });
      },
      getGravityEnabled: () => gravityEnabled,
      setGravityEnabled: (enabled: unknown) => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: gravityEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setGravityEnabled', [enabled]);
        if (accepted) gravityEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: gravityEnabled });
      },
      getCollisionEnabled: () => collisionEnabled,
      setCollisionEnabled: (enabled: unknown) => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: collisionEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setCollisionEnabled', [enabled]);
        if (accepted) collisionEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: collisionEnabled });
      },
      getVelocity: () => frozenClone(node.body?.velocity || [0, 0, 0]),
      getAngularVelocity: () => frozenClone(node.body?.angularVelocity || [0, 0, 0]),
      applyForce: (force: unknown) => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyForce', [safeForce])
          : false;
      },
      applyLocalForce: (force: unknown) => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyLocalForce', [safeForce])
          : false;
      },
      applyTorque: (torque: unknown) => {
        const safeTorque = boundedBodyVector(torque);
        return bodyType === 'dynamic' && !!safeTorque
          ? !!emit('component', id, 'body.applyTorque', [safeTorque])
          : false;
      }
    });
    const constraints = Object.freeze({
      all: () => frozenClone(node.constraints || []),
      create: (options: unknown) => {
        const accepted = emit('component', id, 'constraints.create', [options]);
        return queuedResult(accepted, { id: null }, { id: null });
      },
      remove: (constraintId: unknown) => !!emit('component', id, 'constraints.remove', [constraintId])
    });
    const decorations = () => decorationOverlays.get(id) || node.decorations || [];
    const decorationApi = Object.freeze({
      all: () => frozenClone(decorations()),
      get: (decorationId: string) => frozenClone(decorations().find(value => value.id === decorationId) || null),
      upsert: (decorationId: string, patch: unknown) => {
        const values = decorations();
        const previous = values.find(value => value.id === decorationId);
        let next;
        try { next = patchDecoration(decorationId, patch, previous); }
        catch { return Object.freeze({ ok: false, reason: 'invalid_decoration' }); }
        let count = 0;
        for (const [componentId, component] of componentMap) {
          count += (decorationOverlays.get(componentId) || component.decorations || []).length;
        }
        if (!previous && count >= MAX_ENTITY_DECORATIONS) return Object.freeze({ ok: false, reason: 'too_many_decorations' });
        const accepted = emit('component', id, 'decorations.upsert', [decorationId, patch]);
        if (accepted) decorationOverlays.set(id, normalizeDecorations([...values.filter(value => value.id !== decorationId), next]));
        return queuedResult(accepted, { id: decorationId });
      },
      remove: (decorationId: string) => {
        const values = decorations();
        if (!values.some(value => value.id === decorationId)) return Object.freeze({ ok: false, reason: 'decoration_not_found' });
        const accepted = emit('component', id, 'decorations.remove', [decorationId]);
        if (accepted) decorationOverlays.set(id, values.filter(value => value.id !== decorationId));
        return queuedResult(accepted, { id: decorationId });
      }
    });
    const voxels = makeVoxelApi(id, false);
    const microVoxels = makeVoxelApi(id, true);
    return Object.freeze({ ...api, body, constraints, decorations: decorationApi, voxels, microVoxels });
  }

  function makeWorldApi() {
    const nearby = Array.isArray(frame.world?.entities) ? frame.world.entities : [];
    const positionKey = (value: unknown) => Array.isArray(value) ? value.slice(0, 3).map(v => Math.floor(finite(v))).join(',') : '';
    const microPositionKey = (cell: unknown, offset: unknown) => positionKey(cell) + '|' + (Array.isArray(offset)
      ? offset.slice(0, 3).map(v => Math.round(finite(v))).join(',')
      : '');
    const hostWorldRead = (kind: string, position: unknown, offset: unknown = null): Record<string, unknown> => {
      try {
        const encoded = hostWorldReadCall(kind, position, offset);
        return typeof encoded === 'string'
          ? readRecord(frozenClone(JSON.parse(encoded) as unknown))
          : Object.freeze({ block: 0, color: 0, materialId: 0 });
      } catch (_) {
        return Object.freeze({ block: 0, color: 0, materialId: 0 });
      }
    };
    const voxels = Object.freeze({
      get(position: unknown) {
        const key = positionKey(position);
        return worldVoxelOverlays.has(key)
          ? frozenClone(worldVoxelOverlays.get(key)) || {}
          : hostWorldRead('standard', position);
      },
      set(position: unknown, options: unknown) {
        const accepted = emit('world', null, 'voxels.set', [position, options]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), {
          block: 1,
          color: finite(readRecord(options).color),
          materialId: finite(readRecord(options).materialId) === 1 ? 1 : 0,
        });
        return queuedEdit('placed', accepted);
      },
      clear(position: unknown) {
        const accepted = emit('world', null, 'voxels.clear', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0, materialId: 0 });
        return queuedEdit('removed', accepted);
      },
      paint(position: unknown, options: unknown) {
        const accepted = emit('world', null, 'voxels.paint', [position, options]);
        if (accepted) {
          const current = voxels.get(position);
          if (current?.block) worldVoxelOverlays.set(positionKey(position), {
            ...current,
            color: finite(readRecord(options).color),
            materialId: readRecord(options).materialId === undefined
              ? finite(current.materialId)
              : (finite(readRecord(options).materialId) === 1 ? 1 : 0),
          });
        }
        return queuedEdit('painted', accepted);
      },
      clearCell(position: unknown) {
        const accepted = emit('world', null, 'voxels.clearCell', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0, materialId: 0 });
        return queuedEdit('removed', accepted);
      },
      subdivide(position: unknown, offset: unknown) {
        const accepted = emit('world', null, 'voxels.subdivide', [position, offset]);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      }
    });
    const microVoxels = Object.freeze({
      get(cell: unknown, offset: unknown) {
        const key = microPositionKey(cell, offset);
        return worldMicroVoxelOverlays.has(key)
          ? frozenClone(worldMicroVoxelOverlays.get(key)) || {}
          : hostWorldRead('micro', cell, offset);
      },
      set(cell: unknown, offset: unknown, options: unknown) {
        const accepted = emit('world', null, 'microVoxels.set', [cell, offset, options]);
        if (accepted) worldMicroVoxelOverlays.set(
          microPositionKey(cell, offset),
          { block: 1, color: finite(readRecord(options).color), materialId: finite(readRecord(options).materialId) === 1 ? 1 : 0 }
        );
        return queuedEdit('placed', accepted);
      },
      clear(cell: unknown, offset: unknown) {
        const accepted = emit('world', null, 'microVoxels.clear', [cell, offset]);
        if (accepted) worldMicroVoxelOverlays.set(
          microPositionKey(cell, offset),
          { block: 0, color: 0, materialId: 0 },
        );
        return queuedEdit('removed', accepted);
      },
      paint(cell: unknown, offset: unknown, options: unknown) {
        const accepted = emit('world', null, 'microVoxels.paint', [cell, offset, options]);
        if (accepted) {
          const current = microVoxels.get(cell, offset);
          if (current?.block) worldMicroVoxelOverlays.set(
            microPositionKey(cell, offset),
            {
              ...current,
              color: finite(readRecord(options).color),
              materialId: readRecord(options).materialId === undefined
                ? finite(current.materialId)
                : (finite(readRecord(options).materialId) === 1 ? 1 : 0),
            }
          );
        }
        return queuedEdit('painted', accepted);
      }
    });
    const worldSize = Array.isArray(frame.world?.size) ? frame.world.size : [0, 0];
    const wrappedDelta = (a: unknown, b: unknown, period: unknown) => {
      const direct = Math.abs(finite(a) - finite(b));
      const size = finite(period);
      if (size <= 0) return direct;
      const normalized = direct % size;
      return Math.min(normalized, size - normalized);
    };
    const distanceFrom = (item: Record<string, unknown>, origin: number[]) => {
      const position = Array.isArray(item?.position) ? item.position : [0, 0, 0];
      const dx = wrappedDelta(position[0], origin[0], worldSize[0]);
      const dy = finite(position[1]) - origin[1];
      const dz = wrappedDelta(position[2], origin[2], worldSize[1]);
      return Math.hypot(dx, dy, dz);
    };
    const entities = (origin: unknown, radius: number = 16) => {
      const queryOrigin = Array.isArray(origin) ? vector(origin) : vector(frame.position);
      const limit = Math.max(0, finite(radius));
      return Object.freeze(nearby
        .map(item => ({ item, distance: distanceFrom(item, queryOrigin) }))
        .filter(entry => entry.distance <= limit)
        .sort((a, b) => a.distance - b.distance)
        .map(entry => frozenClone({ ...entry.item, distance: entry.distance })));
    };
    entities.get = (entityId: unknown) => frozenClone(
      nearby.find(item => item.id === String(entityId) || item.runtimeId === entityId) || null
    );
    entities.list = (chunkId: unknown) => Object.freeze(nearby.filter(item => item.chunkId === String(chunkId)).map(frozenClone));
    entities.inChunk = entities.list;
    Object.freeze(entities);
    return Object.freeze({
      apiVersion: 3,
      getInfo: () => frozenClone(frame.world?.info || null),
      voxels,
      microVoxels,
      entities,
      raycast: (origin: unknown, direction: unknown, maxDistanceOrOptions: unknown = 24) => {
        try {
          const encoded = hostRaycastCall(origin, direction, maxDistanceOrOptions);
          return typeof encoded === 'string' ? frozenClone(JSON.parse(encoded)) : null;
        } catch (_) {
          return null;
        }
      }
    });
  }

  function makeSelectionApi() {
    let current = clone(frame.selection) || { kind: 'none', count: 0 };
    const run = (path: string, args: unknown[], next?: Record<string, unknown>) => {
      const accepted = emit('selection', null, path, args);
      if (accepted && next) current = next;
      return queuedEdit('selected', accepted, Number(current.count) || 0);
    };
    return Object.freeze({
      get: () => frozenClone(current),
      clear: () => {
        const accepted = emit('selection', null, 'clear', []);
        const count = Number(current.count) || 0;
        if (accepted) current = { kind: 'none', count: 0 };
        return queuedEdit('cleared', accepted, count);
      },
      cornerA: (...args: unknown[]) => run('cornerA', args),
      cornerB: (...args: unknown[]) => run('cornerB', args),
      box: (...args: unknown[]) => run('box', args),
      cells: (cells: unknown) => run('cells', [cells], { kind: 'world-cells', count: Array.isArray(cells) ? cells.length : 0 }),
      toggle: (...args: unknown[]) => run('toggle', args),
      entity: (entityId: unknown, nodeId: unknown = null) => run('entity', [entityId, nodeId], { kind: 'entity-subtree', entityId, nodeId, count: 1 }),
      entityBox: (...args: unknown[]) => run('entityBox', args),
      delete: () => {
        const accepted = emit('selection', null, 'delete', []);
        const removed = Number(current.count) || 0;
        return queuedResult(
          accepted,
          { removed, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null },
          { removed: 0, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null }
        );
      },
      assemble: (...args: unknown[]) => {
        const accepted = emit('selection', null, 'assemble', args);
        return queuedResult(
          accepted,
          { assembled: 1, entityId: null, runtimeId: null },
          { assembled: 0, entityId: null, runtimeId: null }
        );
      },
      createChild: (...args: unknown[]) => {
        const accepted = emit('selection', null, 'createChild', args);
        return queuedResult(accepted, { childId: null }, { childId: null });
      }
    });
  }

  function makeCommandResultsApi() {
    const results = Array.isArray(frame.commandResults) ? frame.commandResults : [];
    return Object.freeze({
      get: (commandId: unknown) => frozenClone(
        results.find(result => result?.commandId === String(commandId)) || null
      ),
      all: () => frozenClone(results)
    });
  }

  function prepareEntityMessages(entries: unknown) {
    if (!Array.isArray(entries)) return Object.freeze([]);
    const messages = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const encoding = entry.encoding;
      const payload = encoding === 'utf8'
        ? String(entry.payload ?? '')
        : (Array.isArray(entry.payload) ? Object.freeze(entry.payload) : Object.freeze([]));
      messages.push(Object.freeze({
        messageId: String(entry.messageId || ''),
        sourceId: String(entry.sourceId || ''),
        targetId: String(entry.targetId || ''),
        type: String(entry.type || ''),
        encoding,
        payload
      }));
    }
    return Object.freeze(messages);
  }

  function makeEntityMessagesApi(nodeId: string) {
    const reject = (reason: unknown) => Object.freeze({ ok: false, queued: 0, reason, commandId: null });
    return Object.freeze({
      received: nodeId === rootComponentId ? rootMessages : Object.freeze([]),
      send: (targetId: unknown, messageType: unknown, payload: unknown, encoding: string = 'utf8') => {
        if (typeof targetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
          return reject('invalid_target_id');
        }
        if (typeof messageType !== 'string' || !/^[a-z][a-z0-9._-]{0,15}$/.test(messageType)) {
          return reject('invalid_message_type');
        }
        if (encoding !== 'utf8' && encoding !== 'protobuf') {
          return reject('invalid_encoding');
        }
        if (messageType === 'chat' && encoding !== 'utf8') {
          return reject('chat_requires_utf8');
        }
        if (encoding === 'protobuf' && !/\.v[1-9][0-9]*$/.test(messageType)) {
          return reject('protobuf_type_requires_version');
        }

        let normalizedPayload;
        if (encoding === 'utf8') {
          if (typeof payload !== 'string') {
            return reject('invalid_payload');
          }
          if (utf8ByteLength(payload) > 4096) {
            return reject('payload_too_large');
          }
          normalizedPayload = payload;
        } else {
          const bytes = Array.isArray(payload)
            ? payload
            : (typeof Uint8Array !== 'undefined' && payload instanceof Uint8Array ? Array.from(payload) : null);
          if (!bytes || bytes.length > 4096
            || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
            return reject('invalid_payload');
          }
          normalizedPayload = Array.from(bytes);
        }

        const commandId = emit('messages', nodeId, 'send', [targetId.toLowerCase(), messageType, normalizedPayload, encoding]);
        return queuedResult(commandId, { queued: 1 }, { queued: 0 });
      }
    });
  }

  const beginTick = (snapshot: ScriptSnapshot) => {
    frame = snapshot;
    states = clone(frame.states) || Object.create(null);
    componentMap = new Map((frame.components || []).map(node => [String(node.id), node]));
    rootComponentId = String(
      frame.rootComponentId
      || (frame.components || []).find(node => node.parentId === null)?.id
      || ''
    );
    nextCommandId = Math.max(
      nextCommandId,
      Math.max(0, Math.floor(finite(frame.commandSequence))) + 1
    );
    rootMessages = prepareEntityMessages(frame.messages);
    selfCache = new Map();
    decorationOverlays = new Map();
    commands = [];
    errors = [];
    stopped = false;
    worldVoxelOverlays = new Map();
    worldMicroVoxelOverlays = new Map();
    return true;
  };


  const context = (nodeId: string) => {
    const input = frame.input || { down: [], pressed: [], released: [] };
    const blocks = frame.blocks || {};
    const ctx = Object.freeze({
      apiVersion: 3,
      entityId: String(frame.entityId || ''),
      time: finite(frame.time),
      deltaTime: finite(frame.deltaTime),
      tick: finite(frame.tick),
      position: frozenClone(frame.position || [0, 0, 0]),
      velocity: frozenClone(frame.velocity || [0, 0, 0]),
      rotation: frozenClone(frame.rotation || [0, 0, 0]),
      angularVelocity: frozenClone(frame.angularVelocity || [0, 0, 0]),
      groundDistance: finite(frame.groundDistance),
      isOnGround: frame.isOnGround === true,
      mass: finite(frame.mass),
      bodyType: frame.bodyType || 'dynamic',
      gravity: frozenClone(frame.gravity || [0, -18, 0]),
      limits: frozenClone(frame.limits || { maxForce: 0, maxTorque: 0 }),
      root: getSelf(rootComponentId),
      blocks: Object.freeze({
        pressed: (type: unknown) => !!blocks.changed && (type === undefined || type === null || blocks.event?.type === type),
        event: () => frozenClone(blocks.event || null)
      }),
      input: Object.freeze({
        down: (code: unknown) => codeActive(input.down || [], code),
        pressed: (code: unknown) => codeActive(input.pressed || [], code),
        released: (code: unknown) => codeActive(input.released || [], code)
      }),
      players: frozenClone(frame.players || []),
      driver: frozenClone(frame.driver || null),
      contacts: frozenClone(frame.contacts || []),
      messages: makeEntityMessagesApi(nodeId),
      world: makeWorldApi(),
      selection: makeSelectionApi(),
      commands: makeCommandResultsApi(),
      log: (message: unknown) => { emit('log', nodeId, 'log', [String(message).slice(0, 1000)]); }
    });
    return ctx;
  };
  return {
    beginTick, getSelf, context,
    shouldStop: () => stopped,
    isStop: (error: unknown) => error === STOP,
    finish: () => ({ ok: true, commands, errors, states: clone(states) || {}, frozenStatePaths: collectFrozenPaths(states), stopped })
  };
}
