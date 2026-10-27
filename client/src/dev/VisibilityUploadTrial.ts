/** DEV-only hypothesis: compare maps before upload, retaining pending ranges. */
import { interceptMethod } from './FrameDiagnostics.ts';
export function installVisibilityUploadTrial(arena: any, enabled: () => boolean) {
  const hooks = new Map<any, () => void>(), touched = new Map<any, { min: number; max: number; version: number; ranges: any[] }>();
  const undo = interceptMethod(arena, 'sync', (original, args) => {
    if (!enabled()) return original(...args);
    touched.clear();
    for (const page of arena.pages) {
      const map = page.map;
      touched.set(map, { min: Infinity, max: 0, version: map.version, ranges: map.updateRanges.map((r: any) => ({ ...r })) });
      if (!hooks.has(map)) hooks.set(map, interceptMethod(map.array, 'set', (set, [source, offset = 0]) => {
        const change = enabled() && touched.get(map);
        if (!change) return set(source, offset);
        let first = 0, end = source.length;
        while (first < end && map.array[offset + first] === source[first]) first++;
        if (first === end) return;
        while (end > first && map.array[offset + end - 1] === source[end - 1]) end--;
        change.min = Math.min(change.min, offset + first); change.max = Math.max(change.max, offset + end);
        return set(source.subarray(first, end), offset + first);
      }));
    }
    const result = original(...args);
    for (const [map, change] of touched) if (map.version !== change.version) {
      const beforeBytes = map.updateRanges.reduce((n: number, r: any) => n + r.count * 4, 0);
      map.clearUpdateRanges();
      if (!Number.isFinite(change.min)) {
        map.version = change.version;
        for (const r of change.ranges) map.addUpdateRange(r.start, r.count);
        arena.stats.mapUploadBytes -= beforeBytes;
      } else {
        for (const r of change.ranges) { change.min = Math.min(change.min, r.start); change.max = Math.max(change.max, r.start + r.count); }
        map.addUpdateRange(change.min, change.max - change.min);
        arena.stats.mapUploadBytes += (change.max - change.min) * 4 - beforeBytes;
      }
    }
    return result;
  });
  return () => { undo(); hooks.forEach(restore => restore()); hooks.clear(); touched.clear(); };
}

/** Outside frame sampling: prove submitted GPU maps match active CPU records. */
export async function verifyVisibilityMaps(game: any) {
  const renderer = game.sceneRenderer.renderer, arena = game.world.distantSurface.voxels.arena;
  const device = renderer.backend.device, B = (globalThis as any).GPUBufferUsage;
  let pages = 0, words = 0, mismatches = 0;
  for (const page of arena.pages) {
    const active = page.runs.filter((mesh: any) => mesh.visible);
    if (!active.length) continue;
    const end = Math.max(...active.map((m: any) => m.userData.voxelArenaBase + m.userData.voxelArenaFaces / 16));
    const size = end * 8 * 4, source = renderer.backend.get(page.map).buffer;
    const target = device.createBuffer({ size, usage: B.MAP_READ | B.COPY_DST });
    const expected = new Uint32Array(page.map.array.buffer, page.map.array.byteOffset, size / 4).slice();
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, target, 0, size); device.queue.submit([encoder.finish()]);
    try {
      await target.mapAsync((globalThis as any).GPUMapMode.READ);
      const actual = new Uint32Array(target.getMappedRange());
      for (let i = 0; i < expected.length; i++) mismatches += Number(expected[i] !== actual[i]);
      pages++; words += expected.length;
    } finally { if (target.mapState === 'mapped') target.unmap(); target.destroy(); }
  }
  if (mismatches) throw Error('Uploaded visibility maps differ from CPU: ' + JSON.stringify({ pages, words, mismatches }));
  return { pages, words, mismatches };
}
