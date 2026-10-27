import * as THREE from 'three/webgpu';
import { storage, vertexIndex, instanceIndex, uint, float, vec2, vec3, varying, min, uniform, wgslFn } from 'three/tsl';
import { VOXEL_FACE_BLOCK, VOXEL_VISIBILITY_STRIDE } from './VoxelFaceVisibility.ts';
import { voxelHandoffMode } from './VoxelDrawCulling.ts';
import { orderVoxelPages } from './VoxelDrawOrder.ts';
import { getWorldProjection, getWorldProjectionRevision } from '../torus/TorusWorld.ts';
import { BACKFACE_PROXY_STRIDE, surfaceFacingProxy, surfaceBlockBackFacing } from './TorusBackfaceMath.ts';

export type VoxelFaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardNodeMaterial>;
export type ArenaInputs = { origin: any; offset: any; span: any; direction: any; emission: any; color: any; valid: any; quad: any };
const BLOCK = VOXEL_FACE_BLOCK;
const PAGE_FACES = 256 * 1024;
/** World coordinates fit Float64 squared distance. Share one distance between
 * the normal cone and frustum guards; retain view-local flattened geometry. */
function blockFacing(data: Float32Array, at: number, dx: number, dy: number, dz: number, distance: number, padding: number) {
  if (distance - data[at + 3] <= 256 + padding) return 2;
  return data[at + 4] * dx + data[at + 5] * dy + data[at + 6] * dz
    + distance * data[at + 7] + data[at + 3] + padding < 0 ? 1 : 0;
}
// r183 promotes non-normalized uint16 attributes (including indices) to uint32.
// Use the backend's actual representation so allocation accounting stays exact.
const blockIndexTemplates = new Map<number, Uint32Array>();
function blockIndex(faces: number) {
  let indices = blockIndexTemplates.get(faces);
  if (!indices) {
    indices = new Uint32Array(faces * 6);
    for (let i = 0; i < faces; i++) {
      const v = i * 4; indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    blockIndexTemplates.set(faces, indices);
  }
  return new THREE.BufferAttribute(indices, 1);
}
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
type BlockTests = { data: Float32Array; position: number; coverage: number;
  distance: Float64Array; facing: Uint8Array; covered: Uint8Array;
  sphere: THREE.Sphere; view: number; planeMask: number };
type Entry = Range & { mesh: VoxelFaceMesh; geometry: THREE.InstancedBufferGeometry; page: Page; allocated: number; copied: number;
  attributes?: THREE.BufferAttribute[]; versions: number[]; origin: THREE.Vector3;
  visibility?: { map: Float32Array; blocks: number; faces: number; view: number; mask: number; masked: boolean;
    back: number; outside: number; covered: number };
  blockTests?: BlockTests; invalid: boolean; releasing: boolean; onDispose: () => void };
type Page = { mesh: VoxelFaceMesh; runs: VoxelFaceMesh[]; entries: Set<Entry>; free: Range[];
  map: THREE.StorageBufferAttribute; data: THREE.StorageBufferAttribute; release: Set<() => void>;
  releaseMap: Set<(attribute: THREE.StorageBufferAttribute) => void> };

/** Primary store for immutable, settled far faces. Records use 16 bytes instead
 * of 32-byte vertex attributes. Publication is bounded; incomplete/fading draws
 * retain their original attributes. Fully migrated sources release both their
 * CPU attributes and GPU buffers, and can reconstruct the reference path.
 * Page grouping preserves neighboring tile order and unmerged draw barriers,
 * so coplanar boundary faces retain their reference depth-test ordering. */
export class VoxelFaceArena {
  private projectionRevision = getWorldProjectionRevision();
  groupPageDraws = true;
  incrementalMaintenance = true;
  private sources: VoxelFaceMesh[] = [];
  private sourceSet = new Set<VoxelFaceMesh>();
  private sourcesDirty = true;
  private maintenanceDirty = true;
  private readonly sourceMembershipChanged = (event: { child: THREE.Object3D }) => {
    if (!event.child.userData.voxelArena) this.sourcesDirty = this.maintenanceDirty = true;
  };
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
  private nextDrawing: (Entry | VoxelFaceMesh)[] = [];
  private nextMaterials: THREE.Material[] = [];
  private readonly camera = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private coverage: THREE.DataTexture | null = null;
  private coverageVersion = -1;
  private coverageEpoch = 0;
  private visibilityDirty = true;
  private visibilityEnabled = false;
  private viewEpoch = 0;
  private positionEpoch = 0;
  private resetView = true;
  // Slack covers the accepted translation, clip-plane offset and rounding.
  // The angular term bounds delta-normal dot (block-center - query-camera).
  private readonly viewReuse = { translation: 32, normal: .12, padding: 34, angular: .121 };
  private cachedBlockTests = true;
  private torusBackfaceCulling = false;
  private surfaceProxies = new WeakMap<Float32Array, Float64Array>();
  private blockInstancing = true;
  private instanceFaces = 32;
  // Experimental: far replay improves, but ordinary turning GPU spans regress.
  // Keep the original layout until the full-frame regression is resolved.
  private compactMaps = false;
  private emptyFrustum = false;
  readonly stats = { residentFaces: 0, bytes: 0, visibleFaces: 0, paddedFaces: 0, draws: 0,
    sourceDraws: 0, mapUploadBytes: 0, copyFaces: 0, copyMs: 0, maxCopyMs: 0, pendingSources: 0,
    releasedSourceBytes: 0, pages: 0, backFaces: 0, outsideFaces: 0, coveredFaces: 0,
    maintenancePasses: 0, sourceListBuilds: 0, blockCacheBytes: 0,
    positionBlockTests: 0, coverageBlockTests: 0, drawnFaces: 0, instancePaddingFaces: 0 };
  private readonly root: THREE.BundleGroup;
  private readonly make: (inputs: ArenaInputs) => VoxelFaceMesh;
  constructor(root: THREE.BundleGroup, make: (inputs: ArenaInputs) => VoxelFaceMesh) {
    this.root = root; this.make = make;
    root.addEventListener('childadded', this.sourceMembershipChanged);
    root.addEventListener('childremoved', this.sourceMembershipChanged);
  }
  get hasPendingWork() { return this.stats.pendingSources > 0; }

  /** Reference controls for identical-world development comparisons. */
  setViewOptimizationsEnabled(cached: boolean) {
    if (cached === this.cachedBlockTests) return;
    this.cachedBlockTests = cached; this.resetView = true;
  }
  getViewOptimizations() { return { cached: this.cachedBlockTests }; }

  /** Optional lossy far-terrain filter. Never allocates proxies while off. */
  setTorusBackfaceCullingEnabled(enabled: boolean) {
    if (enabled === this.torusBackfaceCulling) return;
    this.torusBackfaceCulling = enabled;
    if (!enabled) this.surfaceProxies = new WeakMap();
    // Restore original facing flags and maps even when the camera is stationary.
    this.positionEpoch++; this.viewEpoch++; this.resetView = this.visibilityDirty = true;
    this.root.needsUpdate = true;
  }

  private surfaceProxy(data: Float32Array) {
    let proxy = this.surfaceProxies.get(data);
    if (!proxy) {
      const blocks = Math.floor(data.length / VOXEL_VISIBILITY_STRIDE);
      proxy = new Float64Array(blocks * BACKFACE_PROXY_STRIDE);
      for (let block = 0; block < blocks; block++) {
        const at = block * VOXEL_VISIBILITY_STRIDE;
        surfaceFacingProxy(data[at + 8], data[at + 9], data[at + 10], data[at + 11],
          data[at], data[at + 1], data[at + 2], proxy, block * BACKFACE_PROXY_STRIDE);
      }
      this.surfaceProxies.set(data, proxy);
    }
    return proxy;
  }

  /** Reuse one indexed group across visibility blocks; the reference retains a
   * page-wide index list. Real triangles keep their order; tail padding collapses. */
  setBlockInstancingEnabled(enabled: boolean, faces = 32) {
    if (!Number.isInteger(faces) || faces < BLOCK || faces > 1024 || faces % BLOCK !== 0) throw new Error('Invalid Arena instance face count.');
    if (this.blockInstancing === enabled && this.instanceFaces === faces) return;
    this.blockInstancing = enabled; this.instanceFaces = faces;
    for (const page of this.pages) {
      const index = enabled ? blockIndex(faces) : pageIndex(page.data.count);
      for (const mesh of page.runs) {
        mesh.geometry.dispose(); mesh.geometry.setIndex(index); this.updateDrawRange(mesh);
      }
    }
    this.rebuildDrawingMaterials();
    this.maintenanceDirty = this.visibilityDirty = true; this.root.needsUpdate = true;
  }
  getBlockInstancingEnabled() { return this.blockInstancing; }
  /** Same-load GPU reference: replace only the mapping layout, never face data.
   * Only the selected layout is allocated. Old GPU maps are retired
   * immediately; a reference toggle must not accumulate hidden allocations. */
  setCompactMapsEnabled(enabled: boolean) {
    if (this.compactMaps === enabled) return;
    this.compactMaps = enabled;
    for (const page of this.pages) {
      const previous = page.map;
      page.map = this.createMap(page.data.count);
      for (const release of page.releaseMap) release(previous);
      for (const entry of page.entries) entry.visibility = undefined;
    }
    this.rebuildDrawingMaterials();
    this.maintenanceDirty = this.visibilityDirty = true; this.root.needsUpdate = true;
  }
  getCompactMapsEnabled() { return this.compactMaps; }
  private get mapStride() { return this.compactMaps ? 4 : 8; }
  private createMap(capacity: number) {
    return new THREE.StorageBufferAttribute(new Float32Array(capacity / BLOCK * this.mapStride), 4);
  }
  getInstanceFaces() { return this.instanceFaces; }
  /** The development topology switch preserves face records and visibility
   * maps while replacing shader inputs and retiring the old pipelines. */
  private rebuildDrawingMaterials() {
    for (const page of this.pages) {
      const oldOpaque = page.mesh.userData.opaqueMaterial ?? page.mesh.material;
      const oldMasked = page.mesh.userData.maskedMaterial;
      const replacement = this.createDrawingMesh(page.data, page.map);
      const opaque = replacement.userData.opaqueMaterial ?? replacement.material;
      const masked = replacement.userData.maskedMaterial;
      for (const mesh of page.runs) mesh.material = oldMasked && mesh.material === oldMasked ? masked : opaque;
      page.mesh.userData.opaqueMaterial = opaque; page.mesh.userData.maskedMaterial = masked;
      replacement.geometry.dispose();
      for (const material of new Set<THREE.Material>([oldOpaque, oldMasked].filter(Boolean))) material.dispose();
    }
  }
  private updateDrawRange(mesh: VoxelFaceMesh) {
    const faces = mesh.userData.voxelArenaFaces ?? 0;
    (mesh.geometry as any).isInstancedBufferGeometry = this.blockInstancing;
    mesh.geometry.instanceCount = this.blockInstancing ? Math.ceil(faces / this.instanceFaces) : faces;
    mesh.geometry.setDrawRange(0, this.blockInstancing ? this.instanceFaces * 6 : faces * 6);
  }

  setView(camera: THREE.Vector3, frustum: THREE.Frustum, coverage: THREE.DataTexture, enabled: boolean) {
    if (this.projectionRevision !== getWorldProjectionRevision()) {
      this.projectionRevision = getWorldProjectionRevision();
      this.resetView = true;
      this.positionEpoch++;
    }
    // Retain a conservative guard around the last visibility query. Ordinary
    // motion then reuses GPU maps and command bundles instead of rebuilding
    // every face-block list each frame. The padding below bounds all accepted
    // camera translations, rotations and clip-plane offset changes.
    const empty = frustum.planes.some(p => p.normal.x === 0 && p.normal.y === 0 && p.normal.z === 0 && p.constant < 0);
    if (this.resetView || !this.coverage || empty !== this.emptyFrustum
      || camera.distanceToSquared(this.camera) >= this.viewReuse.translation ** 2 || frustum.planes.some((p, i) => {
      const old = this.frustum.planes[i];
      return p.normal.distanceToSquared(old.normal) >= this.viewReuse.normal ** 2
        || Math.abs(p.constant + p.normal.dot(camera) - old.constant - old.normal.dot(this.camera)) >= 1;
    })
      || enabled !== this.visibilityEnabled) {
      if (!this.camera.equals(camera)) this.positionEpoch++;
      this.resetView = false;
      this.camera.copy(camera); this.frustum.copy(frustum); this.viewEpoch++;
      this.emptyFrustum = empty;
      this.visibilityEnabled = enabled; this.visibilityDirty = true;
    }
    const version = coverage.userData.voxelVisibilityVersion ?? coverage.version;
    if (coverage !== this.coverage || version !== this.coverageVersion) {
      this.coverage = coverage; this.coverageVersion = version; this.visibilityDirty = true;
      this.coverageEpoch++;
    }
  }

  private visibilityData(entry: Entry): Float32Array | undefined {
    const mode = entry.geometry.userData.voxelProjection ?? 'torus';
    return mode === getWorldProjection() ? entry.geometry.userData.voxelVisibility : undefined;
  }

  private culled(entry: Entry, block: number, masked: boolean) {
    const data = this.visibilityData(entry);
    if (!this.visibilityEnabled || !data) return 0;
    if (this.emptyFrustum) return 2;
    const at = block * VOXEL_VISIBILITY_STRIDE;
    if (at + VOXEL_VISIBILITY_STRIDE > data.length) return 0;
    if (masked && this.coverage && voxelHandoffMode(this.coverage.image.data!, data, at + 8) === 2) return 3;
    const x = this.camera.x, y = this.camera.y, z = this.camera.z;
    const dx = x - data[at], dy = y - data[at + 1], dz = z - data[at + 2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz), { padding, angular } = this.viewReuse;
    const facing = blockFacing(data, at, dx, dy, dz, distance, padding);
    if (facing === 1) return 1;
    // Nearby vertices receive view-local flattening, so their bent-space sphere
    // cannot reject them. The source draw retains its conservative view bounds.
    if (this.torusBackfaceCulling && getWorldProjection() === 'torus'
      && surfaceBlockBackFacing(this.surfaceProxy(data), block * BACKFACE_PROXY_STRIDE,
        x, y, z, distance, data[at + 3], padding)) return 1;
    if (facing !== 2) {
      for (const p of this.frustum.planes) if (p.normal.x * data[at] + p.normal.y * data[at + 1]
        + p.normal.z * data[at + 2] + p.constant < -data[at + 3] - padding - distance * angular) return 2;
    }
    return 0;
  }

  /** Rotation cannot change distance, normal-cone facing, or flat ownership.
   * Keep those exact tests until their position/coverage inputs change. */
  private prepareBlockTests(entry: Entry, masked: boolean): BlockTests | undefined {
    const data = this.visibilityData(entry);
    if (!this.cachedBlockTests || !this.visibilityEnabled || !data) return;
    let cache = entry.blockTests;
    if (!cache || cache.data !== data) {
      if (cache) this.stats.blockCacheBytes -= cache.distance.byteLength + cache.facing.byteLength + cache.covered.byteLength;
      const blocks = Math.ceil(entry.count / BLOCK);
      cache = entry.blockTests = { data, position: -1, coverage: -1,
        distance: new Float64Array(blocks), facing: new Uint8Array(blocks), covered: new Uint8Array(blocks),
        sphere: new THREE.Sphere(), view: -1, planeMask: 63 };
      this.stats.blockCacheBytes += cache.distance.byteLength + cache.facing.byteLength + cache.covered.byteLength;
      // Enclose every block sphere. Whole-entry plane acceptance/rejection can
      // then avoid repeated plane tests without changing any block decision.
      const bounds = new THREE.Box3(), point = new THREE.Vector3();
      for (let at = 0; at + VOXEL_VISIBILITY_STRIDE <= data.length; at += VOXEL_VISIBILITY_STRIDE) {
        const radius = data[at + 3];
        bounds.expandByPoint(point.set(data[at] - radius, data[at + 1] - radius, data[at + 2] - radius));
        bounds.expandByPoint(point.set(data[at] + radius, data[at + 1] + radius, data[at + 2] + radius));
      }
      bounds.getBoundingSphere(cache.sphere); cache.sphere.radius += .001;
    }
    const count = Math.min(cache.distance.length, Math.floor(data.length / VOXEL_VISIBILITY_STRIDE));
    if (cache.position !== this.positionEpoch) {
      const { x, y, z } = this.camera, { padding } = this.viewReuse;
      const surface = this.torusBackfaceCulling && getWorldProjection() === 'torus'
        ? this.surfaceProxy(data) : undefined;
      for (let block = 0; block < count; block++) {
        const at = block * VOXEL_VISIBILITY_STRIDE;
        const dx = x - data[at], dy = y - data[at + 1], dz = z - data[at + 2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        cache.distance[block] = distance;
        cache.facing[block] = blockFacing(data, at, dx, dy, dz, distance, padding);
        if (surface && cache.facing[block] !== 1 && surfaceBlockBackFacing(surface,
          block * BACKFACE_PROXY_STRIDE, x, y, z, distance, data[at + 3], padding)) cache.facing[block] = 1;
      }
      cache.position = this.positionEpoch; this.stats.positionBlockTests += count;
    }
    if (masked && cache.coverage !== this.coverageEpoch) {
      for (let block = 0; block < count; block++) cache.covered[block] = this.coverage
        && voxelHandoffMode(this.coverage.image.data!, data, block * VOXEL_VISIBILITY_STRIDE + 8) === 2 ? 1 : 0;
      cache.coverage = this.coverageEpoch; this.stats.coverageBlockTests += count;
    }
    if (cache.view !== this.viewEpoch) {
      const { center, radius } = cache.sphere, distance = center.distanceTo(this.camera);
      const margin = this.viewReuse.padding + (distance + radius) * this.viewReuse.angular;
      cache.planeMask = 0;
      for (let plane = 0; plane < 6; plane++) {
        const p = this.frustum.planes[plane], value = p.distanceToPoint(center);
        // Match the reference even for non-unit planes supplied by tests or
        // custom cameras. Standard camera frustum planes are normalized.
        const extent = radius * Math.max(1, p.normal.length());
        if (value + extent + margin < 0) { cache.planeMask = -1; break; }
        if (!(value - extent >= 0)) cache.planeMask |= 1 << plane;
      }
      cache.view = this.viewEpoch;
    }
    return cache;
  }

  private culledCached(cache: BlockTests, block: number, masked: boolean) {
    if (this.emptyFrustum) return 2;
    const at = block * VOXEL_VISIBILITY_STRIDE, data = cache.data;
    if (at + VOXEL_VISIBILITY_STRIDE > data.length) return 0;
    if (masked && cache.covered[block]) return 3;
    if (cache.facing[block] === 1) return 1;
    if (cache.facing[block] === 2) return 0;
    if (cache.planeMask === -1) return 2;
    if (cache.planeMask === 0) return 0;
    const margin = -data[at + 3] - this.viewReuse.padding - cache.distance[block] * this.viewReuse.angular;
    for (let i = 0; i < 6; i++) if (cache.planeMask & (1 << i)) {
      const p = this.frustum.planes[i];
      if (p.normal.x * data[at] + p.normal.y * data[at + 1] + p.normal.z * data[at + 2] + p.constant < margin) return 2;
    }
    return 0;
  }

  private visibleBlocks(entry: Entry, masked: boolean) {
    const cached = entry.visibility;
    if (cached && cached.view === this.viewEpoch && cached.masked === masked
      && (!masked || cached.mask === this.coverageEpoch)) return cached;
    const result = cached ?? { map: new Float32Array(Math.ceil(entry.count / BLOCK) * this.mapStride),
      blocks: 0, faces: 0, view: 0, mask: -1, masked, back: 0, outside: 0, covered: 0 };
    result.blocks = result.faces = result.back = result.outside = result.covered = 0;
    result.view = this.viewEpoch; result.mask = this.coverageEpoch; result.masked = masked;
    const tests = this.prepareBlockTests(entry, masked);
    for (let offset = 0; offset < entry.count; offset += BLOCK) {
      const count = Math.min(BLOCK, entry.count - offset), culled = tests
        ? this.culledCached(tests, offset / BLOCK, masked) : this.culled(entry, offset / BLOCK, masked);
      if (culled) {
        if (culled === 1) result.back += count;
        else if (culled === 2) result.outside += count;
        else result.covered += count;
        continue;
      }
      const dst = result.blocks++ * this.mapStride, map = result.map;
      if (this.compactMaps) {
        // A page has 2^18 faces. Five low bits hold the 1..16 face count;
        // the combined integer stays below 2^23 and is exact in Float32.
        map[dst] = (entry.start + offset) * 32 + count;
        map[dst + 1] = entry.origin.x; map[dst + 2] = entry.origin.y; map[dst + 3] = entry.origin.z;
      } else {
        map[dst] = entry.start + offset; map[dst + 1] = count; map[dst + 2] = entry.origin.x;
        map[dst + 3] = entry.origin.y; map[dst + 4] = entry.origin.z;
      }
      result.faces += count;
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
  private createDrawingMesh(data: THREE.StorageBufferAttribute, map: THREE.StorageBufferAttribute) {
    const capacity = data.count;
    const records = storage(data, 'uvec4' as 'vec4', capacity).toReadOnly();
    const remap = storage(map, 'vec4', capacity / BLOCK * this.mapStride / 4).toReadOnly();
    const base = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaBase ?? 0);
    const runFaces = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaFaces ?? 0);
    const faceIndex = this.blockInstancing ? vertexIndex.div(uint(4)).add(instanceIndex.mul(uint(this.instanceFaces))) : vertexIndex.div(uint(4));
    const boundedFace = this.blockInstancing ? uint(min(float(faceIndex), float(runFaces).sub(1))) : faceIndex;
    const corner = vertexIndex.mod(uint(4));
    const blockIndex = boundedFace.div(uint(BLOCK)).add(base).mul(this.compactMaps ? 1 : 2);
    const block = remap.element(blockIndex);
    const origin = this.compactMaps ? block.yzw : vec3(block.z, block.w, remap.element(blockIndex.add(1)).x);
    const blockFaces = this.compactMaps ? float(uint(block.x).bitAnd(31)) : block.y;
    const blockStart = this.compactMaps ? uint(block.x).shiftRight(5) : uint(block.x);
    const local = boundedFace.mod(uint(BLOCK));
    const valid = this.blockInstancing ? local.lessThan(uint(blockFaces)).and(faceIndex.lessThan(runFaces)) : local.lessThan(uint(blockFaces));
    const face = blockStart.add(uint(min(float(local), float(blockFaces).sub(1))));
    const record = records.element(face);
    return this.make({ origin,
      offset: vec3(float(uint(record.x).bitAnd(65535)), float(uint(record.x).shiftRight(16)), float(uint(record.y).bitAnd(65535))),
      span: vec3(float(uint(record.y).shiftRight(16)), float(uint(record.z).bitAnd(65535)), 0).xy,
      direction: float(uint(record.z).shiftRight(16).bitAnd(255)), emission: float(uint(record.z).shiftRight(24)),
      color: varying(unpackColor(uint(record.w))), valid,
      quad: vec2(float(corner.equal(1).or(corner.equal(2))), float(corner.greaterThanEqual(2))) });
  }
  private createPage(capacity: number) {
    const data = new THREE.StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    // Address/count plus the original xyz origin fit in one vec4. Position
    // arithmetic stays local offset + origin, including nonzero origin.y.
    const map = this.createMap(capacity);
    const mesh = this.createDrawingMesh(data, map);
    mesh.geometry.setIndex(this.blockInstancing ? blockIndex(this.instanceFaces) : pageIndex(capacity));
    mesh.geometry.deleteAttribute('position'); mesh.geometry.deleteAttribute('normal');
    this.updateDrawRange(mesh);
    mesh.userData.voxelArena = true; mesh.name = 'DistantVoxelArena'; mesh.visible = false;
    const page: Page = { mesh, runs: [mesh], entries: new Set(), free: [{ start: 0, count: capacity }],
      map, data, release: new Set(), releaseMap: new Set() };
    const renderers = new WeakSet<object>();
    mesh.onBeforeRender = renderer => {
      if (renderers.has(renderer)) return;
      renderers.add(renderer);
      // r183 omits node-only storage attributes from geometry disposal.
      const attributes = (renderer as any)._attributes;
      if (attributes) {
        page.releaseMap.add(attribute => attributes.delete(attribute));
        page.release.add(() => { attributes.delete(data); attributes.delete(page.map); });
      }
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
      releasing: false, onDispose: () => {
        if (!entry.releasing) { entry.invalid = true; this.maintenanceDirty = true; }
      } };
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
    if (entry.blockTests) {
      const cache = entry.blockTests;
      this.stats.blockCacheBytes -= cache.distance.byteLength + cache.facing.byteLength + cache.covered.byteLength;
      entry.blockTests = undefined;
    }
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
    for (const release of page.release) release(); page.release.clear(); page.releaseMap.clear();
    this.pages.splice(this.pages.indexOf(page), 1);
  }
  restoreSources() {
    for (const mesh of this.hidden) mesh.visible = true;
    this.hidden.length = 0;
  }
  idle() { this.stats.copyFaces = this.stats.copyMs = this.stats.mapUploadBytes = 0; }
  /** visibilityOnly is used by the owner only when no geometry, origin, material
   * eligibility or transition changed. Public/default calls validate everything. */
  sync(budgetMs = ARENA_COPY_MS, budgetFaces = ARENA_COPY_FACES, visibilityOnly = false) {
    if (this.sourcesDirty || !this.incrementalMaintenance) {
      this.sources = (this.root.children as VoxelFaceMesh[]).filter(mesh => !mesh.userData.voxelArena).sort((a, b) => a.id - b.id);
      this.sourceSet = new Set(this.sources); this.sourcesDirty = false;
      this.stats.sourceListBuilds++;
    }
    const sources = this.sources, sourceSet = this.sourceSet;
    if (!this.incrementalMaintenance || !visibilityOnly || this.maintenanceDirty || this.hasPendingWork) {
      this.maintenanceDirty = false; this.stats.maintenancePasses++;
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
    } else this.idle();
    const drawing = this.incrementalMaintenance ? this.nextDrawing : sources.filter(mesh => mesh.visible).map(mesh => {
      const entry = this.entries.get(mesh); return entry && !entry.attributes ? entry : mesh;
    });
    const materials = this.incrementalMaintenance ? this.nextMaterials
      : drawing.map(item => 'page' in item ? item.mesh.material : item.material);
    if (this.incrementalMaintenance) {
      drawing.length = materials.length = 0;
      for (const mesh of sources) if (mesh.visible) {
        const entry = this.entries.get(mesh);
        drawing.push(entry && !entry.attributes ? entry : mesh); materials.push(mesh.material);
      }
    }
    const unchanged=!this.visibilityDirty && this.previousGrouping === this.groupPageDraws && drawing.length===this.drawing.length
      && drawing.every((item,i)=>item===this.drawing[i] && materials[i] === this.drawingMaterials[i]);
    this.nextDrawing = this.drawing; this.nextMaterials = this.drawingMaterials;
    this.drawing=drawing; this.drawingMaterials=materials;
    this.previousGrouping = this.groupPageDraws;
    if(unchanged) {
      for(const item of drawing) if('page' in item) {item.mesh.visible=false;this.hidden.push(item.mesh);}
      return;
    }
    this.visibilityDirty = false;
    Object.assign(this.stats,{visibleFaces:0,paddedFaces:0,drawnFaces:0,instancePaddingFaces:0,draws:0,sourceDraws:0,backFaces:0,outsideFaces:0,coveredFaces:0});
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
          this.updateDrawRange(clone);
          clone.userData.voxelArena = true; clone.frustumCulled = false; clone.matrixAutoUpdate = false; clone.name = page.mesh.name;
          clone.onBeforeRender = page.mesh.onBeforeRender; page.runs.push(clone); this.root.add(clone);
        }
        run = page.runs[index]; runs.set(page, index + 1); active.add(run);
        if (run.userData.voxelArenaBase !== at || run.renderOrder !== drawOrder || !run.visible || run.material !== drawMaterial) this.root.needsUpdate = true;
        run.material = drawMaterial;
        run.userData.voxelArenaBase = at; run.renderOrder = drawOrder; run.visible = true;
        // Remember the old count before assembling this run.
        run.userData.voxelArenaOldCount = run.userData.voxelArenaFaces ?? 0; run.userData.voxelArenaFaces = 0;
        lastPage = page;
        lastMaterial = drawMaterial;
      }
      const n = at + visible.blocks;
      if (visible.blocks) { page.map.array.set(visible.map.subarray(0, visible.blocks * this.mapStride), at * this.mapStride); changed.add(page); }
      run!.userData.voxelArenaFaces += (n - at) * BLOCK; blocks.set(page, n);
    }
    for (const page of [...this.pages]) {
      if (!page.entries.size) { this.disposePage(page); continue; }
      for (const mesh of page.runs) {
        if (!active.has(mesh)) { if (mesh.visible) this.root.needsUpdate = true; mesh.visible = false; }
        else if (mesh.userData.voxelArenaFaces !== mesh.userData.voxelArenaOldCount) this.root.needsUpdate = true;
        this.updateDrawRange(mesh);
        if (active.has(mesh)) this.stats.drawnFaces += this.blockInstancing
          ? mesh.geometry.instanceCount * this.instanceFaces : mesh.userData.voxelArenaFaces;
      }
      if (changed.has(page)) {
        const length = (blocks.get(page) ?? 0) * this.mapStride;
        page.map.clearUpdateRanges(); page.map.addUpdateRange(0, length); page.map.needsUpdate = true;
        this.stats.mapUploadBytes += length * 4;
      }
      this.stats.paddedFaces += (blocks.get(page) ?? 0) * BLOCK;
      this.stats.draws += runs.get(page) ?? 0;
    }
    this.stats.instancePaddingFaces = this.stats.drawnFaces - this.stats.paddedFaces;
    this.stats.pages = this.pages.length;
  }
  dispose(restore = true) {
    this.root.removeEventListener('childadded', this.sourceMembershipChanged);
    this.root.removeEventListener('childremoved', this.sourceMembershipChanged);
    this.restoreSources();
    for (const entry of this.entries.values()) this.remove(entry, restore && entry.mesh.parent === this.root);
    for (const page of [...this.pages]) this.disposePage(page);
    for (const [mesh, order] of this.orders) mesh.renderOrder = order;
    this.orders.clear(); this.root.needsUpdate = true;
    this.sources = []; this.sourceSet.clear(); this.sourcesDirty = this.maintenanceDirty = true;
    this.surfaceProxies = new WeakMap();
  }
}
