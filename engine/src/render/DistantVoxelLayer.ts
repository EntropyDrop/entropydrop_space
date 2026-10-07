import * as THREE from 'three/webgpu';
import { VoxelFaceArena, type ArenaInputs } from './VoxelFaceArena.ts';
import { SurfaceBatch } from './SurfaceBatch.ts';
import { alignedInstanceAttribute, terrainCoverage, terrainDither, discardWhen } from './NodeMaterials.ts';
import { Fn, attribute, uniform, reference, vec2, vec3, vec4, positionGeometry, varying, float, screenCoordinate, output } from 'three/tsl';
import { createVoxelEmissionMaskUniform, voxelEmissionColor } from './VoxelEmission.ts';
import { computeBentBoundsSphere, hookSceneMaterials, projectBentSphereForView } from '../torus/TorusWorld.ts';
import { voxelHandoffMode } from './VoxelDrawCulling.ts';
import { VoxelLodPlanner, type VoxelLodTile, type VoxelLodView } from './VoxelLodPlanner.ts';
import { createCooperativeVoxelLodPort, createWorkerVoxelLodPort, type VoxelLodPort, type VoxelLodResponse } from './VoxelLodService.ts';
import type { SurfaceZoneSnapshot, VoxelSurfaceMip } from '../voxel/SurfaceZoneSnapshot.ts';

type FaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardNodeMaterial>;
// Worker transport uses 15 bytes per face, plus block visibility metadata.
// Aligned publication attributes use 32 bytes per face.
export const MAX_VOXEL_LOD_FACES = 4 * 1024 * 1024;
export const VOXEL_GPU_BYTES_PER_FACE = 32;
// Settled pages use 16-byte records, 24-byte quad indices and 2-byte block maps
// per face. Reserve some page slack; transition/CPU copies remain extra.
export const VOXEL_RESIDENT_BYTES_PER_FACE = 48;
export const voxelFaceBudget = (mib: number) => Math.floor(mib * 1024 * 1024 / VOXEL_RESIDENT_BYTES_PER_FACE);

function geometry() {
  const result = new THREE.InstancedBufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
  result.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0, 0,1,0], 3));
  result.setIndex([0,1,2,0,2,3]); result.instanceCount = 0;
  return result;
}
const opaqueMaterials = new WeakMap<THREE.DataTexture, THREE.MeshStandardNodeMaterial>();
const voxelMaterials = new WeakMap<THREE.DataTexture, THREE.MeshStandardNodeMaterial>();
function material(mask: THREE.DataTexture, coverage: THREE.Vector2, origin: THREE.Vector3,
  optimized: { value: boolean }, solid = false, arena?: ArenaInputs) {
  const cache = solid ? opaqueMaterials : voxelMaterials;
  const cached = cache.get(mask);
  if (cached && !arena) return cached;
  const result = new THREE.MeshStandardNodeMaterial({ vertexColors: !arena, roughness: .65, metalness: .15 });
  const emissionMask = createVoxelEmissionMaskUniform(result);
  const dir = arena?.direction ?? attribute<'float'>('voxelDirection', 'float');
  const normal = dir.lessThan(2).select(vec3(1,0,0), dir.lessThan(4).select(vec3(0,1,0), vec3(0,0,1))).mul(dir.mod(2).mul(2).sub(1));
  const flat = Fn(() => {
    const uv = (arena?.quad ?? positionGeometry.xy).toVar();
    uv.x.assign(dir.mod(2).lessThan(.5).select(uv.x.oneMinus(), uv.x));
    const p = uv.mul(arena?.span ?? attribute<'vec2'>('voxelSpan', 'vec2')).mul(.125);
    return (arena?.origin ?? uniform(new THREE.Vector3()).onObjectUpdate(({object}) => object?.userData.voxelOrigin ?? origin)).add((arena?.offset ?? attribute<'vec3'>('voxelOffset', 'vec3')).mul(.125)).add(
      dir.lessThan(2).select(vec3(0,p.x,p.y), dir.lessThan(4).select(vec3(p.y,0,p.x), vec3(p.x,p.y,0))));
  })();
  result.positionNode = arena ? arena.valid.select(flat, vec3(0)) : flat;
  if (arena) result.colorNode = arena.color;
  result.userData.flatNormalNode = normal;
  // A separate pipeline without discard avoids handoff sampling/dithering and
  // lets the GPU reject hidden fragments early. Only proven unowned, settled
  // generations use it; mixed ownership and both sides of a fade stay masked.
  if (!solid) {
    const handoff = terrainCoverage(mask, flat.xz.sub(normal.xz.mul(.01)));
    const unoptimized = reference('value', 'bool', optimized).not();
    const mode = uniform(1).onObjectUpdate(({object}) => object?.userData.voxelHandoffMode?.value ?? 1);
    discardWhen(result, unoptimized.or(mode.greaterThan(.5))
      .and(handoff.g.greaterThan(.5).or(terrainDither().lessThan(handoff.r))));
    const transition = terrainDither(screenCoordinate.xy.add(vec2(37,19)));
    const range = uniform(new THREE.Vector2(0,1)).onObjectUpdate(({object}) => object?.userData.terrainCoverage ?? coverage);
    discardWhen(result, transition.lessThan(range.x).or(transition.greaterThanEqual(range.y)));
  }
  const emission = varying(float(arena?.emission ?? attribute<'float'>('voxelEmission', 'float'))).greaterThan(.5);
  result.outputNode = emission.select(vec4(voxelEmissionColor(arena?.color ?? attribute<'vec3'>('color', 'vec3')),
    reference('value', 'float', emissionMask).add(1)), output);
  result.userData.sharedTerrainMaterial = true;
  result.userData.voxelArenaPosition = true;
  result.userData.voxelIntegerCoordinates = true;
  if (!arena) {
    mask.addEventListener('dispose', () => result.dispose());
    cache.set(mask, result);
  }
  return result;
}

export const VOXEL_PUBLICATION_BUDGET_MS = 1.25;
export const VOXEL_PUBLICATION_BUDGET_BYTES = 1024 * 1024;
const SOURCE_PART_BYTES = 256 * 1024;
type RenderZone = { snapshot: SurfaceZoneSnapshot; token: number; readyMask: number; batches: Map<number, SurfaceBatch> };
type SourceUpload = { zone: RenderZone; level: number; offset: number; started: boolean };
type DrawState = { tight: THREE.Sphere; flatBounds: readonly number[]; looseFlatBounds: readonly number[];
  maskVersion: number; transitioning: boolean; inView: boolean; handoffMode: { value: number } };
export type VoxelLodOptions = { synchronous?: boolean; workerFactory?: () => VoxelLodPort };

/** Resident geometry is independent of camera rotation. Browser selection,
 * indexing and packing run in a worker; only bounded publication touches Three. */
export class DistantVoxelLayer {
  readonly group = new THREE.BundleGroup();
  private readonly submittedState = new WeakMap<FaceMesh, { visible: boolean; material: THREE.Material; version: number; count: number }>();
  private readonly zones = new Map<string, RenderZone>();
  private readonly cullCamera = new THREE.Vector3();
  private readonly cullFrustum = new THREE.Frustum();
  private readonly projectedBounds = new THREE.Sphere();
  private readonly drawStates = new WeakMap<SurfaceBatch, DrawState>();
  private readonly drawOptimizations = { value: true };
  private drawCullingEnabled = true;
  private opaqueFastPath = true;
  private arena: VoxelFaceArena | null = null;
  private arenaDirty = true;
  private maskVersion = -1;
  private cullDirty = true;
  private readonly view: VoxelLodView = { camera: [0, 0, 0], focal: 720, area: 16,
    distance: 32768, faceBudget: MAX_VOXEL_LOD_FACES, hasView: false };
  private readonly uploads = new Map<string, SourceUpload>();
  private readonly sharedSources = new Map<VoxelSurfaceMip[], { key: string; token: number }>();
  private packet: { id: number; tiles: (VoxelLodTile | null)[] } | null = null;
  private readonly synchronous: boolean;
  private readonly planner: VoxelLodPlanner | null;
  private port: VoxelLodPort | null = null;
  private fallback = false;
  private halted = false;
  private active = true;
  private dirty = false;
  private busy = false;
  private nextToken = 0;
  private requestId = 0;
  private hasWorkerSources = false;
  private readonly options: VoxelLodOptions;
  private readonly mask: THREE.DataTexture;

  constructor(mask: THREE.DataTexture, options: VoxelLodOptions = {}) {
    this.mask = mask; this.options = options;
    this.synchronous = options.synchronous ?? (typeof window === 'undefined' && !options.workerFactory);
    this.planner = this.synchronous ? new VoxelLodPlanner() : null;
    this.group.name = 'DistantVoxelTerrain';
    this.group.userData.spaceOpaqueTerrain = true;
    this.setCommandCachingEnabled(false);
    this.group.addEventListener('childadded', () => { this.group.needsUpdate = true; this.arenaDirty = true; });
    this.group.addEventListener('childremoved', () => { this.group.needsUpdate = true; this.arenaDirty = true; });
    this.group.userData.voxelLodWorkStats = { backend: this.synchronous ? 'synchronous' : 'starting',
      publications: 0, pendingTiles: 0, queuedSources: 0, workMs: 0, publicationBytes: 0,
      sourceBytes: 0, oversizedTiles: 0, error: '' };
  }

  // Pending sources must not claim far coverage before their meshes exist.
  hasZone(x: number, z: number) { return this.zones.get(`${x},${z}`)?.readyMask === 0xffff; }
  get hasPendingWork() { return this.active && !this.halted && this.zones.size > 0
    && (this.dirty || this.busy || !!this.packet || this.uploads.size > 0 || !!this.arena?.hasPendingWork); }
  get hasPendingTransitions() { return this.active && [...this.zones.values()]
    .some(zone => [...zone.batches.values()].some(batch => batch.transitioning)); }
  get preparationError(): string | null {
    return this.halted ? this.group.userData.voxelLodWorkStats.error || 'Distant voxel preparation failed.' : null;
  }

  /** Reference switch for development A/B measurements; residency is unchanged. */
  setDrawOptimizationsEnabled(enabled: boolean, culling = enabled) {
    if (this.drawOptimizations.value === enabled && this.drawCullingEnabled === culling) return;
    this.drawOptimizations.value = enabled; this.drawCullingEnabled = culling; this.cullDirty = true;
    this.refreshMaterials();
  }
  getDrawOptimizationsEnabled() { return this.drawOptimizations.value; }

  /** Development reference switch; keeps geometry, resolution and LOD unchanged. */
  setOpaqueFastPathEnabled(enabled: boolean) { this.opaqueFastPath = enabled; this.refreshMaterials(); }
  getOpaqueFastPathEnabled() { return this.opaqueFastPath; }
  /** Only enable with a renderer that supports opaque terrain bundle ordering. */
  setCommandCachingEnabled(enabled: boolean) {
    if (this.group.isBundleGroup === enabled) return;
    (this.group as unknown as { isBundleGroup: boolean }).isBundleGroup = enabled;
    this.group.needsUpdate = true;
  }
  getCommandCachingEnabled() { return this.group.isBundleGroup; }
  private selectMaterial = (mesh: FaceMesh) => {
    const range = mesh.userData.terrainCoverage;
    mesh.material = this.opaqueFastPath && this.drawOptimizations.value
      && mesh.userData.voxelHandoffMode.value === 0 && range.x === 0 && range.y === 1
      ? mesh.userData.opaqueMaterial : mesh.userData.maskedMaterial;
    const previous = this.submittedState.get(mesh), count = mesh.geometry.instanceCount;
    if (!previous || previous.visible !== mesh.visible || previous.material !== mesh.material || previous.version !== mesh.material.version || previous.count !== count) {
      this.submittedState.set(mesh, { visible: mesh.visible, material: mesh.material, version: mesh.material.version, count });
      this.group.needsUpdate = true;
    }
  };
  private refreshMaterials() {
    this.arena?.restoreSources();
    for (const mesh of this.group.children) if (!mesh.userData.voxelArena) this.selectMaterial(mesh as FaceMesh);
    this.arena?.sync(); this.arenaDirty = false;
  }

  /** Primary shared storage, with incremental publication and ordinary draws
   * during ownership/geometry transitions. Also supports development A/B. */
  setMergedBuffersEnabled(enabled: boolean) {
    if (enabled === !!this.arena) return;
    if (!enabled) {
      this.arena?.dispose(); this.arena = null;
      this.group.userData.voxelArenaStats = null;
    } else {
      this.arena = new VoxelFaceArena(this.group, inputs => {
        const mesh = new THREE.Mesh(geometry(), material(this.mask, new THREE.Vector2(0, 1),
          new THREE.Vector3(), this.drawOptimizations, true, inputs));
        mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; hookSceneMaterials(mesh);
        mesh.userData.opaqueMaterial = mesh.material;
        mesh.material = material(this.mask, new THREE.Vector2(0, 1), new THREE.Vector3(), this.drawOptimizations, false, inputs);
        hookSceneMaterials(mesh); mesh.userData.maskedMaterial = mesh.material;
        mesh.material = mesh.userData.opaqueMaterial;
        return mesh;
      });
      this.group.userData.voxelArenaStats = this.arena.stats; this.arena.sync();
    }
    this.group.needsUpdate = true;
  }
  getMergedBuffersEnabled() { return !!this.arena; }

  private make = (coverage: THREE.Vector2, origin: THREE.Vector3, mode: { value: number }): FaceMesh => {
    const mesh = new THREE.Mesh(geometry(), material(this.mask, coverage, origin, this.drawOptimizations));
    // A pooled slot can replace GPU attribute buffers without changing its face count.
    mesh.geometry.addEventListener('dispose', () => { this.group.needsUpdate = true; });
    Object.assign(mesh.userData, { voxelOrigin: origin, voxelHandoffMode: mode, voxelArenaCompatible: true });
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; hookSceneMaterials(mesh);
    mesh.userData.maskedMaterial = mesh.material;
    mesh.material = material(this.mask, coverage, origin, this.drawOptimizations, true); hookSceneMaterials(mesh);
    mesh.userData.opaqueMaterial = mesh.material; mesh.material = mesh.userData.maskedMaterial;
    return mesh;
  };

  install(snapshot: SurfaceZoneSnapshot) {
    const key = `${snapshot.zoneX},${snapshot.zoneZ}`, previous = this.zones.get(key);
    if (previous && snapshot.sourceTerrainRevision < previous.snapshot.sourceTerrainRevision) return;
    const old = previous?.snapshot;
    if (old && old.sourceTerrainRevision === snapshot.sourceTerrainRevision && old.seed === snapshot.seed
      && old.terrainGeneratorVersion === snapshot.terrainGeneratorVersion
      && old.voxelMips?.length === snapshot.voxelMips?.length
      && old.voxelMips!.every((mip, i) => mip.cellSize === snapshot.voxelMips![i].cellSize
        && mip.faces === snapshot.voxelMips![i].faces)) return;
    const zone: RenderZone = { snapshot, token: ++this.nextToken,
      readyMask: previous?.readyMask ?? 0, batches: previous?.batches ?? new Map() };
    if (old && this.sharedSources.get(old.voxelMips!)?.key === key) this.sharedSources.delete(old.voxelMips!);
    this.zones.set(key, zone); this.dirty = this.cullDirty = true;
    if (this.planner) {
      for (const _ of this.planner.install({ key, x: snapshot.zoneX, z: snapshot.zoneZ,
        token: zone.token, mips: snapshot.voxelMips! })) { /* Explicit headless reference path. */ }
      this.buildSynchronously();
    } else {
      this.uploads.set(key, { zone, level: 0, offset: 0, started: false });
      this.ensurePort();
    }
  }

  private buildSynchronously() {
    const build = this.planner!.build(this.view);
    while (true) {
      const result = build.next();
      if (result.done === true) { this.group.userData.voxelLodStats = result.value; break; }
      if (result.value) this.publish(result.value, true);
    }
    this.dirty = false;
  }

  private ensurePort() {
    if (this.port || !this.active || this.halted || this.synchronous) return;
    try {
      this.port = this.fallback ? createCooperativeVoxelLodPort()
        : this.options.workerFactory ? this.options.workerFactory()
        : createWorkerVoxelLodPort(new Worker(new URL('./VoxelLodWorker.ts', import.meta.url), { type: 'module', name: 'voxel-lod' }));
    } catch (error) { this.fallback = true; this.port = createCooperativeVoxelLodPort(); }
    const port = this.port;
    this.group.userData.voxelLodWorkStats.backend = this.fallback ? 'cooperative' : 'worker';
    port.onmessage = event => { if (this.port === port) this.receive(event.data); };
    port.onerror = event => { if (this.port === port) this.fail(event.message); };
  }

  private fail(message: string) {
    this.group.userData.voxelLodWorkStats.error = message;
    this.stopPort();
    if (this.fallback) {
      this.halted = true;
      console.error('Distant voxel preparation failed; keeping the last published terrain.', message);
      return;
    }
    console.warn('Distant voxel worker unavailable; using cooperative preparation.', message);
    this.fallback = true; this.requeueSources(); this.ensurePort();
  }

  private receive(response: VoxelLodResponse) {
    if (response.type === 'error') { this.fail(response.message); return; }
    if (response.id !== this.requestId) return;
    if (response.type === 'tiles') this.packet = { id: response.id, tiles: response.tiles };
    else {
      this.busy = false;
      this.group.userData.voxelLodStats = response.stats;
    }
  }

  private publish(tile: VoxelLodTile, synchronous = false) {
    const zone = this.zones.get(tile.key);
    if (!zone || zone.token !== tile.token) return true; // Obsolete source, removal or remove/reinstall.
    let batch = zone.batches.get(tile.tile);
    if (!synchronous && batch?.transitioning) return false;
    if (tile.count || batch) {
      const bounds = new THREE.Sphere(new THREE.Vector3(...tile.bounds.slice(0, 3)), tile.bounds[3]);
      if (!batch) {
        const origin = new THREE.Vector3(zone.snapshot.zoneX * 512, 0, zone.snapshot.zoneZ * 512), mode = { value: 1 };
        const x = origin.x + (tile.tile >> 2) * 128, z = origin.z + (tile.tile & 3) * 128;
        // The full tile covers BOTH generations during a geometry transition.
        const loose = computeBentBoundsSphere({ minX: x, maxX: x + 128, minY: 0, maxY: 256, minZ: z, maxZ: z + 128 });
        batch = new SurfaceBatch(this.group, `voxel:${tile.key}:${tile.tile}`, loose,
          (_side, coverage) => {
            const mesh = this.make(coverage, origin, mode);
            mesh.userData.voxelTile = (((zone.snapshot.zoneX * 4 + (tile.tile >> 2)) % 128 + 128) % 128) * 16
              + ((zone.snapshot.zoneZ * 4 + (tile.tile & 3)) % 16 + 16) % 16;
            return mesh;
          }, 200);
        this.drawStates.set(batch, { tight: bounds, flatBounds: tile.flatBounds,
          looseFlatBounds: [x, x + 128, z, z + 128], maskVersion: -1,
          transitioning: false, inView: true, handoffMode: mode });
        zone.batches.set(tile.tile, batch);
      }
      const attributes: Record<string, THREE.InstancedBufferAttribute> = {};
      for (const [name, array, size, normalized] of [
        ['voxelOffset', tile.offset, 3, false], ['voxelSpan', tile.span, 2, false],
        ['voxelDirection', tile.direction, 1, false], ['voxelEmission', tile.emission, 1, false],
        ['color', tile.color, 3, true],
      ] as const) attributes[name] = alignedInstanceAttribute(array, size, normalized);
      if (synchronous) {
        const source = new THREE.Mesh(geometry(), new THREE.MeshStandardNodeMaterial());
        for (const [name, attribute] of Object.entries(attributes)) source.geometry.setAttribute(name, attribute);
        source.geometry.instanceCount = tile.count;
        source.geometry.userData.voxelVisibility = tile.visibility;
        batch.submit(source, 0, tile.count, source, 0, 0, this.view.hasView);
        source.geometry.dispose(); source.material.dispose();
      } else if (!batch.submitPrepared(attributes, tile.count, this.view.hasView, performance.now(),
        { voxelVisibility: tile.visibility })) return false;
      const state = this.drawStates.get(batch)!;
      state.tight.copy(bounds); state.flatBounds = tile.flatBounds; state.maskVersion = -1;
      // Publication happens after the normal culling pass; cull new meshes now.
      this.cullBatch(batch, true);
    }
    zone.readyMask |= 1 << tile.tile;
    this.group.userData.voxelLodWorkStats.publications++;
    return true;
  }

  private cullBatch(batch: SurfaceBatch, changed: boolean, frustum = this.cullFrustum) {
    const state = this.drawStates.get(batch)!;
    const transitionChanged = state.transitioning !== batch.transitioning;
    state.transitioning = batch.transitioning;
    const blockVisibility = !!this.arena && !batch.transitioning && !!batch.top.geometry.userData.voxelVisibility;
    if (!blockVisibility && (changed || transitionChanged)) {
      const bounds = this.drawCullingEnabled && !batch.transitioning ? state.tight : batch.bounds;
      // Tightening must still cover the camera-local flattening deformation.
      projectBentSphereForView(bounds, this.projectedBounds);
      state.inView = frustum.intersectsSphere(this.projectedBounds)
        && this.cullCamera.distanceTo(bounds.center) - bounds.radius <= this.view.distance;
    }
    // Ownership is resident state, independent of camera direction. Classify
    // hidden tiles too so the entry gate can finish their arena migration;
    // turning must not retire attributes or create new storage pages/shaders.
    const maskVersion = this.mask.userData.voxelVisibilityVersion ?? this.mask.version;
    if (state.maskVersion !== maskVersion || transitionChanged) {
      // The owned DataTexture always retains the CPU mask allocated at construction.
      state.handoffMode.value = voxelHandoffMode(this.mask.image.data!,
        batch.transitioning ? state.looseFlatBounds : state.flatBounds);
      state.maskVersion = maskVersion;
    }
    // Immutable shared-storage blocks already carry guarded visibility bounds.
    // Keeping their source list stable avoids rebuilding the arena and native
    // command bundles whenever an unrelated 128 m tile touches the frustum.
    batch.setVisible((blockVisibility || state.inView) && (!this.drawCullingEnabled || state.handoffMode.value !== 2));
    batch.forEachActiveMesh(this.selectMaterial);
  }

  /** Soft CPU and byte budgets. One oversized tile is indivisible so it gets a
   * frame alone rather than starving. Counters expose that exception explicitly. */
  private processPending() {
    if (this.synchronous || !this.active || this.halted || !this.zones.size) return;
    this.ensurePort();
    const port = this.port!;
    const start = performance.now(), deadline = start + VOXEL_PUBLICATION_BUDGET_MS;
    let publicationBytes = 0, sourceBytes = 0;
    if (this.packet) {
      for (let i = 0; i < this.packet.tiles.length && performance.now() < deadline; i++) {
        const tile = this.packet.tiles[i];
        if (!tile) continue;
        const current = this.zones.get(tile.key);
        if (!current || current.token !== tile.token) { this.packet.tiles[i] = null; continue; }
        const bytes = tile.count * VOXEL_GPU_BYTES_PER_FACE;
        if (publicationBytes && publicationBytes + bytes > VOXEL_PUBLICATION_BUDGET_BYTES) break;
        if (!this.publish(tile)) continue;
        this.packet.tiles[i] = null; publicationBytes += bytes;
        if (bytes > VOXEL_PUBLICATION_BUDGET_BYTES) this.group.userData.voxelLodWorkStats.oversizedTiles++;
        if (publicationBytes >= VOXEL_PUBLICATION_BUDGET_BYTES) break;
      }
      if (this.packet.tiles.every(tile => !tile)) {
        const id = this.packet.id; this.packet = null; port.postMessage({ type: 'ack', id });
      }
    }
    // Clone retained source bytes in small transferable pieces, never clone an
    // entire dense snapshot in postMessage or detach another consumer's data.
    while (this.uploads.size && performance.now() < deadline
      && sourceBytes < 512 * 1024 && sourceBytes + publicationBytes < VOXEL_PUBLICATION_BUDGET_BYTES) {
      const [key, upload] = this.uploads.entries().next().value!;
      const { snapshot, token } = upload.zone, mips = snapshot.voxelMips!;
      if (!upload.started) {
        const shared = this.sharedSources.get(mips);
        if (shared) {
          port.postMessage({ type: 'link', key, x: snapshot.zoneX, z: snapshot.zoneZ, token,
            sourceKey: shared.key, sourceToken: shared.token });
          this.sharedSources.set(mips, { key, token }); this.uploads.delete(key);
          this.hasWorkerSources = true; this.dirty = true; continue;
        }
        port.postMessage({ type: 'begin', key, x: snapshot.zoneX, z: snapshot.zoneZ, token,
          levels: mips.map(mip => ({ cellSize: mip.cellSize, length: mip.faces.length })) });
        upload.started = true;
      }
      if (upload.level >= mips.length) {
        port.postMessage({ type: 'end', key, token }); this.uploads.delete(key);
        this.sharedSources.set(mips, { key, token });
        this.hasWorkerSources = true; this.dirty = true; continue;
      }
      const mip = mips[upload.level];
      const count = Math.min(SOURCE_PART_BYTES, mip.faces.length - upload.offset,
        VOXEL_PUBLICATION_BUDGET_BYTES - sourceBytes - publicationBytes);
      const bytes = mip.faces.slice(upload.offset, upload.offset + count);
      port.postMessage({ type: 'part', key, token, level: upload.level, offset: upload.offset, bytes }, [bytes.buffer]);
      // A real worker detaches bytes during postMessage; retain the pre-transfer count.
      sourceBytes += count; upload.offset += count;
      if (upload.offset === mip.faces.length) { upload.level++; upload.offset = 0; }
    }
    if (!this.busy && this.hasWorkerSources && this.dirty) {
      this.busy = true; this.dirty = false;
      port.postMessage({ type: 'build', id: ++this.requestId, view: { ...this.view, camera: [...this.view.camera] } });
    }
    Object.assign(this.group.userData.voxelLodWorkStats, { workMs: performance.now() - start,
      publicationBytes, sourceBytes, queuedSources: this.uploads.size,
      pendingTiles: this.packet?.tiles.filter(Boolean).length ?? 0 });
  }

  updateView(frustum: THREE.Frustum, camera: THREE.Vector3, focal: number, area: number, distance: number,
    faceBudget = MAX_VOXEL_LOD_FACES) {
    const cullChanged = this.cullDirty || !this.cullCamera.equals(camera) || distance !== this.view.distance
      || frustum.planes.some((plane, i) => !plane.equals(this.cullFrustum.planes[i]));
    if (cullChanged) { this.cullCamera.copy(camera); this.cullFrustum.copy(frustum); this.cullDirty = false; }
    const changed = !this.view.hasView || Math.hypot(camera.x - this.view.camera[0], camera.y - this.view.camera[1],
      camera.z - this.view.camera[2]) >= 8 || Math.abs(focal / this.view.focal - 1) > .05
      || area !== this.view.area || distance !== this.view.distance || faceBudget !== this.view.faceBudget;
    if (changed) {
      Object.assign(this.view, { camera: camera.toArray(), focal, area, distance, faceBudget, hasView: true });
      this.dirty = true;
    }
    if (this.planner && this.dirty) this.buildSynchronously();
    const now = performance.now();
    this.arena?.setView(camera, frustum, this.mask, this.drawCullingEnabled);
    const maskVersion = this.mask.userData.voxelVisibilityVersion ?? this.mask.version;
    const maskChanged = this.maskVersion !== maskVersion;
    this.maskVersion = maskVersion;
    const arenaWork = cullChanged || maskChanged || this.arenaDirty || this.arena?.hasPendingWork || !!this.packet
      || [...this.zones.values()].some(zone => [...zone.batches.values()].some(batch => batch.transitioning));
    if (arenaWork) this.arena?.restoreSources();
    for (const zone of this.zones.values()) for (const batch of zone.batches.values()) {
      const transitioning = batch.transitioning;
      batch.advance(now);
      const blockVisibility = !!this.arena && !batch.transitioning && !!batch.top.geometry.userData.voxelVisibility;
      if ((!blockVisibility && cullChanged) || maskChanged || transitioning || this.arenaDirty) this.cullBatch(batch, cullChanged, frustum);
    }
    try { this.processPending(); }
    catch (error) { this.fail(String(error)); }
    if (arenaWork || this.arenaDirty) { this.arena?.sync(); this.arenaDirty = false; }
    else this.arena?.idle();
  }

  removeZone(x: number, z: number) {
    const key = `${x},${z}`, zone = this.zones.get(key);
    if (!zone) return;
    for (const batch of zone.batches.values()) batch.dispose();
    if (this.sharedSources.get(zone.snapshot.voxelMips!)?.key === key) this.sharedSources.delete(zone.snapshot.voxelMips!);
    this.zones.delete(key); this.uploads.delete(key); this.planner?.remove(key);
    this.port?.postMessage({ type: 'remove', key }); this.dirty = true;
    if (!this.zones.size && !this.synchronous) { this.stopPort(); this.dirty = false; }
  }

  private stopPort() {
    const port = this.port; this.port = null; port?.terminate(); this.packet = null; this.busy = false;
    this.hasWorkerSources = false;
    this.sharedSources.clear();
  }
  private requeueSources() {
    this.uploads.clear();
    for (const [key, zone] of this.zones) this.uploads.set(key, { zone, level: 0, offset: 0, started: false });
    this.dirty = this.zones.size > 0;
  }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!this.synchronous) {
      this.stopPort(); this.uploads.clear();
      if (active) { this.halted = false; this.requeueSources(); }
    }
  }
  dispose() {
    // The source meshes are being destroyed too; do not reconstruct their data.
    this.arena?.dispose(false); this.arena = null; this.group.userData.voxelArenaStats = null;
    this.stopPort(); this.active = false; this.uploads.clear();
    for (const zone of this.zones.values()) for (const batch of zone.batches.values()) batch.dispose();
    this.zones.clear();
  }
}
