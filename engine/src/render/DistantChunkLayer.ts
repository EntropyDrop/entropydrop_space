import { terrainCoverage, terrainDither, discardWhen } from './NodeMaterials.ts';
import { uniform, screenCoordinate, vec2 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { Chunk } from '../voxel/Chunk.ts';
import type { MicroVoxelLayer } from '../voxel/MicroVoxelLayer.ts';
import type { DistantChunkSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { computeBentBoundsSphere, getWorldProjectionRevision, hookSceneMaterials, projectBentSphereForView } from '../torus/TorusWorld.ts';
import { AUTHORED_CELL_SIZES, buildAuthoredSurface, type AuthoredSurfaceGeometry } from './AuthoredSurfaceMesher.ts';
import { surfaceSubdivisionWorldArea } from './SurfaceSubdivision.ts';
import { TERRAIN_FADE_MS } from './TerrainHandoff.ts';

type Solid = [number, number, number, number, number, number, number];

/** Exact vertical runs: no height-field fill beneath floating structures. */
export function captureDistantChunk(chunk: Chunk, micro: MicroVoxelLayer, revision: number): DistantChunkSnapshot {
  // LOD intentionally stores only occupancy and color. Authored material ids
  // stay in detailed terrain; distant surfaces all use the default lit shader.
  let solids: Solid[] = [];
  const maxY = chunk.getOccupiedYRange()?.max ?? -1;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    let start = 0, previous = -1;
    for (let y = 0; y <= maxY + 1; y++) {
      const index = Chunk.getIndex(x, y, z);
      const color = y <= maxY && chunk.blocks[index] ? chunk.colors[index] : -1;
      if (color === previous) continue;
      if (previous >= 0) solids.push([x * 8, start * 8, z * 8, 8, (y - start) * 8, 8, previous]);
      start = y;
      previous = color;
    }
  }
  const columns = new Map<number, Array<[number, number]>>();
  micro.forEachCellInChunk(chunk.cx, chunk.cz, (mx, my, mz, color) => {
    const x = mx - chunk.cx * 128, z = mz - chunk.cz * 128;
    const key = x * 128 + z;
    let column = columns.get(key);
    if (!column) columns.set(key, column = []);
    column.push([my, color]);
  });
  for (const [key, column] of columns) {
    column.sort((a, b) => a[0] - b[0]);
    let run: Solid | undefined;
    for (const [y, color] of column) {
      if (run && run[1] + run[4] === y && run[6] === color) run[4]++;
      else {
        run = [Math.floor(key / 128), y, key % 128, 1, 1, 1, color];
        solids.push(run);
      }
    }
  }
  // Limit merged footprints to 2m to keep torus chord error below a millimetre.
  for (const [axis, width] of [[0, 3], [2, 5]]) {
    const groups = new Map<string, Solid[]>();
    for (const solid of solids) {
      const key = solid.filter((_, i) => i !== axis && i !== width).join(',');
      let group = groups.get(key);
      if (!group) groups.set(key, group = []);
      group.push(solid);
    }
    solids = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a[axis] - b[axis]);
      let run: Solid | undefined;
      for (const box of group) {
        if (run && run[axis] + run[width] === box[axis] && run[width] + box[width] <= 16) run[width] += box[width];
        else { run = box; solids.push(run); }
      }
    }
  }
  const boxes = new Uint16Array(solids.length * 6), colors = new Uint8Array(solids.length * 3);
  solids.forEach((solid, i) => {
    boxes.set(solid.slice(0, 6), i * 6);
    colors.set([solid[6] >> 16 & 255, solid[6] >> 8 & 255, solid[6] & 255], i * 3);
  });
  return { chunkX: chunk.cx, chunkZ: chunk.cz, revision, boxes, colors };
}

type AuthoredMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
type AuthoredEntry = { mesh: AuthoredMesh; previous: AuthoredMesh | null; startedAt: number;
  snapshot: DistantChunkSnapshot; cellSize: number; desiredSize: number; distance: number;
  bounds: THREE.Sphere; revision: number; local: boolean;
  chunkX: number; chunkZ: number; top: number; projectionRevision: number };
type AuthoredJob = { key: string; entry: AuthoredEntry; cellSize: number };

/** Authored solids retain exact source snapshots. Distance-selected exterior
 * meshes are prepared off-thread, then cross-fade without changing coverage. */
export class DistantChunkLayer {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1, 2, 1, 2);
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly surfaceMaterial: THREE.MeshStandardNodeMaterial;
  private readonly entries = new Map<string, AuthoredEntry>();
  private readonly projectedBounds = new THREE.Sphere();
  private readonly queued = new Map<string, AuthoredEntry>();
  private worker: Worker | null = null;
  private job: AuthoredJob | null = null;
  private completed: AuthoredSurfaceGeometry | null = null;
  private active = true;
  private failed = false;
  private transitions = 0;
  private readonly mask: THREE.DataTexture;
  private readonly onCoverage: (cx: number, cz: number, ready: boolean) => void;
  constructor(mask: THREE.DataTexture, onCoverage: (cx: number, cz: number, ready: boolean) => void) {
    this.onCoverage = onCoverage;
    this.mask = mask;
    this.group.name = 'DistantAuthoredChunks';
    this.material = new THREE.MeshStandardNodeMaterial({ vertexColors: false, roughness: 0.65,
      metalness: 0.15, flatShading: true });
    const chunk = uniform(new THREE.Vector2()).onObjectUpdate(({ object }) => object?.userData.distantChunkOrigin);
    discardWhen(this.material, terrainDither().lessThan(terrainCoverage(mask, chunk).r));
    const coverage = uniform(new THREE.Vector2(0, 1)).onObjectUpdate(({object}) => object?.userData.authoredCoverage);
    const dither = terrainDither(screenCoordinate.xy.add(vec2(37, 19)));
    discardWhen(this.material, dither.lessThan(coverage.x).or(dither.greaterThanEqual(coverage.y)));
    this.surfaceMaterial = this.material.clone(); this.surfaceMaterial.vertexColors = true;
    this.group.userData.authoredSurfaceStats = { sourceBoxes: 0, surfaceFaces: 0, pending: 0, error: '' };
    mask.addEventListener('dispose', () => this.dispose());
  }
  install(chunk: DistantChunkSnapshot, local = false) {
    const key = `${chunk.chunkX},${chunk.chunkZ}`;
    const previous = this.entries.get(key);
    if (previous && !local && (previous.revision > chunk.revision
      || (!previous.local && previous.revision === chunk.revision))) return;
    // Local data stays authoritative until its accepted server revision arrives.
    const count = chunk.boxes.length / 6;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    mesh.userData.distantChunkOrigin = new THREE.Vector2(chunk.chunkX * 16 + .01, chunk.chunkZ * 16 + .01);
    mesh.userData.authoredCoverage = new THREE.Vector2(0, 1);
    mesh.name = `DistantAuthored:${key}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    let top = 0;
    for (let i = 0; i < count; i++) {
      const [x, y, z, w, h, d] = chunk.boxes.subarray(i * 6, i * 6 + 6);
      matrix.makeScale(w * MICRO_SIZE, h * MICRO_SIZE, d * MICRO_SIZE);
      matrix.setPosition(chunk.chunkX * 16 + (x + w / 2) * MICRO_SIZE,
        (y + h / 2) * MICRO_SIZE, chunk.chunkZ * 16 + (z + d / 2) * MICRO_SIZE);
      mesh.setMatrixAt(i, matrix);
      color.setRGB(chunk.colors[i * 3] / 255, chunk.colors[i * 3 + 1] / 255,
        chunk.colors[i * 3 + 2] / 255, THREE.SRGBColorSpace);
      mesh.setColorAt(i, color);
      top = Math.max(top, (y + h) * MICRO_SIZE);
    }
    hookSceneMaterials(mesh);
    const bounds = computeBentBoundsSphere({ minX: chunk.chunkX * 16, maxX: chunk.chunkX * 16 + 16,
      minZ: chunk.chunkZ * 16, maxZ: chunk.chunkZ * 16 + 16, minY: 0, maxY: Math.ceil(top / 4) * 4 });
    this.group.add(mesh);
    this.entries.set(key, { mesh, bounds, revision: chunk.revision, local, snapshot: chunk,
      previous: null, startedAt: 0, cellSize: 0, desiredSize: 0, distance: Infinity,
      chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, top, projectionRevision: getWorldProjectionRevision() });
    this.queued.delete(key);
    this.onCoverage(chunk.chunkX, chunk.chunkZ, true);
    if (previous) { this.release(previous.mesh); if (previous.previous) this.release(previous.previous); }
  }
  acknowledge(cx: number, cz: number, revision: number) {
    const entry = this.entries.get(`${cx},${cz}`);
    if (entry?.local) entry.revision = Math.max(Number.isFinite(entry.revision) ? entry.revision : 0, revision);
  }
  get hasPendingWork() { return this.active && (this.transitions > 0 || (!this.failed && (!!this.job || this.queued.size > 0))); }

  private release(mesh: AuthoredMesh) {
    mesh.removeFromParent();
    if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
    if (mesh.geometry !== this.geometry) mesh.geometry.dispose();
  }

  private publish(job: AuthoredJob, data: AuthoredSurfaceGeometry, now: number) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const entry = job.entry, mesh = new THREE.Mesh(geometry, this.surfaceMaterial);
    mesh.name = `DistantAuthoredSurface:${job.key}`; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
    mesh.userData.distantChunkOrigin = entry.mesh.userData.distantChunkOrigin;
    mesh.userData.authoredCoverage = new THREE.Vector2(0, 1); mesh.userData.authoredFaces = data.faces;
    hookSceneMaterials(mesh); mesh.visible = entry.mesh.visible;
    if (mesh.visible) {
      entry.previous = entry.mesh; entry.startedAt = now;
      this.transitions++;
      mesh.userData.authoredCoverage.set(0, 0);
    } else this.release(entry.mesh);
    entry.mesh = mesh; entry.cellSize = data.cellSize;
    this.group.add(mesh);
  }

  private fail(error: unknown) {
    // Keep the last-good mesh (or original exact boxes) if workers are unavailable.
    this.failed = true; this.worker?.terminate(); this.worker = null;
    this.job = null; this.completed = null; this.queued.clear();
    this.group.userData.authoredSurfaceStats.error = String(error);
  }

  private process(now: number) {
    if (!this.active || this.failed) return;
    if (this.completed && this.job) {
      const job = this.job;
      if (this.entries.get(job.key) !== job.entry || job.cellSize !== job.entry.desiredSize) {
        this.completed = null; this.job = null;
      } else if (!job.entry.previous) {
        this.publish(job, this.completed, now); this.completed = null; this.job = null;
      }
    }
    if (this.job) return;
    let next: AuthoredJob | null = null;
    for (const [key, entry] of this.queued) {
      if (entry.cellSize === entry.desiredSize || this.entries.get(key) !== entry) { this.queued.delete(key); continue; }
      if (!entry.previous && (!next || entry.distance < next.entry.distance)) next = {key, entry, cellSize:entry.desiredSize};
    }
    if (!next) return;
    this.queued.delete(next.key); this.job = next;
    try {
      if (typeof window === 'undefined') {
        this.completed = buildAuthoredSurface(next.entry.snapshot, next.cellSize);
        return;
      }
      if (!this.worker) {
        const worker = this.worker = new Worker(new URL('./AuthoredSurfaceWorker.ts', import.meta.url), {type:'module',name:'authored-surface'});
        worker.onmessage = ({data}: MessageEvent<{mesh?: AuthoredSurfaceGeometry; error?: string}>) => {
          if (this.worker !== worker) return;
          if (data.error || !data.mesh) this.fail(data.error ?? 'Missing authored surface');
          else this.completed = data.mesh;
        };
        worker.onerror = event => { if (this.worker === worker) this.fail(event.message); };
      }
      const snapshot = next.entry.snapshot, source = {...snapshot, boxes:snapshot.boxes.slice(),colors:snapshot.colors.slice()};
      this.worker.postMessage({source,cellSize:next.cellSize},[source.boxes.buffer,source.colors.buffer]);
    } catch (error) { this.fail(error); }
  }

  updateView(frustum: THREE.Frustum, camera: THREE.Vector3, maxDistance: number, focal = 720) {
    const now = performance.now(); this.transitions = 0;
    let sourceBoxes = 0, surfaceFaces = 0;
    for (const [key, entry] of this.entries) {
      if (entry.projectionRevision !== getWorldProjectionRevision()) {
        computeBentBoundsSphere({ minX: entry.chunkX * 16, maxX: entry.chunkX * 16 + 16,
          minZ: entry.chunkZ * 16, maxZ: entry.chunkZ * 16 + 16, minY: 0, maxY: Math.ceil(entry.top / 4) * 4 }, entry.bounds);
        entry.projectionRevision = getWorldProjectionRevision();
      }
      entry.distance = Math.max(1, camera.distanceTo(entry.bounds.center) - entry.bounds.radius);
      projectBentSphereForView(entry.bounds, this.projectedBounds);
      const index = (((entry.chunkZ % 128 + 128) % 128) * 1024 + (entry.chunkX % 1024 + 1024) % 1024) * 2;
      entry.mesh.visible = frustum.intersectsSphere(this.projectedBounds) && entry.distance <= maxDistance
        && this.mask.image.data![index] !== 255;
      if (entry.previous) {
        entry.previous.visible = entry.mesh.visible;
        const t = Math.min(1, (now - entry.startedAt) / TERRAIN_FADE_MS), smooth = t * t * (3 - 2 * t);
        entry.mesh.userData.authoredCoverage.set(0, smooth); entry.previous.userData.authoredCoverage.set(smooth, 1);
        if (t === 1) { this.release(entry.previous); entry.previous = null; }
        else this.transitions++;
      }
      sourceBoxes += entry.snapshot.boxes.length / 6;
      surfaceFaces += entry.mesh.userData.authoredFaces ?? 0;
      if (entry.snapshot.boxes.length / 6 < 256 || !this.active || this.failed) continue;
      const stretch = Math.sqrt(surfaceSubdivisionWorldArea(1, entry.top, entry.top));
      const pixelsPerMetre = focal * stretch / entry.distance;
      const currentPixels = entry.cellSize * pixelsPerMetre;
      entry.desiredSize = entry.cellSize && currentPixels >= .55 && currentPixels <= 1.3 ? entry.cellSize
        : AUTHORED_CELL_SIZES.find(size => size * pixelsPerMetre <= 1) ?? .125;
      if (entry.desiredSize !== entry.cellSize) this.queued.set(key, entry);
    }
    this.process(now);
    Object.assign(this.group.userData.authoredSurfaceStats, {sourceBoxes,surfaceFaces,pending:this.queued.size + (this.job ? 1 : 0)});
  }
  setActive(active: boolean) {
    this.active = active;
    if (!active) { this.worker?.terminate(); this.worker = null; this.job = null; this.completed = null; this.queued.clear(); }
    else { this.failed = false; this.group.userData.authoredSurfaceStats.error = ''; }
  }
  dispose() {
    this.setActive(false);
    for (const entry of this.entries.values()) { this.release(entry.mesh); if (entry.previous) this.release(entry.previous); }
    this.entries.clear(); this.geometry.dispose(); this.material.dispose(); this.surfaceMaterial.dispose();
  }
  has(cx: number, cz: number) { return this.entries.has(`${cx},${cz}`); }
}
