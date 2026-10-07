import { readRecord } from '../contraption/EntityInput.ts';
import type { ConstraintInput } from '../contraption/EntityTypes.ts';
import type { BasicActionContext, ActionPayload, EntityTarget } from './ActionContracts.ts';
import { actionResult, requestedNodeId, resolveContraption } from './ActionValues.ts';

export function executePhysicsAction(context: BasicActionContext, command: ActionPayload) {
  const contraption = resolveContraption(context, readRecord(command.target) as EntityTarget);
  if (!contraption) return actionResult(command.action, 0, 'entity_unavailable');
  const nodeId = requestedNodeId(contraption, command.nodeId);

  switch (command.action) {
    case 'get-body': {
      const body = contraption.getRigidBody?.(nodeId);
      if (!body) return null;
      return Object.freeze({
        nodeId,
        type: body.type,
        mass: body.mass,
        restitution: body.restitution,
        friction: body.friction,
        useGravity: contraption.getNodeGravityEnabled?.(nodeId) ?? true,
        collisionEnabled: contraption.getNodeCollisionEnabled?.(nodeId) ?? true,
        velocity: Object.freeze(body.velocity.toArray()),
        angularVelocity: Object.freeze(body.angularVelocity.toArray())
      });
    }
    case 'set-body-type': {
      const changed = contraption.setNodeBodyType?.(nodeId, command.bodyType, {
        runtimeOnly: command.runtimeOnly === true
      }) ? 1 : 0;
      return actionResult(command.action, changed, changed ? 'updated' : 'invalid_body_type', {
        bodyType: contraption.getNodeBodyType?.(nodeId) || null
      });
    }
    case 'set-body-mass': {
      const requestedMass = Number(command.mass);
      if (!Number.isFinite(requestedMass) || requestedMass <= 0) {
        return actionResult(command.action, 0, 'invalid_mass', {
          mass: contraption.getNodeBodyMass?.(nodeId) ?? null
        });
      }
      const mass = contraption.setNodeBodyMass?.(nodeId, requestedMass, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, mass !== null && mass !== undefined ? 1 : 0, mass !== null && mass !== undefined ? 'updated' : 'body_unavailable', {
        mass: mass ?? contraption.getNodeBodyMass?.(nodeId) ?? null
      });
    }
    case 'set-body-material': {
      const material = contraption.setNodeBodyMaterial?.(nodeId, readRecord(command.material), {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, material ? 1 : 0, material ? 'updated' : 'body_unavailable', { material });
    }
    case 'set-body-gravity-enabled': {
      if (typeof command.enabled !== 'boolean') {
        return actionResult(command.action, 0, 'invalid_enabled', {
          enabled: contraption.getNodeGravityEnabled?.(nodeId) ?? null
        });
      }
      const enabled = contraption.setNodeGravityEnabled?.(nodeId, command.enabled, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, enabled !== null && enabled !== undefined ? 1 : 0,
        enabled !== null && enabled !== undefined ? 'updated' : 'body_unavailable', { enabled });
    }
    case 'set-body-collision-enabled': {
      if (typeof command.enabled !== 'boolean') {
        return actionResult(command.action, 0, 'invalid_enabled', {
          enabled: contraption.getNodeCollisionEnabled?.(nodeId) ?? null
        });
      }
      const enabled = contraption.setNodeCollisionEnabled?.(nodeId, command.enabled, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, enabled !== null && enabled !== undefined ? 1 : 0,
        enabled !== null && enabled !== undefined ? 'updated' : 'body_unavailable', { enabled });
    }
    case 'apply-body-force': {
      const applied = contraption.applyNodeBodyForce?.(nodeId, command.force) ? 1 : 0;
      return actionResult(command.action, applied, applied ? 'applied' : 'not_dynamic', { applied });
    }
    case 'apply-body-torque': {
      const applied = contraption.applyNodeBodyTorque?.(nodeId, command.torque) ? 1 : 0;
      return actionResult(command.action, applied, applied ? 'applied' : 'not_dynamic', { applied });
    }
    case 'create-constraint': {
      const constraint = contraption.createConstraint?.(readRecord(command.definition) as ConstraintInput);
      return actionResult(command.action, constraint ? 1 : 0, constraint ? 'created' : 'invalid_constraint', { constraint });
    }
    case 'remove-constraint': {
      const removed = contraption.removeConstraint?.(String(command.constraintId || '')) ? 1 : 0;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'get-constraints':
      return contraption.getConstraints?.(typeof command.nodeId === 'string' ? command.nodeId : null) || Object.freeze([]);
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}
