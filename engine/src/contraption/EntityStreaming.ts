import * as THREE from 'three';
import { Contraption, BodyType } from './Contraption.ts';
import { isFiniteVector3Array } from './EntityInput.ts';

function cloneEntityStreamData(value: unknown, fallback: unknown = null) {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch (_) {
    return fallback;
  }
}

// Definitions are immutable checkpoint values. Keeping one per live entity avoids
// walking every voxel for pose-only saves; a WeakMap releases unloaded entities.
const definitions = new WeakMap<Contraption, {
  version: number;
  slot: Readonly<ReturnType<Contraption['serializeSubtree']>>;
}>();

function freezeDefinition(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDefinition(child);
  Object.freeze(value);
}

function captureDefinition(contraption: Contraption): Readonly<ReturnType<Contraption['serializeSubtree']>> {
  const cached = definitions.get(contraption);
  if (cached?.version === contraption.definitionVersion) return cached.slot;
  // Detach nested constraint/decorations arrays before freezing so the live
  // editor remains mutable. Portable-copy callers still get fresh, editable slots.
  const slot = structuredClone(contraption.serializeSubtree(contraption.rootComponentId));
  freezeDefinition(slot);
  definitions.set(contraption, { version: contraption.definitionVersion, slot });
  return slot;
}

export function captureEntityStreamState(contraption: Contraption, chunk: { id: string }) {
    // The point-grab servo temporarily enables physics so the wrench can move
    // a stopped entity. That is an editor implementation detail, not durable
    // playback state. A periodic/pagehide save can run while the mouse is
    // still held, so serialize the current pose as a fully stopped checkpoint
    // rather than restoring servo velocity as live physics after a refresh.
    const wrenchStopped = contraption.isWrenchGrabbed === true;
    const states = contraption.getSerializableComponentStates?.()
      || Object.fromEntries([...(contraption.componentVariables || [])]);
    const nodes = [...(contraption.entityNodes?.values?.() || [])].map(node => ({
      id: node.id,
      localPosition: node.localPosition?.toArray?.() || [0, 0, 0],
      localRotation: node.localQuaternion?.toArray?.() || [0, 0, 0, 1],
      localAngularVelocity: wrenchStopped
        ? [0, 0, 0]
        : node.localAngularVelocity?.toArray?.() || [0, 0, 0]
    }));
    const bodies = (contraption.getRigidBodies?.() || []).map(body => ({
      id: body.id,
      type: body.type,
      position: body.position?.toArray?.() || [0, 0, 0],
      quaternion: body.quaternion?.toArray?.() || [0, 0, 0, 1],
      velocity: wrenchStopped ? [0, 0, 0] : body.velocity?.toArray?.() || [0, 0, 0],
      angularVelocity: wrenchStopped ? [0, 0, 0] : body.angularVelocity?.toArray?.() || [0, 0, 0],
      mass: body.mass,
      inverseInertia: body.inverseInertia,
      restitution: body.restitution,
      friction: body.friction,
      useGravity: contraption.getNodeGravityEnabled?.(body.id) ?? true,
      collisionEnabled: contraption.getNodeCollisionEnabled?.(body.id) ?? true,
      linearDamping: body.linearDamping,
      angularDamping: body.angularDamping,
      centerOfMassLocal: body.centerOfMassLocal?.toArray?.() || [0, 0, 0],
      previousKinematicPosition: wrenchStopped
        ? body.position?.toArray?.() || [0, 0, 0]
        : body.previousKinematicPosition?.toArray?.() || [0, 0, 0],
      previousKinematicQuaternion: wrenchStopped
        ? body.quaternion?.toArray?.() || [0, 0, 0, 1]
        : body.previousKinematicQuaternion?.toArray?.() || [0, 0, 0, 1],
      isOnGround: !!body.isOnGround
    }));
    const centerOffset = (contraption.localCenter || new THREE.Vector3())
      .clone()
      .applyQuaternion(contraption.quaternion);
    const constructorOrigin = contraption.position.clone().sub(centerOffset);
    return {
      id: contraption.id,
      publicId: contraption.publicId,
      chunkId: chunk.id,
      slot: captureDefinition(contraption),
      constructorOrigin: constructorOrigin.toArray(),
      position: contraption.position.toArray(),
      quaternion: contraption.quaternion.toArray(),
      velocity: wrenchStopped ? [0, 0, 0] : contraption.velocity.toArray(),
      angularVelocity: wrenchStopped ? [0, 0, 0] : contraption.angularVelocity.toArray(),
      // localCenter is the root's original coordinate anchor. It intentionally
      // stays fixed while live block edits change the bounds, so it must be
      // persisted separately from the final voxel layout.
      localCenter: contraption.localCenter?.toArray?.() || null,
      nodes,
      bodies,
      states,
      runtimeDecorations: wrenchStopped ? [] : contraption.captureRuntimeDecorations(),
      scriptStatus: wrenchStopped ? 'stopped' : contraption.scriptStatus,
      physicsSimulationEnabled: wrenchStopped
        ? false
        : contraption.isPhysicsSimulationEnabled?.() !== false,
      scriptError: contraption.scriptError,
      nodeScriptErrors: [...contraption.nodeScriptErrors.entries()],
      scriptRuntime: contraption.scriptRuntime,
      tickCount: contraption.tickCount,
      scriptCommandSequence: contraption.scriptCommandSequence,
      totalRuntime: contraption.totalRuntime,
      lastExecutionTimeMs: contraption.lastExecutionTimeMs,
      scriptLogs: contraption.scriptLogs.slice(-100),
      rootPivotOverride: contraption.rootPivotOverride?.toArray?.() || null,
      useGravity: contraption.useGravity,
      isOnGround: contraption.isOnGround,
      groundDistance: contraption.groundDistance,
      behaviorPrompt: contraption.behaviorPrompt,
      agentInterpretation: contraption.agentInterpretation,
      serverManaged: contraption.serverManaged === true,
      serverExecutionMode: contraption.serverExecutionMode || 'browser',
      serverHostingEnabled: contraption.serverHostingEnabled === true,
      serverOwnerUserId: contraption.serverOwnerUserId || null,
      serverOwnerName: contraption.serverOwnerName || null,
      serverExecutorName: contraption.serverExecutorName || null,
      serverExecutionLeaseExpiresAt: contraption.serverExecutionLeaseExpiresAt || null,
      serverCanControl: contraption.serverCanControl === true,
      serverCanEdit: contraption.serverCanEdit === true,
      serverExecutesLocally: contraption.serverExecutesLocally === true,
      serverExecutionEpoch: Number(contraption.serverExecutionEpoch) || 0,
      serverRevision: Number(contraption.serverRevision) || 0,
      serverPlaybackRevision: Number(contraption.serverPlaybackRevision) || 0,
      serverDesiredRunState: contraption.serverDesiredRunState || null,
      serverDefinitionDigest: contraption.serverDefinitionDigest || null,
      serverSnapshotDigest: contraption.serverSnapshotDigest || null,
    };
  }


/** Older checkpoints may omit newly introduced state fields. */
export type EntityStreamState = Partial<ReturnType<typeof captureEntityStreamState>> & { resetRuntime?: boolean };

export function restoreEntityStreamState(contraption: Contraption, record: EntityStreamState) {
    contraption.position.fromArray(record.position || [0, 0, 0]);
    contraption.quaternion.fromArray(record.quaternion || [0, 0, 0, 1]).normalize();
    contraption.velocity.fromArray(record.velocity || [0, 0, 0]);
    contraption.angularVelocity.fromArray(record.angularVelocity || [0, 0, 0]);
    contraption.isOnGround = !!record.isOnGround;
    contraption.groundDistance = Number(record.groundDistance) || 0;
    contraption.rootPivotOverride = Array.isArray(record.rootPivotOverride)
      ? new THREE.Vector3().fromArray(record.rootPivotOverride)
      : null;

    for (const saved of record.nodes || []) {
      const node = contraption.entityNodes.get(String(saved.id));
      if (!node) continue;
      node.localPosition.fromArray(saved.localPosition || [0, 0, 0]);
      node.localQuaternion.fromArray(saved.localRotation || [0, 0, 0, 1]).normalize();
      node.localAngularVelocity.fromArray(saved.localAngularVelocity || [0, 0, 0]);
      node.group.position.copy(node.localPosition);
      node.group.quaternion.copy(node.localQuaternion);
    }

    for (const saved of record.bodies || []) {
      const body = contraption.getRigidBody(saved.id);
      if (!body) continue;
      const savedUseGravity = typeof saved.useGravity === 'boolean'
        ? saved.useGravity
        : (body.id === contraption.rootComponentId && typeof record.useGravity === 'boolean'
            ? record.useGravity
            : undefined);
      const restoresRuntimeMass = Number.isFinite(Number(saved.mass)) && Number(saved.mass) !== body.mass;
      const restoresRuntimeOverride = saved.type !== body.type
        || restoresRuntimeMass
        || (Number.isFinite(Number(saved.restitution)) && Number(saved.restitution) !== body.restitution)
        || (Number.isFinite(Number(saved.friction)) && Number(saved.friction) !== body.friction)
        || (typeof savedUseGravity === 'boolean'
          && savedUseGravity !== contraption.getNodeGravityEnabled?.(body.id))
        || (typeof saved.collisionEnabled === 'boolean'
          && saved.collisionEnabled !== contraption.getNodeCollisionEnabled?.(body.id));
      if (restoresRuntimeOverride) contraption.captureRuntimeBodyConfigDefault?.(body.id);
      if (saved.type === BodyType.DYNAMIC || saved.type === BodyType.KINEMATIC) {
        body.type = saved.type;
        const node = contraption.entityNodes.get(String(saved.id));
        if (node) node.bodyType = saved.type;
      }
      if (Number.isFinite(Number(saved.mass)) && Number(saved.mass) > 0) body.mass = Number(saved.mass);
      if (Number.isFinite(Number(saved.inverseInertia)) && Number(saved.inverseInertia) >= 0) {
        body.inverseInertia = Number(saved.inverseInertia);
      }
      if (Number.isFinite(Number(saved.restitution))) {
        body.restitution = Math.max(0, Math.min(1, Number(saved.restitution)));
      }
      if (Number.isFinite(Number(saved.friction))) {
        body.friction = Math.max(0, Math.min(1, Number(saved.friction)));
      }
      if (Number.isFinite(Number(saved.linearDamping))) {
        body.linearDamping = Math.max(0, Math.min(1, Number(saved.linearDamping)));
      }
      if (Number.isFinite(Number(saved.angularDamping))) {
        body.angularDamping = Math.max(0, Math.min(1, Number(saved.angularDamping)));
      }
      if (isFiniteVector3Array(saved.centerOfMassLocal)) {
        body.centerOfMassLocal.fromArray(saved.centerOfMassLocal);
      }
      body.position.fromArray(saved.position || [0, 0, 0]);
      body.quaternion.fromArray(saved.quaternion || [0, 0, 0, 1]).normalize();
      body.velocity.fromArray(saved.velocity || [0, 0, 0]);
      body.angularVelocity.fromArray(saved.angularVelocity || [0, 0, 0]);
      body.previousKinematicPosition.fromArray(saved.previousKinematicPosition || saved.position || [0, 0, 0]);
      body.previousKinematicQuaternion.fromArray(saved.previousKinematicQuaternion || saved.quaternion || [0, 0, 0, 1]).normalize();
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
      body.isOnGround = !!saved.isOnGround;

      if (body.id === contraption.rootComponentId) {
        contraption.bodyType = body.type;
        if (restoresRuntimeMass) contraption.massOverride = body.mass;
        contraption.mass = body.mass;
        contraption.restitution = body.restitution;
        contraption.friction = body.friction;
        contraption.linearDamping = body.linearDamping;
        contraption.angularDamping = body.angularDamping;
      } else {
        const definition = contraption.childDefinitions.get(body.id);
        if (definition) {
          definition.bodyType = body.type === BodyType.DYNAMIC ? BodyType.DYNAMIC : BodyType.KINEMATIC;
          if (restoresRuntimeMass) definition.mass = body.mass;
          definition.restitution = body.restitution;
          definition.friction = body.friction;
        }
      }
      if (typeof savedUseGravity === 'boolean'
        && savedUseGravity !== contraption.getNodeGravityEnabled?.(body.id)) {
        contraption.setNodeGravityEnabled?.(body.id, savedUseGravity, { runtimeOnly: true });
      }
      if (typeof saved.collisionEnabled === 'boolean'
        && saved.collisionEnabled !== contraption.getNodeCollisionEnabled?.(body.id)) {
        contraption.setNodeCollisionEnabled?.(body.id, saved.collisionEnabled, { runtimeOnly: true });
      }
    }
    contraption.syncAllBodyTransforms?.();

    for (const nodeId of contraption.entityNodes.keys()) {
      const target = contraption.getComponentState(nodeId);
      for (const key of Object.keys(target)) delete target[key];
      const saved = cloneEntityStreamData(record.states?.[nodeId], {});
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(target, saved);
    }
    contraption.scriptRuntimeClient.reset(contraption.getSerializableComponentStates());
    contraption.scriptStatus = record.scriptStatus || 'stopped';
    contraption.restoreRuntimeDecorations(contraption.scriptStatus === 'stopped' ? [] : record.runtimeDecorations ?? []);
    const physicsEnabled = record.physicsSimulationEnabled !== false;
    contraption.setPhysicsSimulationEnabled?.(physicsEnabled, {
      // A stopped snapshot has no trajectory to preserve. Pin both render and
      // collision history to its restored pose; otherwise a remote stopped
      // replica interpolates from its constructor origin on every frame and
      // visibly twitches after refresh.
      resetHistory: !physicsEnabled
    });
    contraption.scriptError = record.scriptError || null;
    contraption.nodeScriptErrors = new Map(record.nodeScriptErrors || []);
    contraption.scriptRuntime = Number(record.scriptRuntime) || 0;
    contraption.tickCount = Number(record.tickCount) || 0;
    contraption.scriptCommandSequence = Number.isSafeInteger(record.scriptCommandSequence)
      && Number(record.scriptCommandSequence) >= 0
      ? Number(record.scriptCommandSequence)
      : contraption.tickCount * 256;
    contraption.totalRuntime = Number(record.totalRuntime) || 0;
    contraption.lastExecutionTimeMs = Number(record.lastExecutionTimeMs) || 0;
    contraption.scriptLogs = Array.isArray(record.scriptLogs) ? [...record.scriptLogs] : [];
    contraption.updateTransform();
    // spaceAPI Stop/configuration saves placement while discarding runtime state.
    if (record.resetRuntime === true) contraption.stopAllNodeScripts();
  }
