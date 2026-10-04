import * as THREE from 'three/webgpu';
import { storage, instanceIndex, uint, float, vec3, varying, min, uniform, wgslFn } from 'three/tsl';

export type VoxelFaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardNodeMaterial>;
export type ArenaInputs = { origin: any; offset: any; span: any; direction: any; emission: any; color: any; valid: any };
const BLOCK = 64;
const PAGE_FACES = 64 * 1024;
export const ARENA_COPY_FACES = 16 * 1024;
export const ARENA_COPY_MS = .75;
const names = ['voxelOffset', 'voxelSpan', 'voxelDirection', 'voxelEmission', 'color'] as const;
const unpackColor = wgslFn('fn voxelArenaColor(value: u32) -> vec3<f32> { return unpack4x8unorm(value).xyz; }');
type Range = { start: number; count: number };
type Entry = Range & { mesh: VoxelFaceMesh; geometry: THREE.InstancedBufferGeometry; page: Page; allocated: number; copied: number;
  attributes?: THREE.BufferAttribute[]; versions: number[]; origin: THREE.Vector3;
  invalid: boolean; releasing: boolean; onDispose: () => void };
type Page = { mesh: VoxelFaceMesh; runs: VoxelFaceMesh[]; entries: Set<Entry>; free: Range[];
  map: THREE.StorageBufferAttribute; data: THREE.StorageBufferAttribute; release: Set<() => void> };

/** Primary store for immutable, settled far faces. Records use 16 bytes instead
 * of 32-byte vertex attributes. Publication is bounded; incomplete/fading draws
 * retain their original attributes. Fully migrated sources release both their
 * CPU attributes and GPU buffers, and can reconstruct the reference path.
 * Runs preserve source draw order, including unmerged faces between them. */
export class VoxelFaceArena {
  readonly pages: Page[] = [];
  private readonly entries = new Map<VoxelFaceMesh, Entry>();
  private readonly orders = new Map<VoxelFaceMesh, number>();
  private hidden: VoxelFaceMesh[] = [];
  private drawing: (Entry | VoxelFaceMesh)[] = [];
  readonly stats = { residentFaces: 0, bytes: 0, visibleFaces: 0, paddedFaces: 0, draws: 0,
    sourceDraws: 0, mapUploadBytes: 0, copyFaces: 0, copyMs: 0, maxCopyMs: 0, pendingSources: 0,
    releasedSourceBytes: 0, pages: 0 };
  private readonly root: THREE.BundleGroup;
  private readonly make: (inputs: ArenaInputs) => VoxelFaceMesh;
  constructor(root: THREE.BundleGroup, make: (inputs: ArenaInputs) => VoxelFaceMesh) { this.root = root; this.make = make; }
  get hasPendingWork() { return this.stats.pendingSources > 0; }

  private eligible(mesh: VoxelFaceMesh) {
    return !mesh.userData.voxelArena && mesh.geometry.instanceCount > 0
      && mesh.userData.voxelArenaCompatible === true && mesh.material === mesh.userData.opaqueMaterial;
  }
  private createPage(capacity: number) {
    const data = new THREE.StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    // Two vec4s per block preserve the original local offset + origin arithmetic.
    const map = new THREE.StorageBufferAttribute(new Float32Array(capacity / BLOCK * 8), 4);
    const records = storage(data, 'uvec4' as 'vec4', capacity).toReadOnly();
    const remap = storage(map, 'vec4', capacity / BLOCK * 2).toReadOnly();
    const base = uniform(uint(0)).onObjectUpdate(({ object }) => object.userData.voxelArenaBase ?? 0);
    const blockIndex = instanceIndex.div(uint(BLOCK)).add(base).mul(2);
    const block = remap.element(blockIndex), originZ = remap.element(blockIndex.add(1)).x;
    const local = instanceIndex.mod(uint(BLOCK)), valid = local.lessThan(uint(block.y));
    const face = uint(block.x).add(uint(min(float(local), float(block.y).sub(1))));
    const record = records.element(face);
    const mesh = this.make({ origin: vec3(block.z, block.w, originZ),
      offset: vec3(float(uint(record.x).bitAnd(65535)), float(uint(record.x).shiftRight(16)), float(uint(record.y).bitAnd(65535))),
      span: vec3(float(uint(record.y).shiftRight(16)), float(uint(record.z).bitAnd(65535)), 0).xy,
      direction: float(uint(record.z).shiftRight(16).bitAnd(255)), emission: float(uint(record.z).shiftRight(24)),
      color: varying(unpackColor(uint(record.w))), valid });
    mesh.userData.voxelArena = true; mesh.name = 'DistantVoxelArena'; mesh.visible = false;
    const page: Page = { mesh, runs: [mesh], entries: new Set(), free: [{ start: 0, count: capacity }],
      map, data, release: new Set() };
    const renderers = new WeakSet<object>();
    mesh.onBeforeRender = renderer => {
      if (renderers.has(renderer)) return;
      renderers.add(renderer);
      // r183 omits node-only storage attributes from geometry disposal.
      const attributes = (renderer as any)._attributes;
      if (attributes) page.release.add(() => { attributes.delete(data); attributes.delete(map); });
    };
    this.pages.push(page); this.root.add(mesh);
    return page;
  }
  private allocate(mesh: VoxelFaceMesh): Entry | null {
    const count = mesh.geometry.instanceCount, allocated = Math.ceil(count / BLOCK) * BLOCK;
    // Worker tiles use unsigned 16-bit offsets/spans and byte directions/colors.
    // Foreign geometry keeps ordinary submission instead of truncating values.
    if (!Number.isFinite(count) || count > 256 * 1024) return null;
    const attributes = names.map(name => mesh.geometry.getAttribute(name) as THREE.BufferAttribute);
    if (attributes.some(a => !a || a.count < count)) return null;
    let page = this.pages.find(p => p.free.some(range => range.count >= allocated));
    if (!page) page = this.createPage(Math.max(PAGE_FACES, allocated));
    const index = page.free.findIndex(range => range.count >= allocated), range = page.free[index];
    const entry: Entry = { mesh, geometry: mesh.geometry, page, start: range.start, count, allocated, copied: 0, attributes,
      versions: attributes.map(a => a.version), origin: mesh.userData.voxelOrigin.clone(), invalid: false,
      releasing: false, onDispose: () => { if (!entry.releasing) entry.invalid = true; } };
    range.start += allocated; range.count -= allocated;
    if (!range.count) page.free.splice(index, 1);
    page.entries.add(entry); this.entries.set(mesh, entry);
    mesh.geometry.addEventListener('dispose', entry.onDispose);
    return entry;
  }
  private restoreAttributes(entry: Entry) {
    if (entry.attributes || entry.mesh.geometry.getAttribute(names[0])) return;
    const offset = new Float32Array(entry.count * 3), span = new Float32Array(entry.count * 2);
    const direction = new Float32Array(entry.count), emission = new Float32Array(entry.count), color = new Uint8Array(entry.count * 4);
    const data = entry.page.data.array as Uint32Array;
    for (let i = 0; i < entry.count; i++) {
      const at = (entry.start + i) * 4, a = data[at], b = data[at + 1], c = data[at + 2], rgb = data[at + 3];
      offset[i * 3] = a & 65535; offset[i * 3 + 1] = a >>> 16; offset[i * 3 + 2] = b & 65535;
      span[i * 2] = b >>> 16; span[i * 2 + 1] = c & 65535;
      direction[i] = (c >>> 16) & 255; emission[i] = c >>> 24;
      color.set([rgb & 255, (rgb >>> 8) & 255, (rgb >>> 16) & 255, 255], i * 4);
    }
    const arrays = [offset, span, direction, emission, color], sizes = [3, 2, 1, 1, 4];
    names.forEach((name, i) => entry.mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(arrays[i], sizes[i], i === 4)));
    this.root.needsUpdate = true;
  }
  private remove(entry: Entry, restore: boolean) {
    if (restore) this.restoreAttributes(entry);
    entry.geometry.removeEventListener('dispose', entry.onDispose);
    this.entries.delete(entry.mesh); entry.page.entries.delete(entry);
    const ranges = entry.page.free;
    ranges.push({ start: entry.start, count: entry.allocated }); ranges.sort((a, b) => a.start - b.start);
    for (let i = ranges.length - 2; i >= 0; i--) if (ranges[i].start + ranges[i].count === ranges[i + 1].start) {
      ranges[i].count += ranges[i + 1].count; ranges.splice(i + 1, 1);
    }
  }
  private disposePage(page: Page) {
    for (const mesh of page.runs) { mesh.removeFromParent(); mesh.geometry.dispose(); }
    page.mesh.material.dispose();
    for (const release of page.release) release(); page.release.clear();
    this.pages.splice(this.pages.indexOf(page), 1);
  }
  restoreSources() {
    for (const mesh of this.hidden) mesh.visible = true;
    this.hidden.length = 0;
  }
  idle() { this.stats.copyFaces = this.stats.copyMs = this.stats.mapUploadBytes = 0; }
  sync(budgetMs = ARENA_COPY_MS, budgetFaces = ARENA_COPY_FACES) {
    const sources = (this.root.children as VoxelFaceMesh[]).filter(mesh => !mesh.userData.voxelArena).sort((a, b) => a.id - b.id);
    const sourceSet = new Set(sources);
    for (const [mesh, order] of this.orders) if (!sourceSet.has(mesh)) { mesh.renderOrder = order; this.orders.delete(mesh); }
    for (const mesh of sources) {
      if (!this.orders.has(mesh)) this.orders.set(mesh, mesh.renderOrder);
      mesh.renderOrder = mesh.id;
    }
    for (const entry of this.entries.values()) {
      const mesh = entry.mesh;
      const replaced = entry.attributes ? names.some((name, i) => mesh.geometry.getAttribute(name) !== entry.attributes![i]
        || entry.attributes![i].version !== entry.versions[i]) : names.some(name => !!mesh.geometry.getAttribute(name));
      if (!sourceSet.has(mesh) || entry.invalid || replaced || !this.eligible(mesh)
        || entry.count !== mesh.geometry.instanceCount || !entry.origin.equals(mesh.userData.voxelOrigin)) {
        this.remove(entry, sourceSet.has(mesh) && !replaced && entry.count === mesh.geometry.instanceCount);
      }
    }
    const started = performance.now(); let copied = 0, pending = 0;
    for (const mesh of sources) {
      if (!this.eligible(mesh)) continue;
      let entry = this.entries.get(mesh);
      if (entry && !entry.attributes) continue;
      // Firefox's coarse clock can exhaust the soft time budget while merely
      // scanning settled/hidden sources. Always permit one bounded copy so a
      // source at the end of that list cannot starve the entry gate forever.
      if (copied >= budgetFaces || (copied > 0 && performance.now() - started >= budgetMs)) { pending++; continue; }
      entry ??= this.allocate(mesh) ?? undefined;
      if (!entry) continue;
      const [offset, span, direction, emission, colors] = entry.attributes!;
      const out = entry.page.data.array as Uint32Array, from = entry.copied;
      const until = Math.min(entry.count, from + Math.min(4096, budgetFaces - copied));
      for (let i = from; i < until; i++) {
        const at = (entry.start + i) * 4, c = i * colors.itemSize;
        out[at] = offset.getX(i) | (offset.getY(i) << 16);
        out[at + 1] = offset.getZ(i) | (span.getX(i) << 16);
        out[at + 2] = span.getY(i) | (direction.getX(i) << 16) | (emission.getX(i) << 24);
        out[at + 3] = colors.array[c] | (colors.array[c + 1] << 8) | (colors.array[c + 2] << 16) | 0xff000000;
      }
      entry.copied = until; copied += until - from;
      entry.page.data.addUpdateRange((entry.start + from) * 4, (until - from) * 4); entry.page.data.needsUpdate = true;
      if (until === entry.count) {
        // Notify Three before deleting attributes so every renderer releases its
        // buffers and invalidates cached bindings. No second terrain copy stays.
        entry.releasing = true; mesh.geometry.dispose(); entry.releasing = false;
        names.forEach(name => mesh.geometry.deleteAttribute(name)); entry.attributes = undefined;
        // The renderer adapter drops cached CPU arrays after geometry disposal.
        (mesh.geometry as any).dispatchEvent({ type: 'voxelarenaretire' });
        this.root.needsUpdate = true;
      } else pending++;
    }
    Object.assign(this.stats, { copyFaces: copied, copyMs: performance.now() - started, pendingSources: pending,
      residentFaces: 0, bytes: 0, mapUploadBytes: 0, releasedSourceBytes: 0 });
    this.stats.maxCopyMs = Math.max(this.stats.maxCopyMs, this.stats.copyMs);
    for(const page of [...this.pages]) {
      if(!page.entries.size) {this.disposePage(page);continue;}
      this.stats.bytes += page.data.array.byteLength + page.map.array.byteLength;
      for(const entry of page.entries) if(!entry.attributes) {
        this.stats.residentFaces += entry.count; this.stats.releasedSourceBytes += entry.count * 32;
      }
    }
    this.stats.pages = this.pages.length;
    const drawing = sources.filter(mesh=>mesh.visible).map(mesh=>{
      const entry=this.entries.get(mesh);return entry && !entry.attributes ? entry : mesh;
    });
    const unchanged=drawing.length===this.drawing.length && drawing.every((item,i)=>item===this.drawing[i]);
    this.drawing=drawing;
    if(unchanged) {
      for(const item of drawing) if('page' in item) {item.mesh.visible=false;this.hidden.push(item.mesh);}
      return;
    }
    Object.assign(this.stats,{visibleFaces:0,paddedFaces:0,draws:0,sourceDraws:0});
    const blocks = new Map<Page, number>(), runs = new Map<Page, number>(), changed = new Set<Page>();
    let lastPage: Page | null = null, run: VoxelFaceMesh | null = null;
    const active = new Set<VoxelFaceMesh>();
    for (const mesh of sources) {
      if (!mesh.visible) continue;
      const entry = this.entries.get(mesh);
      if (!entry || entry.attributes) { lastPage = null; continue; }
      const page = entry.page, at = blocks.get(page) ?? 0;
      if (lastPage !== page) {
        const index = runs.get(page) ?? 0;
        if (!page.runs[index]) {
          const clone = page.mesh.clone(false); clone.geometry = page.mesh.geometry.clone();
          clone.onBeforeRender = page.mesh.onBeforeRender; page.runs.push(clone); this.root.add(clone);
        }
        run = page.runs[index]; runs.set(page, index + 1); active.add(run);
        if (run.userData.voxelArenaBase !== at || run.renderOrder !== mesh.id || !run.visible) this.root.needsUpdate = true;
        run.userData.voxelArenaBase = at; run.renderOrder = mesh.id; run.visible = true;
        // Remember the old count before assembling this run.
        run.userData.voxelArenaOldCount = run.geometry.instanceCount; run.geometry.instanceCount = 0;
        lastPage = page;
      }
      const array = page.map.array; let n = at;
      for (let offset = 0; offset < entry.count; offset += BLOCK) {
        const values = [entry.start + offset, Math.min(BLOCK, entry.count - offset), entry.origin.x, entry.origin.y, entry.origin.z, 0, 0, 0];
        for (let i = 0; i < 8; i++) if (array[n * 8 + i] !== values[i]) { array[n * 8 + i] = values[i]; changed.add(page); }
        n++;
      }
      run!.geometry.instanceCount += (n - at) * BLOCK; blocks.set(page, n);
      this.stats.visibleFaces += entry.count; this.stats.sourceDraws++;
      mesh.visible = false; this.hidden.push(mesh);
    }
    for (const page of [...this.pages]) {
      if (!page.entries.size) { this.disposePage(page); continue; }
      for (const mesh of page.runs) {
        if (!active.has(mesh)) { if (mesh.visible) this.root.needsUpdate = true; mesh.visible = false; }
        else if (mesh.geometry.instanceCount !== mesh.userData.voxelArenaOldCount) this.root.needsUpdate = true;
      }
      if (changed.has(page)) {
        const length = (blocks.get(page) ?? 0) * 8;
        page.map.clearUpdateRanges(); page.map.addUpdateRange(0, length); page.map.needsUpdate = true;
        this.stats.mapUploadBytes += length * 4;
      }
      this.stats.paddedFaces += (blocks.get(page) ?? 0) * BLOCK;
      this.stats.draws += runs.get(page) ?? 0;
    }
    this.stats.pages = this.pages.length;
  }
  dispose(restore = true) {
    this.restoreSources();
    for (const entry of this.entries.values()) this.remove(entry, restore && entry.mesh.parent === this.root);
    for (const page of [...this.pages]) this.disposePage(page);
    for (const [mesh, order] of this.orders) mesh.renderOrder = order;
    this.orders.clear(); this.root.needsUpdate = true;
  }
}
