import * as THREE from 'three';
import type { Contraption } from './Contraption.ts';
import type { EntityNode, VoxelEditOptions } from './EntityTypes.ts';
import { BodyType, compareComponentIds } from './Contraption.ts';
import { asVector3, asQuaternion, isMicroOffset, readRecord } from './EntityInput.ts';
import { MICRO_DIVISIONS } from '../voxel/MicroGrid.ts';
import { ActionDomain } from '../actions/BasicActions.ts';
import { freezeDecorationSnapshot } from './Decorations.ts';

export interface ComponentScriptApi extends ReturnType<typeof createComponentScriptApiSurface> {
  child(childId: unknown): ComponentScriptApi | null;
  children(): readonly ComponentScriptApi[];
}

export function createComponentScriptApi(entity: Contraption, node: EntityNode): ComponentScriptApi {
  const surface = createComponentScriptApiSurface(entity, node);
  return Object.freeze({
    ...surface,
    child(childId: unknown) {
      const targetId = String(childId || '');
      return node.children.has(targetId) ? entity.getChildScriptApi(targetId) : null;
    },
    children: () => Object.freeze([...node.children].sort(compareComponentIds)
      .map(childId => entity.getChildScriptApi(childId))
      .filter((child): child is ComponentScriptApi => child !== null)),
  });
}

function scriptEditResult(field: 'placed' | 'removed', count: number, reason: string) {
  return Object.freeze({ ok: count > 0, [field]: count, reason });
}

function createComponentScriptApiSurface(entity: Contraption, node: EntityNode) {
  const id = node.id;
  const isRoot = node.parentId === null;
  const noop = () => { };

  const api = {
    apiVersion: 3,
    id,
    parentId: node.parentId,

    // ---------- A. Common ----------
    /**
     * Apply thrust at this component along a root-entity local direction.
     * - Root: force at center of mass, matching applyLocalForce.
     * - Child: force at the component position, producing τ = r × F off-center.
     * Direction is independent of spin, follows root orientation, respects the
     * legacy root-body force budget, and has no effect on a kinematic root body.
     */
    applyThrust: (force: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return;
      const worldForce = new THREE.Vector3(
        Number(force[0]) || 0,
        Number(force[1]) || 0,
        Number(force[2]) || 0
      ).applyQuaternion(entity.quaternion);
      const componentWorldPos = entity.getEntityNodeWorldPosition(id);
      const rootLocalPivot = entity.worldToLocal(componentWorldPos);
      entity.applyForceAt(
        [worldForce.x, worldForce.y, worldForce.z],
        [rootLocalPivot.x, rootLocalPivot.y, rootLocalPivot.z]
      );
    },
    /**
     * Apply thrust at this component using its full mounted local frame.
     * Unlike the legacy applyThrust, a side-mounted module's +Y therefore
     * follows the face normal stored in its installed localRotation.
     */
    applyLocalThrust: (force: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return;
      const worldForce = new THREE.Vector3(
        Number(force[0]) || 0,
        Number(force[1]) || 0,
        Number(force[2]) || 0
      ).applyQuaternion(entity.getEntityNodeWorldQuaternion(id));
      const componentWorldPos = entity.getEntityNodeWorldPosition(id);
      const rootLocalPivot = entity.worldToLocal(componentWorldPos);
      entity.applyForceAt(
        [worldForce.x, worldForce.y, worldForce.z],
        [rootLocalPivot.x, rootLocalPivot.y, rootLocalPivot.z]
      );
    },
    getWorldPosition: () => Object.freeze(entity.getEntityNodeWorldPosition(id).toArray()),
    /** World-orientation quaternion [x,y,z,w], including all ancestor rotations. */
    getWorldRotation: () => Object.freeze(entity.getEntityNodeWorldQuaternion(id).toArray()),
    /** Current pivot in entity-local coordinates, shared by getBounds and setPivot. */
    getPivot: () => Object.freeze([node.pivotLocal.x, node.pivotLocal.y, node.pivotLocal.z]),
    localToWorldDirection: (direction: unknown) => {
      const localDirection = asVector3(direction, new THREE.Vector3());
      const worldDirection = localDirection.applyQuaternion(entity.getEntityNodeWorldQuaternion(id));
      return Object.freeze(worldDirection.toArray());
    },
    /** Entity-local block bounds {min, max, size, center}, or null when empty. */
    getBounds: () => entity.getNodeBlocksBounds(id),

    // ---------- B. Kinematic pose control ----------
    setLocalPosition: isRoot ? (value: unknown) => {
      // A kinematic root has no parent, so its local frame is world space.
      if (entity.bodyType !== BodyType.KINEMATIC) return;
      entity.position.copy(asVector3(value, entity.position));
    } : (value: unknown) => {
      if (node.bodyType !== BodyType.KINEMATIC) return;
      node.localPosition.copy(asVector3(value, node.localPosition));
      node.group.position.copy(node.localPosition);
    },
    setLocalRotation: isRoot ? (value: unknown) => {
      if (entity.bodyType !== BodyType.KINEMATIC) return;
      entity.quaternion.copy(asQuaternion(value, entity.quaternion));
      entity.updateTransform();
    } : (value: unknown) => {
      if (node.bodyType !== BodyType.KINEMATIC) return;
      node.localQuaternion.copy(asQuaternion(value, node.localQuaternion));
      node.group.quaternion.copy(node.localQuaternion);
    },
    setLocalEuler: isRoot ? (value: unknown) => {
      if (entity.bodyType !== BodyType.KINEMATIC || !Array.isArray(value) || value.length < 3) return;
      entity.quaternion.setFromEuler(new THREE.Euler(
        Number(value[0]) || 0,
        Number(value[1]) || 0,
        Number(value[2]) || 0,
        'YXZ'
      ));
      entity.updateTransform();
    } : (value: unknown) => {
      if (node.bodyType !== BodyType.KINEMATIC) return;
      if (!Array.isArray(value) || value.length < 3) return;
      node.localQuaternion.setFromEuler(new THREE.Euler(
        Number(value[0]) || 0,
        Number(value[1]) || 0,
        Number(value[2]) || 0,
        'YXZ'
      ));
      node.group.quaternion.copy(node.localQuaternion);
    },
    setLocalSpin: isRoot ? (axis: unknown, rpm: unknown) => {
      if (entity.bodyType !== BodyType.KINEMATIC) return;
      const safeRpm = Number(rpm);
      const spinAxis = asVector3(axis, new THREE.Vector3(0, 1, 0));
      node.commandedThisFrame = true;
      if (!Number.isFinite(safeRpm) || spinAxis.lengthSq() < 1e-9) {
        node.localAngularVelocity.set(0, 0, 0);
        return;
      }
      node.localAngularVelocity.copy(spinAxis.normalize()).multiplyScalar(safeRpm * Math.PI * 2 / 60);
    } : (axis: unknown, rpm: unknown) => {
      if (node.bodyType !== BodyType.KINEMATIC) return;
      const safeRpm = Number(rpm);
      const spinAxis = asVector3(axis, new THREE.Vector3(0, 1, 0));
      node.commandedThisFrame = true;
      if (!Number.isFinite(safeRpm) || spinAxis.lengthSq() < 1e-9) {
        node.localAngularVelocity.set(0, 0, 0);
        return;
      }
      node.localAngularVelocity.copy(spinAxis.normalize()).multiplyScalar(safeRpm * Math.PI * 2 / 60);
    },
    getLocalPosition: () => Object.freeze(isRoot ? [0, 0, 0] : node.localPosition.toArray()),
    getLocalRotation: () => Object.freeze(isRoot ? entity.quaternion.toArray() : node.localQuaternion.toArray()),
    /**
     * Update the pivot in the same entity-local coordinates as getBounds. Pivots
     * do not follow bounds automatically; setting one shifts the node or entity so
     * blocks keep their world positions. Kinematic bodies support this; dynamic
     * bodies use their physical center of mass.
     */
    setPivot: (value: unknown) => {
      entity.setComponentPivot(id, value, {
        requireStopped: false,
        allowDynamic: false
      });
    },

    // ---------- C. Legacy root force surface. Component-local arguments are
    // converted to root entity space; self.body targets the component body. ----------
    applyForce: (force: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return;
      // World-space force is identical for every component and applies at COM.
      entity.applyForce(force);
    },
    applyLocalForce: (force: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return;
      if (isRoot) {
        entity.applyLocalForce(force);
        return;
      }
      // Component-local to root-local using the component's relative rotation.
      const local = new THREE.Vector3(
        Number(force[0]) || 0,
        Number(force[1]) || 0,
        Number(force[2]) || 0
      );
      const worldQuat = entity.getEntityNodeWorldQuaternion(id);
      const relQuat = entity.quaternion.clone().invert().multiply(worldQuat);
      local.applyQuaternion(relQuat);
      entity.applyLocalForce([local.x, local.y, local.z]);
    },
    applyForceAt: (force: unknown, localPosition: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return;
      if (!Array.isArray(localPosition) || localPosition.length < 3) return;
      if (isRoot) {
        entity.applyForceAt(force, localPosition);
        return;
      }
      // Component-local application point through hierarchy to world, then back to root-local.
      const componentPoint = new THREE.Vector3(
        Number(localPosition[0]) + node.pivotLocal.x,
        Number(localPosition[1]) + node.pivotLocal.y,
        Number(localPosition[2]) + node.pivotLocal.z
      );
      const worldPoint = entity.entityLocalToWorld(id, componentPoint);
      const rootLocalPoint = entity.worldToLocal(worldPoint);
      entity.applyForceAt(force, rootLocalPoint.toArray());
    },
    applyTorque: (torque: unknown) => {
      if (!Array.isArray(torque) || torque.length < 3) return;
      // World-space torque is identical for every component.
      entity.applyTorque(torque);
    },
    /** Replace this component's driver seats, relative to its pivot. */
    setSeats: (values: unknown) => entity.setComponentSeats(id, values),
    /** Stop every script and reset runtime state. Root-only; children are a no-op. */
    stop: isRoot ? () => {
      entity.performBasicAction({ action: 'stop-scripts' });
      return true;
    } : noop,
    /** Read this component's driver seats relative to its pivot. */
    getSeats: () => Object.freeze(entity.getComponentSeats(id).map((seat) => Object.freeze({
      position: Object.freeze([...seat.position]),
      rotation: Object.freeze([...seat.rotation]),
      fixedOrientation: seat.fixedOrientation
    }))),

  };

  // ---------- V2: tree traversal + component-scoped state + explicit namespaces ----------
  const state = entity.getComponentState(id);
  const body = Object.freeze({
    getType: () => entity.getNodeBodyType(id),
    setType: (type: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'set-body-type',
        nodeId: id,
        bodyType: type,
        runtimeOnly: true
      });
      return Object.freeze({ ok: result.ok, type: result.bodyType || entity.getNodeBodyType(id), reason: result.reason });
    },
    getMass: () => entity.getNodeBodyMass(id),
    setMass: (mass: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'set-body-mass',
        nodeId: id,
        mass,
        runtimeOnly: true
      });
      return Object.freeze({ ok: result.ok, mass: result.mass ?? entity.getNodeBodyMass(id), reason: result.reason });
    },
    getMaterial: () => entity.getNodeBodyMaterial(id),
    setMaterial: (material: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'set-body-material',
        nodeId: id,
        material,
        runtimeOnly: true
      });
      return Object.freeze({ ok: result.ok, material: result.material || entity.getNodeBodyMaterial(id), reason: result.reason });
    },
    getGravityEnabled: () => entity.getNodeGravityEnabled(id),
    setGravityEnabled: (enabled: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'set-body-gravity-enabled',
        nodeId: id,
        enabled,
        runtimeOnly: true
      });
      return Object.freeze({
        ok: result.ok,
        enabled: result.enabled ?? entity.getNodeGravityEnabled(id),
        reason: result.reason
      });
    },
    getCollisionEnabled: () => entity.getNodeCollisionEnabled(id),
    setCollisionEnabled: (enabled: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'set-body-collision-enabled',
        nodeId: id,
        enabled,
        runtimeOnly: true
      });
      return Object.freeze({
        ok: result.ok,
        enabled: result.enabled ?? entity.getNodeCollisionEnabled(id),
        reason: result.reason
      });
    },
    getVelocity: () => Object.freeze(entity.getRigidBody(id)?.velocity.toArray() || [0, 0, 0]),
    getAngularVelocity: () => Object.freeze(entity.getRigidBody(id)?.angularVelocity.toArray() || [0, 0, 0]),
    applyForce: (force: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'apply-body-force',
        nodeId: id,
        force
      });
      return result.ok;
    },
    applyLocalForce: (force: unknown) => {
      if (!Array.isArray(force) || force.length < 3) return false;
      const worldForce = new THREE.Vector3(
        Number(force[0]) || 0,
        Number(force[1]) || 0,
        Number(force[2]) || 0
      ).applyQuaternion(entity.getRigidBody(id)?.quaternion || new THREE.Quaternion());
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'apply-body-force',
        nodeId: id,
        force: worldForce.toArray()
      });
      return result.ok;
    },
    applyTorque: (torque: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'apply-body-torque',
        nodeId: id,
        torque
      });
      return result.ok;
    }
  });
  const constraints = Object.freeze({
    all: () => entity.getConstraints(id),
    create: (options: unknown) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'create-constraint',
        definition: { ...readRecord(options), bodyB: id }
      });
      return Object.freeze({ ok: result.ok, id: result.constraint?.id || null, reason: result.reason });
    },
    remove: (constraintId: string) => {
      const result = entity.performBasicAction({
        domain: ActionDomain.PHYSICS,
        action: 'remove-constraint',
        constraintId
      });
      return result.ok;
    }
  });
  const decorations = Object.freeze({
    all: () => freezeDecorationSnapshot(entity.getRuntimeComponentDecorations(id)),
    get: (decorationId: string) => freezeDecorationSnapshot(entity.getRuntimeComponentDecorations(id).find((value) => value.id === decorationId) || null),
    upsert: (decorationId: string, patch: unknown) => entity.editRuntimeDecoration(id, decorationId, patch),
    remove: (decorationId: string) => entity.editRuntimeDecoration(id, decorationId, undefined, true)
  });
  const voxels = Object.freeze({
    set: (location: unknown, options: VoxelEditOptions | null = null) => entity.setComponentStandardVoxel(id, node, location, options),
    clear: (location: unknown) => entity.clearComponentStandardVoxel(id, node, location),
    paint: (location: unknown, options: VoxelEditOptions | null = null) => {
      const cell = entity.getComponentStandardCell(node, location);
      if (!cell) return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
      const result = entity.performBasicAction({ action: 'paint-standard', nodeId: id, cell, options });
      return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
    },
    clearCell: (location: unknown) => {
      const cell = entity.getComponentStandardCell(node, location);
      if (!cell) return scriptEditResult('removed', 0, 'invalid_position');
      const result = entity.performBasicAction({ action: 'clear-cell', nodeId: id, cell });
      return scriptEditResult('removed', result.removed || 0, result.reason);
    },
    subdivide: (location: unknown, clearOffset: unknown = null) => {
      const cell = entity.getComponentStandardCell(node, location);
      if (!cell || (clearOffset !== null && !isMicroOffset(clearOffset))) {
        return Object.freeze({ ok: false, subdivided: 0, removed: 0, reason: 'invalid_position' });
      }
      const micro = clearOffset === null ? null : [
        cell.x * MICRO_DIVISIONS + Number(clearOffset[0]),
        cell.y * MICRO_DIVISIONS + Number(clearOffset[1]),
        cell.z * MICRO_DIVISIONS + Number(clearOffset[2])
      ];
      const result = entity.performBasicAction({ action: 'subdivide-standard', nodeId: id, cell, micro });
      return Object.freeze({
        ok: result.ok,
        subdivided: result.subdivided || 0,
        removed: result.removed || 0,
        reason: result.reason
      });
    }
  });
  const microVoxels = Object.freeze({
    set: (location: unknown, microOffset: unknown, options: VoxelEditOptions | null = null) => (
      entity.setComponentMicroVoxel(id, node, location, microOffset, options)
    ),
    clear: (location: unknown, microOffset: unknown) => entity.clearComponentMicroVoxel(id, node, location, microOffset),
    paint: (location: unknown, microOffset: unknown, options: VoxelEditOptions | null = null) => {
      const cell = entity.getComponentStandardCell(node, location);
      if (!cell || !isMicroOffset(microOffset)) {
        return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
      }
      const result = entity.performBasicAction({
        action: 'paint-micro',
        nodeId: id,
        micro: [
          cell.x * MICRO_DIVISIONS + Number(microOffset[0]),
          cell.y * MICRO_DIVISIONS + Number(microOffset[1]),
          cell.z * MICRO_DIVISIONS + Number(microOffset[2])
        ],
        options
      });
      return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
    }
  });
  return Object.freeze({ ...api, state, body, constraints, decorations, voxels, microVoxels });
}
