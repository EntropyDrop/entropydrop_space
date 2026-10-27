/** Reversible CPU cone/frustum experiments on the production packed face arena. */
import { interceptMethod } from './FrameDiagnostics.ts';
import { voxelBlockBackFacing } from '@entropydrop/space-engine/render/VoxelFaceVisibility.ts';

export function installVisibilityCpuTrial(arena: any, getMode: () => string) {
  const undo: (() => void)[] = [];
  const savedReuse = arena.viewReuse && { ...arena.viewReuse };
  const wide = () => getMode() === 'wide' || getMode() === 'upload' || getMode().startsWith('cluster');
  function configure() {
    if (savedReuse) Object.assign(arena.viewReuse, wide() ? savedReuse : { translation: 16, normal: .06, padding: 18, angular: .061 });
  }
  configure(); arena.resetView = arena.visibilityDirty = true; arena.positionEpoch++; arena.viewEpoch++;
  undo.push(interceptMethod(arena, 'setView', (original, args) => {
    if (savedReuse || !wide()) return original(...args);
    const [camera, frustum, coverage, enabled] = args;
    if (arena.resetView || !arena.coverage || camera.distanceToSquared(arena.camera) >= 32 ** 2
      || frustum.planes.some((p: any, i: number) => {
        const old = arena.frustum.planes[i];
        return p.normal.distanceToSquared(old.normal) >= .12 ** 2
          || Math.abs(p.constant + p.normal.dot(camera) - old.constant - old.normal.dot(arena.camera)) >= 1;
      }) || enabled !== arena.visibilityEnabled) {
      if (!arena.camera.equals(camera)) arena.positionEpoch++;
      arena.resetView = false; arena.camera.copy(camera); arena.frustum.copy(frustum); arena.viewEpoch++;
      arena.emptyFrustum = frustum.planes.some((p: any) => p.normal.lengthSq() === 0 && p.constant < 0);
      arena.visibilityEnabled = enabled; arena.visibilityDirty = true;
    }
    const version = coverage.userData.voxelVisibilityVersion ?? coverage.version;
    if (coverage !== arena.coverage || version !== arena.coverageVersion) {
      arena.coverage = coverage; arena.coverageVersion = version; arena.visibilityDirty = true; arena.coverageEpoch++;
    }
  }));
  undo.push(interceptMethod(arena, 'prepareBlockTests', (original, args) => {
    const mode = getMode();
    if (savedReuse ? wide() : mode !== 'fast' && mode !== 'wide') return original(...args);
    const [entry] = args, data = arena.visibilityData(entry);
    if (!arena.cachedBlockTests || !arena.visibilityEnabled || !data) return original(...args);
    const fresh = !entry.blockTests || entry.blockTests.data !== data;
    // The existing allocator owns cache lifetime and coverage-mask bookkeeping.
    if (fresh) original(...args);
    const cache = entry.blockTests, padding = wide() ? 34 : 18;
    if (fresh || cache.position !== arena.positionEpoch) {
      const { x, y, z } = arena.camera, count = Math.min(cache.distance.length, Math.floor(data.length / 12));
      for (let block = 0; block < count; block++) {
        const at = block * 12, dx = x - data[at], dy = y - data[at + 1], dz = z - data[at + 2];
        // World bounds keep this well inside finite Float64 range. Reuse one
        // distance instead of two general-purpose Math.hypot calls per block.
        const legacy = mode === 'original' || mode === 'gpu';
        const distance = legacy ? Math.hypot(dx, dy, dz) : Math.sqrt(dx * dx + dy * dy + dz * dz), radius = data[at + 3];
        cache.distance[block] = distance;
        cache.facing[block] = legacy ? (voxelBlockBackFacing(data, at, x, y, z, padding) ? 1 : distance - radius > 256 + padding ? 0 : 2)
          : distance - radius <= 256 + padding ? 2
          : data[at + 4] * dx + data[at + 5] * dy + data[at + 6] * dz + distance * data[at + 7] + radius + padding < 0 ? 1 : 0;
      }
      cache.position = arena.positionEpoch; arena.stats.positionBlockTests += count;
    }
    const updatePlane = fresh || cache.view !== arena.viewEpoch;
    const result = original(...args);
    if (!savedReuse && wide() && updatePlane) {
      const { center, radius } = cache.sphere, distance = center.distanceTo(arena.camera);
      const margin = 34 + (distance + radius) * .121;
      cache.planeMask = 0;
      for (let plane = 0; plane < 6; plane++) {
        const p = arena.frustum.planes[plane], value = p.distanceToPoint(center), extent = radius * Math.max(1, p.normal.length());
        if (value + extent + margin < 0) { cache.planeMask = -1; break; }
        if (!(value - extent >= 0)) cache.planeMask |= 1 << plane;
      }
    }
    return result;
  }));
  const priorCull = arena.culledCached;
  function wideCull(cache: any, block: number, masked: boolean) {
    const at = block * 12, data = cache.data;
    if (arena.emptyFrustum) return 2;
    if (at + 12 > data.length) return 0;
    if (masked && cache.covered[block]) return 3;
    if (cache.facing[block] === 1) return 1;
    if (cache.facing[block] === 2) return 0;
    if (cache.planeMask === -1) return 2;
    const margin = -data[at + 3] - 34 - cache.distance[block] * .121;
    for (let i = 0; i < 6; i++) if (cache.planeMask & (1 << i)) {
      const p = arena.frustum.planes[i];
      if (p.normal.x * data[at] + p.normal.y * data[at + 1] + p.normal.z * data[at + 2] + p.constant < margin) return 2;
    }
    return 0;
  }
  return { update() { configure(); arena.culledCached = !savedReuse && wide() ? wideCull : priorCull; },
    dispose() {
      arena.culledCached = priorCull; undo.reverse().forEach(f => f());
      if (savedReuse) Object.assign(arena.viewReuse, savedReuse);
      arena.resetView = arena.visibilityDirty = true; arena.positionEpoch++; arena.viewEpoch++;
    } };
}
