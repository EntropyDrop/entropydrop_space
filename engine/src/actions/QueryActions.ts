import { readRecord } from '../contraption/EntityInput.ts';
import type { BasicActionContext, ActionPayload } from './ActionContracts.ts';
import { actionResult, toPoint } from './ActionValues.ts';

export function executeQueryAction(context: BasicActionContext, command: ActionPayload) {
  if (command.action !== 'raycast') return actionResult(command.action, 0, 'unsupported_action');
  const world = context?.world || context?.manager?.world;
  const manager = context?.manager;
  const origin = toPoint(command.origin);
  const direction = toPoint(command.direction);
  if (!origin || !direction || direction.lengthSq() < 1e-12) {
    return { ok: false, action: command.action, reason: 'invalid_ray', hit: null, worldHit: null, entityHit: null };
  }
  direction.normalize();
  const requestedDistance = Number(command.maxDistance);
  const maxDistance = Math.min(64, Math.max(0, Number.isFinite(requestedDistance) ? requestedDistance : 24));
  const space = command.space === 'bent' ? 'bent' : 'world';
  const includeWorld = command.include !== 'entities';
  const includeEntities = command.include === 'all' || command.include === 'entities';
  const kinds = Array.isArray(command.voxelKinds) ? command.voxelKinds : ['standard', 'micro'];
  // Player hover normally agrees with the mesh currently on screen while an
  // update is being built. A destructive interaction may explicitly inspect
  // the live view after its published target has already been consumed.
  const usePublishedCollision = typeof command.usePublishedCollision === 'boolean'
    ? command.usePublishedCollision
    : readRecord(command.actor).source !== 'script';

  let standardHit = null;
  let microHit = null;
  if (includeWorld && kinds.includes('standard')) {
    standardHit = space === 'bent'
      ? world?.raycastBent?.(origin, direction, maxDistance, usePublishedCollision)
      : world?.raycast?.(origin, direction, maxDistance);
  }
  if (includeWorld && kinds.includes('micro')) {
    microHit = space === 'bent'
      ? world?.raycastMicroBent?.(origin, direction, maxDistance, usePublishedCollision)
      : world?.raycastMicro?.(origin, direction, maxDistance, usePublishedCollision);
  }
  const standardDistance = standardHit?.hit && Number.isFinite(Number(standardHit.distance))
    ? Number(standardHit.distance)
    : Infinity;
  const microDistance = microHit?.hit && Number.isFinite(Number(microHit.distance))
    ? Number(microHit.distance)
    : Infinity;
  const worldHit = microDistance < standardDistance ? microHit : standardHit;
  const worldDistance = worldHit?.hit && Number.isFinite(Number(worldHit.distance))
    ? Number(worldHit.distance)
    : Infinity;

  let entityHit = null;
  if (includeEntities) {
    entityHit = space === 'bent'
      ? manager?.raycastContraptionHitBent?.(origin, direction, maxDistance)
      : manager?.raycastContraptionHit?.(origin, direction, maxDistance);
  }
  const entityDistance = entityHit && Number.isFinite(Number(entityHit.distance))
    ? Number(entityHit.distance)
    : Infinity;
  const hit = entityDistance <= worldDistance + 0.005 ? entityHit : (worldHit?.hit ? worldHit : null);
  return {
    ok: !!hit,
    action: command.action,
    reason: hit ? 'hit' : 'miss',
    kind: hit === entityHit && hit ? 'entity' : hit ? 'world' : null,
    hit,
    worldHit: worldHit?.hit ? worldHit : null,
    entityHit
  };
}
