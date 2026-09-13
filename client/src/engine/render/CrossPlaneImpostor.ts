import * as THREE from 'three';
import { hookSceneMaterials, unwrapPeriodicNear, TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { normalizeEntityImpostorSettings, type EntityImpostorSettings } from './EntityImpostorSettings.ts';

export const IMPOSTOR_DISTANCE = 80;
export const IMPOSTOR_TEXTURE_SIZE = 64;
export const IMPOSTOR_BUILD_BUDGET_MS = 2;
export const IMPOSTOR_CACHE_LIMIT = 128;

export interface ImpostorSource {
  key: object | string;
  kind?: 'entity';
  parent: THREE.Object3D;
  meshes: THREE.Mesh[];
  /** Conservative bounds in parent coordinates; baking tightens these. */
  bounds: THREE.Box3;
  protected?: boolean;
  visible?: boolean;
  /** Prebake while loaded and retain only while the source is streamed out.
   * The callback must use streaming metadata, without capturing the live entity.
   */
  retain?: () => boolean;
  /** Optional replacement of only part of a terrain mesh, restored after drawing. */
  onShow?: () => (() => void);
}

interface Snapshot {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  vertexColor: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  index: THREE.BufferAttribute | null;
  vertexColors: boolean;
  positionVersion: number;
  colorVersion: number;
  indexVersion: number;
  drawStart: number;
  drawCount: number;
  material: THREE.MeshBasicMaterial;
  color: number;
  matrix: THREE.Matrix4;
}

export interface ImpostorBake {
  bounds: THREE.Box3;
  pixels: Uint8Array;
  size: number;
}

function snapshot(mesh: THREE.Mesh): Snapshot {
  mesh.updateMatrix();
  const material = mesh.material as THREE.MeshBasicMaterial;
  return {
    mesh, geometry: mesh.geometry, material,
    position: mesh.geometry.getAttribute('position'),
    vertexColor: mesh.geometry.getAttribute('color'),
    index: mesh.geometry.index,
    vertexColors: material.vertexColors,
    positionVersion: (mesh.geometry.getAttribute('position') as THREE.BufferAttribute)?.version ?? 0,
    colorVersion: (mesh.geometry.getAttribute('color') as THREE.BufferAttribute)?.version ?? 0,
    indexVersion: mesh.geometry.index?.version ?? 0,
    drawStart: mesh.geometry.drawRange.start,
    drawCount: mesh.geometry.drawRange.count,
    color: material.color?.getHex() ?? 0xffffff,
    matrix: mesh.matrix.clone(),
  };
}

function compatible(mesh: THREE.Mesh) {
  const material = mesh.material as THREE.MeshBasicMaterial;
  return mesh.geometry?.getAttribute('position') && !Array.isArray(material)
    && !material.transparent && material.opacity === 1 && !material.map;
}

/**
 * Orthographic color/depth projections of the published geometry. Both sides
 * of both planes are baked, preserving holes and different front/back colors.
 * Yield inside raster rows so even a very large model cannot monopolize a frame.
 */
export function* bakeCrossPlaneImpostor(snapshots: Snapshot[], size = IMPOSTOR_TEXTURE_SIZE): Generator<void, ImpostorBake | null> {
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const source of snapshots) {
    const position = source.geometry.getAttribute('position');
    const index = source.geometry.index;
    const first = source.geometry.drawRange.start;
    const last = Math.min(index?.count ?? position.count, first + source.geometry.drawRange.count);
    for (let i = first; i < last; i++) {
      bounds.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(source.matrix));
      if ((i & 127) === 127) yield;
    }
  }
  if (bounds.isEmpty()) return null;
  const span = bounds.getSize(new THREE.Vector3());
  if (Math.min(span.x, span.y, span.z) <= 0) return null;
  const pixels = new Uint8Array(size * 4 * size * 4);
  const depth = Array.from({ length: 4 }, () => new Float32Array(size * size).fill(-Infinity));
  let covered = false;
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  for (const source of snapshots) {
    const position = source.geometry.getAttribute('position');
    const color = source.material.vertexColors ? source.geometry.getAttribute('color') : null;
    const index = source.geometry.index;
    const tint = source.material.color || new THREE.Color(0xffffff);
    const count = index?.count ?? position.count;
    const first = Math.max(0, source.geometry.drawRange.start);
    const last = Math.min(count, first + source.geometry.drawRange.count);
    for (let i = first; i + 2 < last; i += 3) {
      const ids = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset);
      ids.forEach((id, j) => vertices[j].fromBufferAttribute(position, id).applyMatrix4(source.matrix));
      for (let view = 0; view < 2; view++) {
        const horizontal = view === 0 ? 'x' : 'z';
        const depthAxis = view === 0 ? 'z' : 'x';
        const xs = vertices.map(v => (v[horizontal] - bounds.min[horizontal]) / span[horizontal] * size);
        const ys = vertices.map(v => (v.y - bounds.min.y) / span.y * size);
        const divisor = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
        if (Math.abs(divisor) < 1e-9) continue;
        const minX = Math.max(0, Math.floor(Math.min(...xs)));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(...xs)) - 1);
        const minY = Math.max(0, Math.floor(Math.min(...ys)));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(...ys)) - 1);
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const a = ((ys[1] - ys[2]) * (x + 0.5 - xs[2]) + (xs[2] - xs[1]) * (y + 0.5 - ys[2])) / divisor;
            const b = ((ys[2] - ys[0]) * (x + 0.5 - xs[2]) + (xs[0] - xs[2]) * (y + 0.5 - ys[2])) / divisor;
            const c = 1 - a - b;
            if (Math.min(a, b, c) < -1e-6) continue;
            const z = a * vertices[0][depthAxis] + b * vertices[1][depthAxis] + c * vertices[2][depthAxis];
            for (let side = 0; side < 2; side++) {
              const projection = view * 2 + side;
              const value = side === 0 ? z : -z;
              const cell = y * size + x;
              if (value <= depth[projection][cell]) continue;
              depth[projection][cell] = value;
              const offset = (y * size * 4 + projection * size + x) * 4;
              pixels[offset] = Math.round(255 * tint.r * (color ? a * color.getX(ids[0]) + b * color.getX(ids[1]) + c * color.getX(ids[2]) : 1));
              pixels[offset + 1] = Math.round(255 * tint.g * (color ? a * color.getY(ids[0]) + b * color.getY(ids[1]) + c * color.getY(ids[2]) : 1));
              pixels[offset + 2] = Math.round(255 * tint.b * (color ? a * color.getZ(ids[0]) + b * color.getZ(ids[1]) + c * color.getZ(ids[2]) : 1));
              pixels[offset + 3] = 255;
              covered = true;
            }
          }
          yield;
        }
      }
      if ((i % 96) === 0) yield;
    }
  }
  return covered ? { bounds, pixels, size } : null;
}

export function createCrossPlaneMesh(bake: ImpostorBake) {
  const { min, max } = bake.bounds;
  const center = bake.bounds.getCenter(new THREE.Vector3());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    min.x, min.y, center.z, max.x, min.y, center.z, max.x, max.y, center.z, min.x, max.y, center.z,
    center.x, min.y, max.z, center.x, min.y, min.z, center.x, max.y, min.z, center.x, max.y, max.z,
  ], 3));
  // Plane 1 faces +Z and plane 2 faces +X; texture columns hold +/-Z, +/-X.
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 0.25, 0, 0.25, 1, 0, 1,
    0.75, 0, 0.5, 0, 0.5, 1, 0.75, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const texture = new THREE.DataTexture(bake.pixels, bake.size * 4, bake.size, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, alphaTest: 0.5 });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 impostorUv = vMapUv;
        impostorUv.x += gl_FrontFacing ? 0.0 : 0.25;
        diffuseColor *= texture2D(map, impostorUv);
      #endif
    `);
  };
  material.customProgramCacheKey = () => 'cross-plane-impostor-v1';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'CrossPlaneImpostor';
  mesh.visible = false;
  // Raycaster visits invisible descendants too. A render proxy must never
  // intercept editor picking or fill a hole in the original voxel geometry.
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  hookSceneMaterials(mesh);
  return mesh;
}

interface RecordEntry {
  key: ImpostorSource['key'];
  source: ImpostorSource | null;
  snapshots: Snapshot[];
  job: Generator<void, ImpostorBake | null> | null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  far: boolean;
  seen: number;
  used: number;
  worldMatrix: THREE.Matrix4;
  retain?: () => boolean;
}

/** Only render visibility changes: simulation, selection and editor previews keep full geometry. */
export class CrossPlaneImpostorLod {
  private records = new Map<ImpostorSource['key'], RecordEntry>();
  private frame = 0;
  private restored: Array<[THREE.Object3D, boolean]> = [];
  private restoreParts: Array<() => void> = [];
  private cameraLocal = new THREE.Vector3();
  private center = new THREE.Vector3();
  private span = new THREE.Vector3();
  private inverseWorld = new THREE.Matrix4();

  private proxyParent?: THREE.Object3D;
  private entitySettings = normalizeEntityImpostorSettings();

  constructor(proxyParent?: THREE.Object3D) {
    this.proxyParent = proxyParent;
  }

  setEntitySettings(settings: Partial<EntityImpostorSettings>) {
    const next = normalizeEntityImpostorSettings({ ...this.entitySettings, ...settings });
    if (next.startDistance !== this.entitySettings.startDistance) {
      for (const record of this.records.values()) if (record.source?.kind === 'entity') record.far = false;
    }
    this.entitySettings = next;
    return { ...this.entitySettings };
  }

  private current(record: RecordEntry, source: ImpostorSource) {
    return source.parent === record.source?.parent && source.meshes.length === record.snapshots.length
      && source.meshes.every((mesh, i) => {
        const previous = record.snapshots[i];
        mesh.updateMatrix();
        const material = mesh.material as THREE.MeshBasicMaterial;
        return mesh === previous.mesh && mesh.geometry === previous.geometry && material === previous.material
          && mesh.geometry.getAttribute('position') === previous.position
          && mesh.geometry.getAttribute('color') === previous.vertexColor
          && mesh.geometry.index === previous.index && material.vertexColors === previous.vertexColors
          && ((mesh.geometry.getAttribute('position') as THREE.BufferAttribute)?.version ?? 0) === previous.positionVersion
          && ((mesh.geometry.getAttribute('color') as THREE.BufferAttribute)?.version ?? 0) === previous.colorVersion
          && (mesh.geometry.index?.version ?? 0) === previous.indexVersion
          && mesh.geometry.drawRange.start === previous.drawStart && mesh.geometry.drawRange.count === previous.drawCount
          && (material.color?.getHex() ?? 0xffffff) === previous.color && mesh.matrix.equals(previous.matrix);
      });
  }

  private disposeRecord(record: RecordEntry) {
    record.job?.return(null);
    record.mesh?.removeFromParent();
    record.mesh?.geometry.dispose();
    record.mesh?.material.map?.dispose();
    record.mesh?.material.dispose();
    this.records.delete(record.key);
  }

  private localCamera(camera: THREE.Vector3, bounds: THREE.Box3, matrix: THREE.Matrix4) {
    this.cameraLocal.copy(camera);
    bounds.getCenter(this.center).applyMatrix4(matrix);
    this.cameraLocal.x = unwrapPeriodicNear(this.cameraLocal.x, this.center.x, TORUS_SIZE_X);
    this.cameraLocal.z = unwrapPeriodicNear(this.cameraLocal.z, this.center.z, TORUS_SIZE_Z);
    this.cameraLocal.applyMatrix4(this.inverseWorld.copy(matrix).invert());
  }

  beginRender(sources: Iterable<ImpostorSource>, cameraPosition: THREE.Vector3, budgetMs = IMPOSTOR_BUILD_BUDGET_MS) {
    this.endRender();
    this.frame++;
    const candidates: RecordEntry[] = [];
    for (const source of sources) {
      let record = this.records.get(source.key);
      if (record && (!source.meshes.every(compatible) || !this.current(record, source))) {
        this.disposeRecord(record);
        record = undefined;
      }
      if (record) record.seen = this.frame;
      const renderable = !source.protected && source.visible !== false && source.meshes.every(mesh => mesh.visible);
      if (source.meshes.length === 0 || (!renderable && !source.retain)) {
        if (record) record.far = false;
        continue;
      }
      source.parent.updateWorldMatrix(true, false);
      const bounds = record?.mesh?.geometry.boundingBox || source.bounds;
      this.localCamera(cameraPosition, bounds, source.parent.matrixWorld);
      bounds.getCenter(this.center);
      bounds.getSize(this.span);
      const distance = bounds.distanceToPoint(this.cameraLocal);
      const threshold = source.kind === 'entity' ? this.entitySettings.startDistance
        : Math.max(IMPOSTOR_DISTANCE, Math.max(this.span.x, this.span.y, this.span.z) * 8);
      const elevation = Math.abs(this.cameraLocal.y - this.center.y)
        / Math.max(0.001, Math.hypot(this.cameraLocal.x - this.center.x, this.cameraLocal.z - this.center.z));
      const far = renderable && distance >= threshold * (record?.far ? 0.8 : 1)
        && elevation < (record?.far ? 0.85 : 0.65);
      // Prewarm before crossing either the chosen threshold or the detail
      // window boundary, including when the player leaves it abruptly.
      if (!far && !source.retain) { if (record) record.far = false; continue; }
      if (!record) {
        if (!source.meshes.every(compatible)) continue;
        while (this.records.size >= IMPOSTOR_CACHE_LIMIT) {
          const oldest = [...this.records.values()].filter(entry => entry.used !== this.frame).sort((a, b) => a.used - b.used)[0];
          if (!oldest) break;
          this.disposeRecord(oldest);
        }
        if (this.records.size >= IMPOSTOR_CACHE_LIMIT) continue;
        const snapshots = source.meshes.map(snapshot);
        record = {
          key: source.key, source, snapshots, job: bakeCrossPlaneImpostor(snapshots),
          mesh: null, far, seen: this.frame, used: this.frame,
          worldMatrix: source.parent.matrixWorld.clone(), retain: source.retain,
        };
        this.records.set(source.key, record);
      }
      record.source = source;
      record.retain = source.retain;
      record.worldMatrix.copy(source.parent.matrixWorld);
      record.far = far;
      record.used = this.frame;
      candidates.push(record);
    }
    for (const record of this.records.values()) {
      if (record.seen === this.frame) continue;
      if (!this.proxyParent || !record.retain?.()) {
        this.disposeRecord(record);
        continue;
      }
      // Unload and deletion are different. Streaming metadata authorizes this
      // frozen silhouette; deletion removes it. Release the old scene hierarchy.
      record.source = null;
      if (!record.job) record.snapshots = [];
      candidates.push(record);
    }
    const started = performance.now();
    for (const record of candidates) {
      while (record.job && performance.now() - started < budgetMs) {
        const next = record.job.next();
        if (next.done) {
          record.job = null;
          if (next.value) {
            record.mesh = createCrossPlaneMesh(next.value);
            record.mesh.geometry.boundingBox = next.value.bounds;
            (this.proxyParent || record.source!.parent).add(record.mesh);
          }
          if (!record.source) record.snapshots = [];
        }
      }
      if (!record.mesh) continue;
      this.localCamera(cameraPosition, record.mesh.geometry.boundingBox!, record.worldMatrix);
      const withinRange = record.mesh.geometry.boundingBox!.distanceToPoint(this.cameraLocal) <= this.entitySettings.maxDistance;
      if (record.source) {
        if (!record.far) continue;
      } else {
        if (!withinRange) continue;
        // The full entity is absent here, so the size/elevation gates must not
        // suppress its only remaining representation outside the loaded window.
      }
      if (this.proxyParent) {
        this.proxyParent.updateWorldMatrix(true, false);
        record.mesh.matrixAutoUpdate = false;
        record.mesh.matrix.copy(this.proxyParent.matrixWorld).invert().multiply(record.worldMatrix);
        record.mesh.matrixWorldNeedsUpdate = true;
      }
      if (record.source?.onShow) this.restoreParts.push(record.source.onShow());
      for (const mesh of record.source?.meshes || []) {
        this.restored.push([mesh, mesh.visible]);
        mesh.visible = false;
      }
      if (record.source?.kind === 'entity' && !withinRange) continue;
      record.mesh.visible = true;
      this.restored.push([record.mesh, false]);
    }
  }

  endRender() {
    for (const [object, visible] of this.restored) object.visible = visible;
    this.restored.length = 0;
    for (const restore of this.restoreParts) restore();
    this.restoreParts.length = 0;
  }

  dispose() {
    this.endRender();
    for (const record of this.records.values()) this.disposeRecord(record);
  }
}
