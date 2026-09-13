export interface RemotePlayerMotionSample {
  x: number;
  y: number;
  z: number;
  updatedAt: string | null;
}

export interface RemotePlayerMotionEstimate {
  vx: number;
  vy: number;
  vz: number;
  horizontalSpeed: number;
  intervalSeconds: number;
}

const MAX_REMOTE_HORIZONTAL_SPEED = 30;
const MAX_REMOTE_VERTICAL_SPEED = 30;

export function wrappedAxisDelta(from: number, to: number, size: number) {
  const delta = to - from;
  if (!Number.isFinite(delta) || !Number.isFinite(size) || size <= 0) return delta;
  return ((delta + size / 2) % size + size) % size - size / 2;
}

function sampleIntervalSeconds(
  previousUpdatedAt: string | null,
  nextUpdatedAt: string | null,
  fallbackIntervalSeconds: number,
) {
  const previousTime = previousUpdatedAt ? Date.parse(previousUpdatedAt) : NaN;
  const nextTime = nextUpdatedAt ? Date.parse(nextUpdatedAt) : NaN;
  const serverInterval = (nextTime - previousTime) / 1000;
  if (Number.isFinite(serverInterval) && serverInterval >= 0.03 && serverInterval <= 2) {
    return serverInterval;
  }
  if (Number.isFinite(fallbackIntervalSeconds) && fallbackIntervalSeconds >= 0.03 && fallbackIntervalSeconds <= 2) {
    return fallbackIntervalSeconds;
  }
  return null;
}

/** Estimate velocity once per network snapshot, never once per render frame. */
export function estimateRemotePlayerMotion(
  previous: RemotePlayerMotionSample,
  next: RemotePlayerMotionSample,
  worldSizeX: number,
  worldSizeZ: number,
  fallbackIntervalSeconds = 0,
): RemotePlayerMotionEstimate | null {
  const intervalSeconds = sampleIntervalSeconds(
    previous.updatedAt,
    next.updatedAt,
    fallbackIntervalSeconds,
  );
  if (intervalSeconds === null) return null;

  let vx = wrappedAxisDelta(previous.x, next.x, worldSizeX) / intervalSeconds;
  let vz = wrappedAxisDelta(previous.z, next.z, worldSizeZ) / intervalSeconds;
  let horizontalSpeed = Math.hypot(vx, vz);
  if (horizontalSpeed > MAX_REMOTE_HORIZONTAL_SPEED) {
    const scale = MAX_REMOTE_HORIZONTAL_SPEED / horizontalSpeed;
    vx *= scale;
    vz *= scale;
    horizontalSpeed = MAX_REMOTE_HORIZONTAL_SPEED;
  }
  const rawVy = (next.y - previous.y) / intervalSeconds;
  const vy = Math.max(-MAX_REMOTE_VERTICAL_SPEED, Math.min(MAX_REMOTE_VERTICAL_SPEED, rawVy));
  return { vx, vy, vz, horizontalSpeed, intervalSeconds };
}

/** Stop stale avatars instead of letting the last sampled walk cycle run for 30 seconds. */
export function remoteMotionFreshness(sampleAgeSeconds: number) {
  if (!Number.isFinite(sampleAgeSeconds)) return 0;
  if (sampleAgeSeconds <= 0.75) return 1;
  if (sampleAgeSeconds >= 1.2) return 0;
  return 1 - (sampleAgeSeconds - 0.75) / 0.45;
}
