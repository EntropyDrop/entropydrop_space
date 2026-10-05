// @ts-nocheck
import { normalizeDecorations, patchDecoration } from '../contraption/Decorations.ts';
import { MAX_ENTITY_DECORATIONS } from '../constants/SpaceConstants.ts';
// Trusted host API. Guest programs only reach this through the bounded WASM handle bridge.
export function createEntityScriptHost(hostWorldReadCall, hostRaycastCall) {
  let states = Object.create(null);
  let frame = null;
  let rootComponentId = '';
  let componentMap = new Map();
  let selfCache = new Map();
  let commands = [];
  let nextCommandId = 1;
  let rootMessages = Object.freeze([]);
  let errors = [];
  let stopped = false;
  let worldVoxelOverlays = new Map();
  let worldMicroVoxelOverlays = new Map();
  let decorationOverlays = new Map();
  const STOP = Object.freeze({ kind: 'space-stop' });
  const MAX_COMMANDS = 256;
  const MAX_BODY_VECTOR_COMPONENT = 1e12;

  const clone = value => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  };
  const harden = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) harden(value[key]);
    return Object.freeze(value);
  };
  const frozenClone = value => harden(clone(value));
  const collectFrozenPaths = (value, path = [], result = []) => {
    if (!value || typeof value !== 'object') return result;
    if (Object.isFrozen(value)) result.push(path);
    for (const key of Object.keys(value)) collectFrozenPaths(value[key], [...path, key], result);
    return result;
  };
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const utf8ByteLength = value => {
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
  const vector = value => Array.isArray(value)
    ? [finite(value[0]), finite(value[1]), finite(value[2])]
    : [0, 0, 0];
  const boundedBodyVector = value => {
    if (!Array.isArray(value) || value.length < 3) return null;
    const result = value.slice(0, 3).map(Number);
    return result.every(component => Number.isFinite(component)
      && Math.abs(component) <= MAX_BODY_VECTOR_COMPONENT) ? result : null;
  };
  const emit = (scope, nodeId, path, args) => {
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
  const queuedEdit = (field, commandId, amount = 1) => Object.freeze({
    ok: !!commandId,
    [field]: commandId ? amount : 0,
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const queuedResult = (commandId, values, rejectedValues = {}) => Object.freeze({
    ok: !!commandId,
    ...(commandId ? values : rejectedValues),
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const inputCode = value => {
    if (typeof value !== 'string') return '';
    const clean = value.trim();
    const alias = { shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt' }[clean.toLowerCase()];
    return alias || clean;
  };
  const codeActive = (list, requested) => {
    const code = inputCode(requested);
    if (!code) return false;
    if (code === 'Shift') return list.includes('ShiftLeft') || list.includes('ShiftRight');
    if (code === 'Control') return list.includes('ControlLeft') || list.includes('ControlRight');
    if (code === 'Alt') return list.includes('AltLeft') || list.includes('AltRight');
    return list.includes(code);
  };
  const rotateVector = (direction, quaternion) => {
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

  function makeVoxelApi(nodeId, micro) {
    const prefix = micro ? 'microVoxels.' : 'voxels.';
    const api = {
      set(...args) { return queuedEdit('placed', emit('component', nodeId, prefix + 'set', args)); },
      clear(...args) { return queuedEdit('removed', emit('component', nodeId, prefix + 'clear', args)); },
      paint(...args) {
        return queuedEdit('painted', emit('component', nodeId, prefix + 'paint', args));
      }
    };
    if (!micro) {
      api.clearCell = (...args) => queuedEdit('removed', emit('component', nodeId, 'voxels.clearCell', args));
      api.subdivide = (...args) => {
        const accepted = emit('component', nodeId, 'voxels.subdivide', args);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      };
    }
    return Object.freeze(api);
  }

  function getSelf(nodeId) {
    const id = String(nodeId || rootComponentId);
    if (selfCache.has(id)) return selfCache.get(id);
    const node = componentMap.get(id);
    if (!node) return null;
    if (!states[id] || typeof states[id] !== 'object' || Array.isArray(states[id])) states[id] = {};
    const isRoot = node.parentId === null || node.parentId === undefined;
    const api = {
      apiVersion: 3,
      id,
      parentId: node.parentId ?? null,
      state: states[id],
      applyThrust: force => { emit('component', id, 'applyThrust', [force]); },
      applyLocalThrust: force => { emit('component', id, 'applyLocalThrust', [force]); },
      getWorldPosition: () => frozenClone(node.worldPosition || [0, 0, 0]),
      getWorldRotation: () => frozenClone(node.worldRotation || [0, 0, 0, 1]),
      getPivot: () => frozenClone(node.pivot || [0, 0, 0]),
      localToWorldDirection: direction => rotateVector(direction, node.worldRotation),
      getBounds: () => frozenClone(node.bounds),
      setLocalPosition: value => { emit('component', id, 'setLocalPosition', [value]); },
      setLocalRotation: value => { emit('component', id, 'setLocalRotation', [value]); },
      setLocalEuler: value => { emit('component', id, 'setLocalEuler', [value]); },
      setLocalSpin: (axis, rpm) => { emit('component', id, 'setLocalSpin', [axis, rpm]); },
      getLocalPosition: () => frozenClone(node.localPosition || [0, 0, 0]),
      getLocalRotation: () => frozenClone(node.localRotation || [0, 0, 0, 1]),
      setPivot: value => { emit('component', id, 'setPivot', [value]); },
      applyForce: force => { emit('component', id, 'applyForce', [force]); },
      applyLocalForce: force => { emit('component', id, 'applyLocalForce', [force]); },
      applyForceAt: (force, point) => { emit('component', id, 'applyForceAt', [force, point]); },
      applyTorque: torque => { emit('component', id, 'applyTorque', [torque]); },
      setSeats: values => { emit('component', id, 'setSeats', [values]); },
      getSeats: () => frozenClone(node.seats || []),
      stop: () => {
        if (!isRoot) return undefined;
        emit('control', id, 'stop', []);
        stopped = true;
        throw STOP;
      },
      child: childId => {
        const target = String(childId || '');
        return (node.children || []).includes(target) ? getSelf(target) : null;
      },
      children: () => Object.freeze((node.children || []).map(getSelf).filter(Boolean))
    };
    let bodyType = node.body?.type || 'dynamic';
    let bodyMass = finite(node.body?.mass);
    let bodyMaterial = frozenClone(node.body?.material || { restitution: 0.1, friction: 0.7 });
    let gravityEnabled = node.body?.useGravity !== false;
    let collisionEnabled = node.body?.collisionEnabled !== false;
    api.body = Object.freeze({
      getType: () => bodyType,
      setType: type => {
        if (type !== 'dynamic' && type !== 'kinematic') {
          return Object.freeze({ ok: false, type: bodyType, reason: 'invalid_body_type' });
        }
        const accepted = emit('component', id, 'body.setType', [type]);
        if (accepted) bodyType = type;
        return queuedResult(accepted, { type }, { type: bodyType });
      },
      getMass: () => bodyMass,
      setMass: mass => {
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
      setMaterial: material => {
        const nextMaterial = frozenClone(material);
        const accepted = emit('component', id, 'body.setMaterial', [material]);
        if (accepted) bodyMaterial = nextMaterial;
        return queuedResult(accepted, { material: nextMaterial }, { material: bodyMaterial });
      },
      getGravityEnabled: () => gravityEnabled,
      setGravityEnabled: enabled => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: gravityEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setGravityEnabled', [enabled]);
        if (accepted) gravityEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: gravityEnabled });
      },
      getCollisionEnabled: () => collisionEnabled,
      setCollisionEnabled: enabled => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: collisionEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setCollisionEnabled', [enabled]);
        if (accepted) collisionEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: collisionEnabled });
      },
      getVelocity: () => frozenClone(node.body?.velocity || [0, 0, 0]),
      getAngularVelocity: () => frozenClone(node.body?.angularVelocity || [0, 0, 0]),
      applyForce: force => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyForce', [safeForce])
          : false;
      },
      applyLocalForce: force => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyLocalForce', [safeForce])
          : false;
      },
      applyTorque: torque => {
        const safeTorque = boundedBodyVector(torque);
        return bodyType === 'dynamic' && !!safeTorque
          ? !!emit('component', id, 'body.applyTorque', [safeTorque])
          : false;
      }
    });
    api.constraints = Object.freeze({
      all: () => frozenClone(node.constraints || []),
      create: options => {
        const accepted = emit('component', id, 'constraints.create', [options]);
        return queuedResult(accepted, { id: null }, { id: null });
      },
      remove: constraintId => !!emit('component', id, 'constraints.remove', [constraintId])
    });
    const decorations = () => decorationOverlays.get(id) || node.decorations || [];
    api.decorations = Object.freeze({
      all: () => frozenClone(decorations()),
      get: decorationId => frozenClone(decorations().find(value => value.id === decorationId) || null),
      upsert: (decorationId, patch) => {
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
      remove: decorationId => {
        const values = decorations();
        if (!values.some(value => value.id === decorationId)) return Object.freeze({ ok: false, reason: 'decoration_not_found' });
        const accepted = emit('component', id, 'decorations.remove', [decorationId]);
        if (accepted) decorationOverlays.set(id, values.filter(value => value.id !== decorationId));
        return queuedResult(accepted, { id: decorationId });
      }
    });
    api.voxels = makeVoxelApi(id, false);
    api.microVoxels = makeVoxelApi(id, true);
    Object.freeze(api);
    selfCache.set(id, api);
    return api;
  }

  function makeWorldApi() {
    const nearby = Array.isArray(frame.world?.entities) ? frame.world.entities : [];
    const positionKey = value => Array.isArray(value) ? value.slice(0, 3).map(v => Math.floor(finite(v))).join(',') : '';
    const microPositionKey = (cell, offset) => positionKey(cell) + '|' + (Array.isArray(offset)
      ? offset.slice(0, 3).map(v => Math.round(finite(v))).join(',')
      : '');
    const hostWorldRead = (kind, position, offset = null) => {
      try {
        const encoded = hostWorldReadCall(kind, position, offset);
        return typeof encoded === 'string'
          ? frozenClone(JSON.parse(encoded))
          : Object.freeze({ block: 0, color: 0, materialId: 0 });
      } catch (_) {
        return Object.freeze({ block: 0, color: 0, materialId: 0 });
      }
    };
    const voxels = Object.freeze({
      get(position) {
        const key = positionKey(position);
        return worldVoxelOverlays.has(key)
          ? frozenClone(worldVoxelOverlays.get(key))
          : hostWorldRead('standard', position);
      },
      set(position, options) {
        const accepted = emit('world', null, 'voxels.set', [position, options]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), {
          block: 1,
          color: finite(options?.color),
          materialId: finite(options?.materialId) === 1 ? 1 : 0,
        });
        return queuedEdit('placed', accepted);
      },
      clear(position) {
        const accepted = emit('world', null, 'voxels.clear', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0, materialId: 0 });
        return queuedEdit('removed', accepted);
      },
      paint(position, options) {
        const accepted = emit('world', null, 'voxels.paint', [position, options]);
        if (accepted) {
          const current = voxels.get(position);
          if (current?.block) worldVoxelOverlays.set(positionKey(position), {
            ...current,
            color: finite(options?.color),
            materialId: options?.materialId === undefined
              ? finite(current.materialId)
              : (finite(options.materialId) === 1 ? 1 : 0),
          });
        }
        return queuedEdit('painted', accepted);
      },
      clearCell(position) {
        const accepted = emit('world', null, 'voxels.clearCell', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0, materialId: 0 });
        return queuedEdit('removed', accepted);
      },
      subdivide(position, offset) {
        const accepted = emit('world', null, 'voxels.subdivide', [position, offset]);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      }
    });
    const microVoxels = Object.freeze({
      get(cell, offset) {
        const key = microPositionKey(cell, offset);
        return worldMicroVoxelOverlays.has(key)
          ? frozenClone(worldMicroVoxelOverlays.get(key))
          : hostWorldRead('micro', cell, offset);
      },
      set(cell, offset, options) {
        const accepted = emit('world', null, 'microVoxels.set', [cell, offset, options]);
        if (accepted) worldMicroVoxelOverlays.set(
          microPositionKey(cell, offset),
          { block: 1, color: finite(options?.color), materialId: finite(options?.materialId) === 1 ? 1 : 0 }
        );
        return queuedEdit('placed', accepted);
      },
      clear(cell, offset) {
        const accepted = emit('world', null, 'microVoxels.clear', [cell, offset]);
        if (accepted) worldMicroVoxelOverlays.set(
          microPositionKey(cell, offset),
          { block: 0, color: 0, materialId: 0 },
        );
        return queuedEdit('removed', accepted);
      },
      paint(cell, offset, options) {
        const accepted = emit('world', null, 'microVoxels.paint', [cell, offset, options]);
        if (accepted) {
          const current = microVoxels.get(cell, offset);
          if (current?.block) worldMicroVoxelOverlays.set(
            microPositionKey(cell, offset),
            {
              ...current,
              color: finite(options?.color),
              materialId: options?.materialId === undefined
                ? finite(current.materialId)
                : (finite(options.materialId) === 1 ? 1 : 0),
            }
          );
        }
        return queuedEdit('painted', accepted);
      }
    });
    const worldSize = Array.isArray(frame.world?.size) ? frame.world.size : [0, 0];
    const wrappedDelta = (a, b, period) => {
      const direct = Math.abs(finite(a) - finite(b));
      const size = finite(period);
      if (size <= 0) return direct;
      const normalized = direct % size;
      return Math.min(normalized, size - normalized);
    };
    const distanceFrom = (item, origin) => {
      const position = Array.isArray(item?.position) ? item.position : [0, 0, 0];
      const dx = wrappedDelta(position[0], origin[0], worldSize[0]);
      const dy = finite(position[1]) - origin[1];
      const dz = wrappedDelta(position[2], origin[2], worldSize[1]);
      return Math.hypot(dx, dy, dz);
    };
    const entities = (origin, radius = 16) => {
      const queryOrigin = Array.isArray(origin) ? vector(origin) : vector(frame.position);
      const limit = Math.max(0, finite(radius));
      return Object.freeze(nearby
        .map(item => ({ item, distance: distanceFrom(item, queryOrigin) }))
        .filter(entry => entry.distance <= limit)
        .sort((a, b) => a.distance - b.distance)
        .map(entry => frozenClone({ ...entry.item, distance: entry.distance })));
    };
    entities.get = entityId => frozenClone(
      nearby.find(item => item.id === String(entityId) || item.runtimeId === entityId) || null
    );
    entities.list = chunkId => Object.freeze(nearby.filter(item => item.chunkId === String(chunkId)).map(frozenClone));
    entities.inChunk = entities.list;
    Object.freeze(entities);
    return Object.freeze({
      apiVersion: 3,
      getInfo: () => frozenClone(frame.world?.info || null),
      voxels,
      microVoxels,
      entities,
      raycast: (origin, direction, maxDistanceOrOptions = 24) => {
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
    const run = (path, args, next) => {
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
      cornerA: (...args) => run('cornerA', args),
      cornerB: (...args) => run('cornerB', args),
      box: (...args) => run('box', args),
      cells: cells => run('cells', [cells], { kind: 'world-cells', count: Array.isArray(cells) ? cells.length : 0 }),
      toggle: (...args) => run('toggle', args),
      entity: (entityId, nodeId = null) => run('entity', [entityId, nodeId], { kind: 'entity-subtree', entityId, nodeId, count: 1 }),
      entityBox: (...args) => run('entityBox', args),
      delete: () => {
        const accepted = emit('selection', null, 'delete', []);
        const removed = Number(current.count) || 0;
        return queuedResult(
          accepted,
          { removed, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null },
          { removed: 0, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null }
        );
      },
      assemble: (...args) => {
        const accepted = emit('selection', null, 'assemble', args);
        return queuedResult(
          accepted,
          { assembled: 1, entityId: null, runtimeId: null },
          { assembled: 0, entityId: null, runtimeId: null }
        );
      },
      createChild: (...args) => {
        const accepted = emit('selection', null, 'createChild', args);
        return queuedResult(accepted, { childId: null }, { childId: null });
      }
    });
  }

  function makeCommandResultsApi() {
    const results = Array.isArray(frame.commandResults) ? frame.commandResults : [];
    return Object.freeze({
      get: commandId => frozenClone(
        results.find(result => result?.commandId === String(commandId)) || null
      ),
      all: () => frozenClone(results)
    });
  }

  function prepareEntityMessages(entries) {
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

  function makeEntityMessagesApi(nodeId) {
    const reject = reason => Object.freeze({ ok: false, queued: 0, reason, commandId: null });
    return Object.freeze({
      received: nodeId === rootComponentId ? rootMessages : Object.freeze([]),
      send: (targetId, messageType, payload, encoding = 'utf8') => {
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

  const beginTick = snapshot => {
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


  const context = nodeId => {
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
        pressed: type => !!blocks.changed && (type === undefined || type === null || blocks.event?.type === type),
        event: () => frozenClone(blocks.event || null)
      }),
      input: Object.freeze({
        down: code => codeActive(input.down || [], code),
        pressed: code => codeActive(input.pressed || [], code),
        released: code => codeActive(input.released || [], code)
      }),
      players: frozenClone(frame.players || []),
      driver: frozenClone(frame.driver || null),
      contacts: frozenClone(frame.contacts || []),
      messages: makeEntityMessagesApi(nodeId),
      world: makeWorldApi(),
      selection: makeSelectionApi(),
      commands: makeCommandResultsApi(),
      log: message => { emit('log', nodeId, 'log', [String(message).slice(0, 1000)]); }
    });
    return ctx;
  };
  return {
    beginTick, getSelf, context,
    shouldStop: () => stopped,
    isStop: error => error === STOP,
    finish: () => ({ ok: true, commands, errors, states: clone(states) || {}, frozenStatePaths: collectFrozenPaths(states), stopped })
  };
}
