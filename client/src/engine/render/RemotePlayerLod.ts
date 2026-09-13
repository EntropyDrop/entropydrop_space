export type RemotePlayerLod = 'full' | 'simplified' | 'billboard' | 'hidden';

export const REMOTE_PLAYER_FULL_DISTANCE = 20;
export const REMOTE_PLAYER_SIMPLIFIED_DISTANCE = 80;
export const REMOTE_PLAYER_MAX_DISTANCE = 240;

function baseLod(distance: number): RemotePlayerLod {
  if (distance <= REMOTE_PLAYER_FULL_DISTANCE) return 'full';
  if (distance <= REMOTE_PLAYER_SIMPLIFIED_DISTANCE) return 'simplified';
  if (distance <= REMOTE_PLAYER_MAX_DISTANCE) return 'billboard';
  return 'hidden';
}

/**
 * Resolve distance LOD with asymmetric hysteresis so a player hovering near a
 * boundary does not swap render modes every heartbeat/frame.
 */
export function resolveRemotePlayerLod(
  distance: number,
  previous: RemotePlayerLod | null = null,
): RemotePlayerLod {
  const safeDistance = Number.isFinite(distance) ? Math.max(0, distance) : Infinity;
  if (!previous) return baseLod(safeDistance);

  if (previous === 'full' && safeDistance <= 24) return 'full';
  if (previous === 'simplified') {
    if (safeDistance >= 16 && safeDistance <= 90) return 'simplified';
  }
  if (previous === 'billboard') {
    if (safeDistance >= 70 && safeDistance <= 260) return 'billboard';
  }
  if (previous === 'hidden' && safeDistance >= 220) return 'hidden';
  return baseLod(safeDistance);
}

export function isProjectedPlayerVisible(
  projected: Pick<{ x: number; y: number; z: number }, 'x' | 'y' | 'z'>,
  margin = 1.2,
) {
  return projected.z >= -1.1
    && projected.z <= 1.1
    && Math.abs(projected.x) <= margin
    && Math.abs(projected.y) <= margin;
}
