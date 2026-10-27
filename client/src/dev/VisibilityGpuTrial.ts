import * as THREE from 'three/webgpu';
import { interceptMethod } from './FrameDiagnostics.ts';
import { visibilityGpuShader } from './VisibilityGpuShader.ts';

/** Keep original pages, PBR shaders, quad records and draw ordering. Only
 * opaque block selection and instance counts move to GPU compute dispatches. */
export async function installVisibilityGpuTrial(game: any, getMode: () => string, stats: any) {
  const scene = game.sceneRenderer, renderer = scene.renderer, arena = game.world.distantSurface.voxels.arena;
  const device = renderer.backend.device, B = (globalThis as any).GPUBufferUsage;
  const undo: (() => void)[] = [], resources = new Map<any, any>(), originalIndirect = new Map<any, any>();
  const allMaps = new WeakMap<object, any>();
  const shader = device.createShaderModule({ code: visibilityGpuShader, label: 'visibility-stable-compaction' });
  const info = await shader.getCompilationInfo();
  if (info.messages.some((m: any) => m.type === 'error')) throw Error(info.messages.map((m: any) => m.message).join('\n'));
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
    ...[1, 2, 3, 4].map(binding => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } })),
    ...[5, 6, 7].map(binding => ({ binding, visibility: 4, buffer: { type: 'storage' } })),
  ] });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }), pipelines: any = {};
  for (const entryPoint of ['classify', 'prefix', 'scatter']) pipelines[entryPoint] = await device.createComputePipelineAsync({
    layout: pipelineLayout, compute: { module: shader, entryPoint } });
  function buffer(size: number, label: string, uniform = false) {
    return device.createBuffer({ size, usage: B.COPY_DST | B.COPY_SRC | (uniform ? B.UNIFORM : B.STORAGE), label });
  }
  function release(r: any) { r.buffers.forEach((b: any) => b.destroy()); renderer._attributes.delete(r.indirect); }
  function resource(page: any) {
    let r = resources.get(page); if (r) return r;
    const capacity = page.data.count / 16, maxRuns = 2048, maxGroups = Math.ceil(capacity / 256) + maxRuns;
    const indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(maxRuns * 5), 1);
    indirect.name = 'visibility-indirect'; renderer._attributes.update(indirect, 4);
    r = { capacity, maxRuns, maxGroups, indirect, entries: new WeakSet(), metadata: new Float32Array(capacity * 12),
      groupsArray: new Uint32Array(maxGroups * 4), runsArray: new Uint32Array(maxRuns * 4), paramsArray: new Float32Array(32),
      mapVersion: -1, view: -1, signature: '', metaDirty: false, count: 0, groupCount: 0,
      params: buffer(128, 'visibility-params', true), input: buffer(capacity * 32, 'visibility-input-map'),
      meta: buffer(capacity * 48, 'visibility-bounds'), groups: buffer(maxGroups * 16, 'visibility-groups'),
      runs: buffer(maxRuns * 16, 'visibility-runs'), scratch: buffer(Math.max(capacity, maxGroups) * 16, 'visibility-prefix') };
    r.buffers = [r.params, r.input, r.meta, r.groups, r.runs, r.scratch];
    resources.set(page, r); stats.newGpuPages++; return r;
  }
  undo.push(interceptMethod(arena, 'visibleBlocks', (original, args) => {
    const [entry, masked] = args;
    if (getMode() !== 'gpu' || masked) return original(...args);
    let result = allMaps.get(entry);
    if (!result) {
      const blocks = Math.ceil(entry.count / 16), map = new Float32Array(blocks * 8);
      for (let b = 0; b < blocks; b++) map.set([entry.start + b * 16, Math.min(16, entry.count - b * 16),
        entry.origin.x, entry.origin.y, entry.origin.z, 1, 0, 0], b * 8);
      result = { map, blocks, faces: entry.count, back: 0, outside: 0, covered: 0 }; allMaps.set(entry, result);
    }
    return result;
  }));
  function restoreIndirect() {
    for (const [geometry, previous] of originalIndirect) geometry.setIndirect(previous.attribute, previous.offset);
    originalIndirect.clear();
  }
  function refresh() {
    stats.computePasses = stats.indirectDraws = stats.gpuEncodeMs = stats.newGpuPages = 0;
    if (getMode() !== 'gpu') { restoreIndirect(); return; }
    const began = performance.now();
    for (const [page, r] of resources) if (!arena.pages.includes(page)) { release(r); resources.delete(page); }
    let encoder: any;
    for (const page of arena.pages) {
      const active = page.runs.filter((mesh: any) => mesh.visible);
      if (!active.length) continue;
      const r = resource(page);
      if (active.length > r.maxRuns) throw Error('Visibility run capacity exceeded.');
      renderer._attributes.update(page.map, 3);
      for (const entry of page.entries) if (!entry.attributes && !r.entries.has(entry)) {
        const data = arena.visibilityData(entry), blocks = Math.ceil(entry.count / 16);
        for (let b = 0; b < blocks; b++) {
          const at = (entry.start / 16 + b) * 12, valid = data && b * 12 + 12 <= data.length;
          r.metadata.fill(0, at, at + 12);
          if (valid) { r.metadata.set(data.subarray(b * 12, b * 12 + 8), at); r.metadata[at + 8] = 1; }
        }
        r.entries.add(entry); r.metaDirty = true;
      }
      const signature = active.map((mesh: any) => `${mesh.id}:${mesh.userData.voxelArenaBase}:${mesh.userData.voxelArenaFaces}`).join('/');
      const output = renderer.backend.get(page.map).buffer;
      const changed = r.mapVersion !== page.map.version || r.view !== arena.viewEpoch || signature !== r.signature || r.metaDirty || r.output !== output;
      for (let i = 0; i < active.length; i++) {
        const geometry = active[i].geometry;
        if (!originalIndirect.has(geometry)) originalIndirect.set(geometry, { attribute: geometry.indirect, offset: geometry.indirectOffset });
        if (geometry.indirect !== r.indirect || geometry.indirectOffset !== i * 20) {
          geometry.setIndirect(r.indirect, i * 20); game.world.distantSurface.voxels.group.needsUpdate = true;
        }
      }
      stats.indirectDraws += active.length;
      if (!changed) continue;
      let groupCount = 0, end = 0;
      for (let i = 0; i < active.length; i++) {
        const mesh = active[i], base = mesh.userData.voxelArenaBase, count = mesh.userData.voxelArenaFaces / 16;
        const first = groupCount;
        for (let offset = 0; offset < count; offset += 256) r.groupsArray.set([base + offset, Math.min(256, count - offset), i, 0], groupCount++ * 4);
        r.runsArray.set([base, count, first, groupCount - first], i * 4); end = Math.max(end, base + count);
      }
      if (groupCount > r.maxGroups || end > r.capacity) throw Error('Visibility block capacity exceeded.');
      const p = r.paramsArray; p.set([arena.camera.x, arena.camera.y, arena.camera.z, 0]);
      arena.frustum.planes.forEach((plane: any, i: number) => p.set([...plane.normal.toArray(), plane.constant], 4 + i * 4));
      new Uint32Array(p.buffer).set([groupCount, active.length, Number(arena.emptyFrustum), Number(arena.visibilityEnabled)], 28);
      device.queue.writeBuffer(r.params, 0, p);
      device.queue.writeBuffer(r.input, 0, page.map.array, 0, end * 8);
      if (r.metaDirty) device.queue.writeBuffer(r.meta, 0, r.metadata);
      device.queue.writeBuffer(r.groups, 0, r.groupsArray, 0, groupCount * 4);
      device.queue.writeBuffer(r.runs, 0, r.runsArray, 0, active.length * 4);
      if (r.output !== output) {
        r.output = output;
        r.bind = device.createBindGroup({ layout, entries: [r.params, r.input, r.meta, r.groups, r.runs, r.scratch, output,
          renderer.backend.get(r.indirect).buffer].map((buffer: any, binding: number) => ({ binding, resource: { buffer } })) });
      }
      encoder ??= device.createCommandEncoder({ label: 'visibility-gpu' });
      for (const entryPoint of ['classify', 'prefix', 'scatter']) {
        const pass = encoder.beginComputePass({ label: `visibility-${entryPoint}` }); pass.setPipeline(pipelines[entryPoint]); pass.setBindGroup(0, r.bind);
        pass.dispatchWorkgroups(entryPoint === 'prefix' ? Math.ceil(active.length / 64) : groupCount); pass.end(); stats.computePasses++;
      }
      r.count = active.length; r.groupCount = groupCount; r.end = end; r.mapVersion = page.map.version;
      r.view = arena.viewEpoch; r.signature = signature; r.metaDirty = false;
    }
    if (encoder) device.queue.submit([encoder.finish()]);
    stats.gpuBytes = [...resources.values()].reduce((sum, r) => sum + r.buffers.reduce((n: number, b: any) => n + b.size, 0) + r.indirect.array.byteLength, 0);
    stats.gpuEncodeMs = performance.now() - began;
  }
  undo.push(interceptMethod(renderer, 'render', (original, args) => {
    if (args[0] === scene.scene) refresh(); return original(...args);
  }));
  async function read(buffer: any, size: number) {
    const target = device.createBuffer({ size, usage: B.MAP_READ | B.COPY_DST }), encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, target, 0, size); device.queue.submit([encoder.finish()]);
    try { await target.mapAsync((globalThis as any).GPUMapMode.READ); return target.getMappedRange().slice(0); }
    finally { if (target.mapState === 'mapped') target.unmap(); target.destroy(); }
  }
  /** Outside timings: compare GPU compacted maps to the Float64 CPU predicate,
   * verify stable order, and count real indirect instances rather than Three's
   * nominal geometry statistics (which cannot observe GPU-written counts). */
  async function verify() {
    if (getMode() !== 'gpu') throw Error('GPU mode required for verification.');
    const result = { runs: 0, requiredBlocks: 0, retainedBlocks: 0, missingBlocks: 0, extraBlocks: 0, orderErrors: 0, indirectInstances: 0 };
    for (const [page, r] of resources) {
      if (!arena.pages.includes(page) || !page.runs.some((m: any) => m.visible)) continue;
      const output = new Float32Array(await read(r.output, r.end * 32));
      const scratch = new Uint32Array(await read(r.scratch, Math.max(r.end, r.count) * 16));
      const indirect = new Uint32Array(await read(renderer.backend.get(r.indirect).buffer, r.count * 20));
      for (let i = 0; i < r.count; i++) {
        const base = r.runsArray[i * 4], count = r.runsArray[i * 4 + 1], kept = scratch[i * 4 + 3];
        const positions = new Map<number, number>(), required = new Set<number>();
        for (let b = 0; b < count; b++) {
          const at = (base + b) * 8, face = page.map.array[at], m = face / 16 * 12, data = r.metadata;
          positions.set(face, b); let visible = true;
          if (page.map.array[at + 5] && data[m + 8] && arena.visibilityEnabled) {
            const dx = arena.camera.x - data[m], dy = arena.camera.y - data[m + 1], dz = arena.camera.z - data[m + 2];
            const distance = Math.hypot(dx, dy, dz), radius = data[m + 3];
            if (arena.emptyFrustum) visible = false;
            else if (distance - radius > 274) {
              visible = !(data[m + 4] * dx + data[m + 5] * dy + data[m + 6] * dz + distance * data[m + 7] + radius + 18 < 0);
              if (visible) for (const p of arena.frustum.planes) if (p.normal.x * data[m] + p.normal.y * data[m + 1] + p.normal.z * data[m + 2] + p.constant < -radius - 18 - distance * .061) visible = false;
            }
          }
          if (visible) required.add(face);
        }
        let last = -1; const got = new Set<number>();
        for (let b = 0; b < kept; b++) {
          const at = (base + b) * 8, face = output[at], position = positions.get(face);
          if (position === undefined || position <= last) result.orderErrors++;
          last = position ?? -1; got.add(face);
          const source = (base + (position ?? 0)) * 8;
          for (let k = 0; k < 5; k++) if (output[at + k] !== page.map.array[source + k]) result.orderErrors++;
        }
        result.runs++; result.requiredBlocks += required.size; result.retainedBlocks += got.size;
        result.missingBlocks += [...required].filter(face => !got.has(face)).length;
        result.extraBlocks += [...got].filter(face => !required.has(face)).length;
        if (indirect[i * 5] !== 192 || indirect[i * 5 + 1] !== Math.ceil(kept / 2)) result.orderErrors++;
        result.indirectInstances += indirect[i * 5 + 1];
      }
    }
    if (result.missingBlocks || result.orderErrors) throw Error('GPU visibility validation failed: ' + JSON.stringify(result));
    return result;
  }
  function invalidate() { for (const r of resources.values()) { r.mapVersion = -1; r.view = -1; } }
  return { verify, invalidate, restoreIndirect, dispose() {
    restoreIndirect(); undo.reverse().forEach(f => f()); resources.forEach(release); resources.clear();
  } };
}
