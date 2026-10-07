import * as THREE from 'three/webgpu';
import { storage, vertexIndex, uint, float, vec2, vec3, varying, min, uniform, wgslFn } from 'three/tsl';
import { VOXEL_FACE_BLOCK, VOXEL_VISIBILITY_STRIDE, voxelBlockBackFacing } from './VoxelFaceVisibility.ts';
import { voxelHandoffMode } from './VoxelDrawCulling.ts';
import { orderVoxelPages } from './VoxelDrawOrder.ts';

export type VoxelFaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardNodeMaterial>;
export type ArenaInputs = { origin: any; offset: any; span: any; direction: any; emission: any; color: any; valid: any; quad: any };
const BLOCK = VOXEL_FACE_BLOCK;
const PAGE_FACES = 256 * 1024;
let quadIndices: Uint32Array | undefined;
function pageIndex(capacity: number) {
  if (!quadIndices || quadIndices.length < capacity * 6) {
    quadIndices = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const at = i * 6, vertex = i * 4;
      quadIndices[at] = vertex; quadIndices[at + 1] = vertex + 1; quadIndices[at + 2] = vertex + 2;
      quadIndices[at + 3] = vertex; quadIndices[at + 4] = vertex + 2; quadIndices[at + 5] = vertex + 3;
    }
  }
  // Each page owns one GPU index buffer; runs share its lifetime. The immutable
  // CPU template is shared without copying six megabytes for every page/run.
  return new THREE.BufferAttribute(quadIndices, 1);
}
export const ARENA_COPY_FACES = 16 * 1024;
export const ARENA_COPY_MS = .75;
const names = ['voxelOffset', 'voxelSpan', 'voxelDirection', 'voxelEmission', 'color'] as const;
const unpackColor = wgslFn('fn voxelArenaColor(value: u32) -> vec3<f32> { return unpack4x8unorm(value).xyz; }');
type Range = { start: number; count: number };
type Entry = Range & { mesh: VoxelFaceMesh; geometry: THREE.InstancedBufferGeometry; page: Page; allocated: number; copied: number;
  attributes?: THREE.BufferAttribute[]; versions: number[]; origin: THREE.Vector3;
  visibility?: { map: Float32Array; blocks: number; faces: number; view: number; mask: number; masked: boolean;
    back: number; outside: number; covered: number };
  invalid: boolean; releasing: boolean; onDispose: () => void };
type Page = { mesh: VoxelFaceMesh; runs: VoxelFaceMesh[]; entries: Set<Entry>; free: Range[];
  map: THREE.StorageBufferAttribute; data: THREE.StorageBufferAttribute; release: Set<() => void> };

/** Primary store for immutable, settled far faces. Records use 16 bytes instead
 * of 32-byte vertex attributes. Publication is bounded; incomplete/fading draws
 * retain their original attributes. Fully migrated sources release both their
 * CPU attributes and GPU buffers, and can reconstruct the reference path.
 * Page grouping preserves neighboring tile order and unmerged draw barriers,
 * so coplanar boundary faces retain their reference depth-test ordering. */
export class VoxelFaceArena {
  groupPageDraws = true;
  private groupedSources: VoxelFaceMesh[] = [];
  private groupedPages: object[] = [];
  private groupedOrder: VoxelFaceMesh[] = [];
  private previousGrouping = true;
  readonly pages: Page[] = [];
  private readonly entries = new Map<VoxelFaceMesh, Entry>();
  private readonly orders = new Map<VoxelFaceMesh, number>();
  private hidden: VoxelFaceMesh[] = [];
  private drawing: (Entry | VoxelFaceMesh)[] = [];
  private drawingMaterials: THREE.Material[] = [];
  private readonly camera = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private coverage: THREE.DataTexture | null = null;
  private coverageVersion = -1;
  private visibilityDirty = true;
  private visibilityEnabled = false;
  private viewEpoch = 0;
  private emptyFrustum = false;
  readonly stats = { residentFaces: 0, bytes: 0, visibleFaces: 0, paddedFaces: 0, draws: 0,
    sourceDraws: 0, mapUploadBytes: 0, copyFaces: 0, copyMs: 0, maxCopyMs: 0, pendingSources: 0,
    releasedSourceBytes: 0, pages: 0, backFaces: 0, outsideFaces: 0, coveredFaces: 0 };
  private readonly root: THREE.BundleGroup;
  private readonly make: (inputs: ArenaInputs) => VoxelFaceMesh;
  constructor(root: THREE.BundleGroup, make: (inputs: ArenaInputs) => VoxelFaceMesh) { this.root = root; this.make = make; }
  get hasPendingWork() { return this.stats.pendingSources > 0; }

  setView(camera: THREE.Vector3, frustum: THREE.Frustum, coverage: THREE.DataTexture, enabled: boolean) {
    // Retain a conservative guard around the last visibility query. Ordinary
    // motion then reuses GPU maps and command bundles instead of rebuilding
    // every face-block list each frame. The padding below bounds all accepted
    // camera translations, rotations and clip-plane offset changes.
    if (!this.coverage || camera.distanceToSquared(this.camera) >= 16 ** 2 || frustum.planes.some((p, i) => {
      const old = this.frustum.planes[i];
      return p.normal.distanceToSquared(old.normal) >= .06 ** 2
        || Math.abs(p.constant + p.normal.dot(camera) - old.constant - old.normal.dot(this.camera)) >= 1;
    })
      || enabled !== this.visibilityEnabled) {
      this.camera.copy(camera); this.frustum.copy(frustum); this.viewEpoch++;
      this.emptyFrustum = frustum.planes.some(p => p.normal.lengthSq() === 0 && p.constant < 0);
      this.visibilityEnabled = enabled; this.visibilityDirty = true;
    }
    const version = coverage.userData.voxelVisibilityVersion ?? coverage.version;
    if (coverage !== this.coverage || version !== this.coverageVersion) {
      this.coverage = coverage; this.coverageVersion = version; this.visibilityDirty = true;
    }
  }

  private culled(entry: Entry, block: number, masked: boolean) {
    const data = entry.geometry.userData.voxelVisibility as Float32Array | undefined;
    if (!this.visibilityEnabled || !data) return 0;
    if (this.emptyFrustum) return 2;
    const at = block * VOXEL_VISIBILITY_STRIDE;
    if (at + VOXEL_VISIBILITY_STRIDE > data.length) return 0;
    if (masked && this.coverage && voxelHandoffMode(this.coverage.image.data!, data, at + 8) === 2) return 3;
    const x = this.camera.x, y = this.camera.y, z = this.camera.z;
    if (voxelBlockBackFacing(data, at, x, y, z, 18)) return 1;
    // Nearby vertices receive view-local flattening, so their bent-space sphere
    // cannot reject them. The source draw retains its conservative view bounds.
    const distance = Math.hypot(x - data[at], y - data[at + 1], z - data[at + 2]);
    if (distance - data[at + 3] > 274) {
      for (const p of this.frustum.planes) if (p.normal.x * data[at] + p.normal.y * data[at + 1]
        + p.normal.z * data[at + 2] + p.constant < -data[at + 3] - 18 - distance * .061) return 2;
    }
    return 0;
  }

  private visibleBlocks(entry: Entry, masked: boolean) {
    const cached = entry.visibility;
    if (cached && cached.view === this.viewEpoch && cached.masked === masked
      && (!masked || cached.mask === this.coverageVersion)) return cached;
    const result = cached ?? { map: new Float32Array(Math.ceil(entry.count / BLOCK) * 8),
      blocks: 0, faces: 0, view: 0, mask: -1, masked, back: 0, outside: 0, covered: 0 };
    result.blocks = result.faces = result.back = result.outside = result.covered = 0;
    result.view = this.viewEpoch; result.mask = this.coverageVersion; result.masked = masked;
    for (let offset = 0; offset < entry.count; offset += BLOCK) {
      const count = Math.min(BLOCK, entry.count - offset), culled = this.culled(entry, offset / BLOCK, masked);
      if (culled) {
        if (culled === 1) result.back += count;
        else if (culled === 2) result.outside += count;
        else result.covered += count;
        continue;
      }
      const dst = result.blocks++ * 8, map = result.map;
      map[dst] = entry.start + offset; map[dst + 1] = count; map[dst + 2] = entry.origin.x;
      map[dst + 3] = entry.origin.y; map[dst + 4] = entry.origin.z; result.faces += count;
    }
    entry.visibility = result; return result;
  }

  private eligible(mesh: VoxelFaceMesh) {
    const range = mesh.userData.terrainCoverage;
    return !mesh.userData.voxelArena && mesh.geometry.instanceCount > 0
      && mesh.userData.voxelArenaCompatible === true
      && (!range || (range.x === 0 && range.y === 1))
      && (mesh.material === mesh.userData.opaqueMaterial || mesh.material === mesh.userData.maskedMaterial);
  }
  private createPage(capacity: number) {
    const data = new THREE.StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    // Two vec4s per block preserve the original local offset + origin arithmetic.
    const map = new THREE.StorageBufferAttribute(new Float32Array(capacity / BLOCK * 8), 4);
    const records = storage(data, 'uvec4' as 'vec4', capacity).toReadOnly();
    const remap = storage(map, 'vec4', capacity / BLOCK * 2).toReadOnly();
    const base = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaBase ?? 0);
    const faceIndex = vertexIndex.div(uint(4)), corner = vertexIndex.mod(uint(4));
    const blockIndex = faceIndex.div(uint(BLOCK)).add(base).mul(2);
    const block = remap.element(blockIndex), originZ = remap.element(blockIndex.add(1)).x;
    const local = faceIndex.mod(uint(BLOCK)), valid = local.lessThan(uint(block.y));
    const face = uint(block.x).add(uint(min(float(local), float(block.y).sub(1))));
    const record = records.element(face);
    const mesh = this.make({ origin: vec3(block.z, block.w, originZ),
      offset: vec3(float(uint(record.x).bitAnd(65535)), float(uint(record.x).shiftRight(16)), float(uint(record.y).bitAnd(65535))),
      span: vec3(float(uint(record.y).shiftRight(16)), float(uint(record.z).bitAnd(65535)), 0).xy,
      direction: float(uint(record.z).shiftRight(16).bitAnd(255)), emission: float(uint(record.z).shiftRight(24)),
      color: varying(unpackColor(uint(record.w))), valid,
      quad: vec2(float(corner.equal(1).or(corner.equal(2))), float(corner.greaterThanEqual(2))) });
    mesh.geometry.setIndex(pageIndex(capacity)); mesh.geometry.deleteAttribute('position'); mesh.geometry.deleteAttribute('normal');
    (mesh.geometry as any).isInstancedBufferGeometry = false; mesh.geometry.setDrawRange(0, 0);
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
    for (const material of new Set<THREE.Material>([page.mesh.material,
      page.mesh.userData.opaqueMaterial, page.mesh.userData.maskedMaterial].filter(Boolean))) material.dispose();
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
      if (!this.orders.has(mesh)) { this.orders.set(mesh, mesh.renderOrder); mesh.renderOrder = mesh.id; }
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
      this.stats.bytes += page.data.array.byteLength + page.map.array.byteLength + (page.mesh.geometry.index?.array.byteLength ?? 0);
      for(const entry of page.entries) if(!entry.attributes) {
        this.stats.residentFaces += entry.count; this.stats.releasedSourceBytes += entry.count * 32;
      }
    }
    this.stats.pages = this.pages.length;
    const drawing = sources.filter(mesh=>mesh.visible).map(mesh=>{
      const entry=this.entries.get(mesh);return entry && !entry.attributes ? entry : mesh;
    });
    const materials = drawing.map(item => 'page' in item ? item.mesh.material : item.material);
    const unchanged=!this.visibilityDirty && this.previousGrouping === this.groupPageDraws && drawing.length===this.drawing.length
      && drawing.every((item,i)=>item===this.drawing[i] && materials[i] === this.drawingMaterials[i]);
    this.drawing=drawing;
    this.drawingMaterials=materials;
    this.previousGrouping = this.groupPageDraws;
    if(unchanged) {
      for(const item of drawing) if('page' in item) {item.mesh.visible=false;this.hidden.push(item.mesh);}
      return;
    }
    this.visibilityDirty = false;
    Object.assign(this.stats,{visibleFaces:0,paddedFaces:0,draws:0,sourceDraws:0,backFaces:0,outsideFaces:0,coveredFaces:0});
    const blocks = new Map<Page, number>(), runs = new Map<Page, number>(), changed = new Set<Page>();
    let lastPage: Page | null = null, run: VoxelFaceMesh | null = null;
    let lastMaterial: THREE.Material | null = null;
    const active = new Set<VoxelFaceMesh>();
    const pageFor = (mesh: VoxelFaceMesh) => {
      const entry = this.entries.get(mesh); return entry && !entry.attributes ? entry.page : mesh;
    };
    if (this.groupPageDraws && (sources.length !== this.groupedSources.length
      || sources.some((mesh, i) => mesh !== this.groupedSources[i] || pageFor(mesh) !== this.groupedPages[i]))) {
      this.groupedSources = sources; this.groupedPages = sources.map(pageFor);
      this.groupedOrder = orderVoxelPages(sources, pageFor, mesh => mesh.userData.voxelTile);
    }
    const drawSources = this.groupPageDraws ? this.groupedOrder : sources;
    const ordered = this.groupPageDraws && drawSources.some(mesh => mesh.userData.voxelTile !== undefined);
    for (let drawIndex = 0; drawIndex < drawSources.length; drawIndex++) {
      const mesh = drawSources[drawIndex], drawOrder = ordered ? sources[0].id + drawIndex : mesh.id;
      mesh.renderOrder = drawOrder;
      if (!mesh.visible) continue;
      const entry = this.entries.get(mesh);
      if (!entry || entry.attributes) { lastPage = null; continue; }
      const page = entry.page, at = blocks.get(page) ?? 0;
      const masked = mesh.material === mesh.userData.maskedMaterial;
      const visible = this.visibleBlocks(entry, masked);
      this.stats.visibleFaces += visible.faces; this.stats.backFaces += visible.back;
      this.stats.outsideFaces += visible.outside; this.stats.coveredFaces += visible.covered;
      this.stats.sourceDraws++;
      mesh.visible = false; this.hidden.push(mesh);
      // An empty block list is no draw and must not split two otherwise
      // contiguous runs from the same page/material.
      if (!visible.blocks) continue;
      const drawMaterial = (masked ? page.mesh.userData.maskedMaterial : page.mesh.userData.opaqueMaterial) ?? page.mesh.material;
      if (lastPage !== page || lastMaterial !== drawMaterial) {
        const index = runs.get(page) ?? 0;
        if (!page.runs[index]) {
          const runGeometry = new THREE.InstancedBufferGeometry(); runGeometry.setIndex(page.mesh.geometry.index);
          const clone = new THREE.Mesh(runGeometry, drawMaterial);
          (clone.geometry as any).isInstancedBufferGeometry = false;
          clone.userData.voxelArena = true; clone.frustumCulled = false; clone.matrixAutoUpdate = false; clone.name = page.mesh.name;
          clone.onBeforeRender = page.mesh.onBeforeRender; page.runs.push(clone); this.root.add(clone);
        }
        run = page.runs[index]; runs.set(page, index + 1); active.add(run);
        if (run.userData.voxelArenaBase !== at || run.renderOrder !== drawOrder || !run.visible || run.material !== drawMaterial) this.root.needsUpdate = true;
        run.material = drawMaterial;
        run.userData.voxelArenaBase = at; run.renderOrder = drawOrder; run.visible = true;
        // Remember the old count before assembling this run.
        run.userData.voxelArenaOldCount = run.geometry.instanceCount; run.geometry.instanceCount = 0;
        lastPage = page;
        lastMaterial = drawMaterial;
      }
      const n = at + visible.blocks;
      if (visible.blocks) { page.map.array.set(visible.map.subarray(0, visible.blocks * 8), at * 8); changed.add(page); }
      run!.geometry.instanceCount += (n - at) * BLOCK; blocks.set(page, n);
    }
    for (const page of [...this.pages]) {
      if (!page.entries.size) { this.disposePage(page); continue; }
      for (const mesh of page.runs) {
        if (!active.has(mesh)) { if (mesh.visible) this.root.needsUpdate = true; mesh.visible = false; }
        else if (mesh.geometry.instanceCount !== mesh.userData.voxelArenaOldCount) this.root.needsUpdate = true;
        mesh.geometry.setDrawRange(0, mesh.geometry.instanceCount * 6);
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
