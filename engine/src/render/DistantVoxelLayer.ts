import * as THREE from 'three';
import { SurfaceBatch } from './SurfaceBatch.ts';
import { TERRAIN_DITHER_GLSL } from './TerrainHandoff.ts';
import { computeBentBoundsSphere, hookSceneMaterials, getWorldProjectionRevision } from '../torus/TorusWorld.ts';
import { surfaceSubdivisionWorldArea, SURFACE_AREA_HYSTERESIS } from './SurfaceSubdivision.ts';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';

type FaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
type Range = { start: number; end: number };
type Brick = { x: number; y: number; z: number; bounds: THREE.Sphere; size: number };
type Zone = { snapshot: SurfaceZoneSnapshot; mips: Map<number, { faces: Uint8Array; ranges: Map<number, Range> }>;
  bricks: Map<number, Brick>; batches: Map<number, SurfaceBatch>; tileSignatures: Map<number, string>;
  signature: string; projection: number };
const LINEAR = Uint8Array.from({ length: 256 }, (_, n) => Math.round(255 * (n / 255 <= .04045
  ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4)));
// Packed attributes use 15 bytes per face (60 MiB at the limit), before
// reusable transition slots and GPU copies. Keep all directions resident.
export const MAX_VOXEL_LOD_FACES = 4 * 1024 * 1024;

function geometry() {
  const result = new THREE.InstancedBufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
  result.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0, 0,1,0], 3));
  result.setIndex([0,1,2,0,2,3]); result.instanceCount = 0;
  return result;
}
function material(mask: THREE.DataTexture, coverage: THREE.Vector2, origin: THREE.Vector3) {
  const result = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .65, metalness: .15 });
  result.onBeforeCompile = shader => {
    shader.uniforms.uVoxelHandoff = { value: mask };
    shader.uniforms.uVoxelTransition = { value: coverage };
    shader.uniforms.uVoxelOrigin = { value: origin };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      #define TORUS_VOXEL_POSITION
      attribute vec3 voxelOffset;
      attribute vec2 voxelSpan;
      attribute float voxelDirection;
      attribute float voxelEmission;
      uniform vec3 uVoxelOrigin;
      varying vec2 vVoxelFlat;
      varying float vVoxelEmission;
      vec3 voxelNormal() {
        float sign = mod(voxelDirection, 2.0) * 2.0 - 1.0;
        return voxelDirection < 2.0 ? vec3(sign,0,0) : voxelDirection < 4.0 ? vec3(0,sign,0) : vec3(0,0,sign);
      }
      vec3 voxelPosition(vec2 uv) {
        if (mod(voxelDirection, 2.0) < .5) uv.x = 1.0 - uv.x;
        vec2 p = uv * voxelSpan * .125;
        return uVoxelOrigin + voxelOffset * .125 + (voxelDirection < 2.0 ? vec3(0,p.x,p.y)
          : voxelDirection < 4.0 ? vec3(p.y,0,p.x) : vec3(p.x,p.y,0));
      }`).replace('#include <begin_vertex>', `vec3 transformed = voxelPosition(position.xy);
        vVoxelFlat = transformed.xz - voxelNormal().xz * .01;
        vVoxelEmission = voxelEmission;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D uVoxelHandoff;
      uniform vec2 uVoxelTransition;
      varying vec2 vVoxelFlat;
      varying float vVoxelEmission;
      ${TERRAIN_DITHER_GLSL}`)
      .replace('#include <color_fragment>', `
        vec2 chunk = floor(mod(mod(vVoxelFlat, vec2(16384.,2048.)) + vec2(16384.,2048.), vec2(16384.,2048.)) / 16.);
        vec2 handoff = texture2D(uVoxelHandoff, (chunk + .5) / vec2(1024.,128.)).rg;
        if (handoff.g > .5 || terrainDither(gl_FragCoord.xy) < handoff.r) discard;
        float transition = terrainDither(gl_FragCoord.xy + vec2(37.,19.));
        if (transition < uVoxelTransition.x || transition >= uVoxelTransition.y) discard;
        #include <color_fragment>`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vVoxelEmission * vColor.rgb * 3.0;');
  };
  result.customProgramCacheKey = () => 'volumetric-terrain-packed-v2';
  return result;
}

/** Independent 64^3 bricks, seven 3D mip levels, hidden-face removal and greedy
 * quads. Camera rotation only changes frustum culling, never topology/residency. */
export class DistantVoxelLayer {
  readonly group = new THREE.Group();
  private readonly zones = new Map<string, Zone>();
  private readonly camera = new THREE.Vector3();
  private focal = 720;
  private area = 16;
  private areaScale = 1;
  private distance = 32768;
  private hasView = false;
  private budgetDirty = false;
  private readonly mask: THREE.DataTexture;
  constructor(mask: THREE.DataTexture) { this.mask = mask; this.group.name = 'DistantVoxelTerrain'; }
  hasZone(x: number, z: number) { return this.zones.has(`${x},${z}`); }
  install(snapshot: SurfaceZoneSnapshot) {
    const key = `${snapshot.zoneX},${snapshot.zoneZ}`, previous = this.zones.get(key);
    const mips: Zone['mips'] = new Map(), bricks: Zone['bricks'] = new Map();
    for (const mip of snapshot.voxelMips!) {
      const view = new DataView(mip.faces.buffer, mip.faces.byteOffset, mip.faces.byteLength), ranges = new Map<number, Range>();
      for (let at = 0; at < mip.faces.length; at += 16) {
        const p = [view.getUint16(at, true), view.getUint16(at + 2, true), view.getUint16(at + 4, true)];
        const dir = mip.faces[at + 10]; p[dir >> 1] += dir & 1 ? -.5 : .5;
        const [x,y,z] = p.map(n => Math.floor(n / 512));
        const id = x * 32 + y * 8 + z;
        const range = ranges.get(id);
        if (range) range.end = at + 16; else ranges.set(id, { start: at, end: at + 16 });
        if (!bricks.has(id)) bricks.set(id, { x, y, z, size: previous?.bricks.get(id)?.size ?? 64,
          bounds: computeBentBoundsSphere({ minX: snapshot.zoneX * 512 + x * 64, maxX: snapshot.zoneX * 512 + (x + 1) * 64,
            minY: y * 64, maxY: (y + 1) * 64, minZ: snapshot.zoneZ * 512 + z * 64, maxZ: snapshot.zoneZ * 512 + (z + 1) * 64 }) });
      }
      mips.set(mip.cellSize, { faces: mip.faces, ranges });
    }
    const zone: Zone = { snapshot, mips, bricks, batches: previous?.batches ?? new Map(), tileSignatures: new Map(),
      signature: '', projection: getWorldProjectionRevision() };
    this.zones.set(key, zone);
    this.fitBudget();
    for (const current of this.zones.values()) this.select(current, current === zone);
  }
  private make = (coverage: THREE.Vector2, origin: THREE.Vector3): FaceMesh => {
    const mesh = new THREE.Mesh(geometry(), material(this.mask, coverage, origin));
    mesh.frustumCulled = false;
    hookSceneMaterials(mesh);
    return mesh;
  };
  private fitBudget() {
    this.budgetDirty = false;
    // Search from the requested quality on every source change. Estimation
    // must not mutate hysteresis history, or repeated probes coarsen twice.
    const measure = () => {
      let faces = 0;
      for (const zone of this.zones.values()) faces += this.select(zone, false, true) ?? 0;
      return faces;
    };
    this.areaScale = 1;
    let faces = measure(), lower = 1;
    while (faces > MAX_VOXEL_LOD_FACES && this.areaScale < 65536) {
      lower = this.areaScale;
      this.areaScale *= 2;
      faces = measure();
    }
    if (this.areaScale > 1) {
      let upper = this.areaScale;
      for (let attempt = 0; attempt < 8; attempt++) {
        this.areaScale = (lower + upper) / 2;
        if (measure() > MAX_VOXEL_LOD_FACES) lower = this.areaScale;
        else upper = this.areaScale;
      }
      this.areaScale = upper;
      faces = measure();
    }
    this.group.userData.voxelLodStats = { faces, budget: MAX_VOXEL_LOD_FACES,
      requestedAreaPx2: this.area, effectiveAreaPx2: this.area * this.areaScale };
  }
  private select(zone: Zone, force = false, estimateOnly = false) {
    const sizes = [...zone.mips.keys()].sort((a,b) => b-a), selected = new Map<number, number>();
    const projection = getWorldProjectionRevision();
    for (const [id, brick] of zone.bricks) {
      if (zone.projection !== projection) computeBentBoundsSphere({
        minX: zone.snapshot.zoneX * 512 + brick.x * 64, maxX: zone.snapshot.zoneX * 512 + (brick.x + 1) * 64,
        minY: brick.y * 64, maxY: (brick.y + 1) * 64,
        minZ: zone.snapshot.zoneZ * 512 + brick.z * 64, maxZ: zone.snapshot.zoneZ * 512 + (brick.z + 1) * 64 }, brick.bounds);
      const distance = Math.max(1, this.camera.distanceTo(brick.bounds.center) - brick.bounds.radius);
      let size = 64;
      if (this.hasView && distance <= this.distance) for (const candidate of sizes) {
        size = candidate;
        const area = surfaceSubdivisionWorldArea(size, brick.y * 64 + size, brick.y * 64);
        if (area * (this.focal / distance) ** 2 <= this.area * this.areaScale * (size > brick.size ? SURFACE_AREA_HYSTERESIS : 1)) break;
      }
      selected.set(id, size);
    }
    zone.projection = projection;
    if (estimateOnly) {
      let count = 0;
      for (const [id, size] of selected) {
        const range = zone.mips.get(size)!.ranges.get(id);
        if (range) count += (range.end - range.start) / 16;
      }
      return count;
    }
    for (const [id, size] of selected) zone.bricks.get(id)!.size = size;
    const signature = `${projection}/` + [...selected].map(([id,size]) => `${id}:${size}`).join('/');
    if (!force && signature === zone.signature) return;
    zone.signature = signature;
    for (let tx = 0; tx < 4; tx++) for (let tz = 0; tz < 4; tz++) {
      const ranges: { faces: Uint8Array; start: number; end: number }[] = [];
      let count = 0;
      let tileSignature = `${projection}`;
      for (const [id, brick] of zone.bricks) {
        if ((brick.x >> 1) !== tx || (brick.z >> 1) !== tz) continue;
        tileSignature += `/${id}:${selected.get(id)}`;
        const mip = zone.mips.get(selected.get(id)!)!, range = mip.ranges.get(id);
        if (range) { ranges.push({ faces: mip.faces, ...range }); count += (range.end - range.start) / 16; }
      }
      const tile = tx * 4 + tz;
      if (!force && zone.tileSignatures.get(tile) === tileSignature) continue;
      zone.tileSignatures.set(tile, tileSignature);
      if (!count && !zone.batches.has(tile)) continue;
      const offset = new Uint16Array(count * 3), span = new Uint16Array(count * 2);
      const colors = new Uint8Array(count * 3), directions = new Uint8Array(count), emission = new Uint8Array(count);
      let index = 0;
      for (const range of ranges) {
        const view = new DataView(range.faces.buffer, range.faces.byteOffset, range.faces.byteLength);
        for (let at = range.start; at < range.end; at += 16) {
          offset[index * 3] = view.getUint16(at,true);
          offset[index * 3 + 1] = view.getUint16(at + 2,true);
          offset[index * 3 + 2] = view.getUint16(at + 4,true);
          span[index * 2] = view.getUint16(at + 6,true);
          span[index * 2 + 1] = view.getUint16(at + 8,true);
          directions[index] = range.faces[at + 10]; emission[index] = range.faces[at + 11];
          colors[index * 3] = LINEAR[range.faces[at+12]];
          colors[index * 3 + 1] = LINEAR[range.faces[at+13]];
          colors[index * 3 + 2] = LINEAR[range.faces[at+14]];
          index++;
        }
      }
      const source = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial());
      for (const [name, array, size, normalized] of [
        ['voxelOffset',offset,3,false], ['voxelSpan',span,2,false], ['voxelDirection',directions,1,false],
        ['voxelEmission',emission,1,false], ['color',colors,3,true],
      ] as const) source.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size, normalized));
      source.geometry.instanceCount = count;
      let batch = zone.batches.get(tile);
      const bounds = computeBentBoundsSphere({ minX: zone.snapshot.zoneX * 512 + tx * 128, maxX: zone.snapshot.zoneX * 512 + (tx + 1) * 128,
        minY: 0, maxY: 256, minZ: zone.snapshot.zoneZ * 512 + tz * 128, maxZ: zone.snapshot.zoneZ * 512 + (tz + 1) * 128 });
      if (!batch) {
        const origin = new THREE.Vector3(zone.snapshot.zoneX * 512, 0, zone.snapshot.zoneZ * 512);
        batch = new SurfaceBatch(this.group, `voxel:${zone.snapshot.zoneX},${zone.snapshot.zoneZ}:${tile}`, bounds,
          (_side, coverage) => this.make(coverage, origin));
        zone.batches.set(tile, batch);
      }
      batch.bounds.copy(bounds);
      batch.submit(source, 0, count, source, 0, 0, this.hasView);
      source.geometry.dispose(); source.material.dispose();
    }
  }
  updateView(frustum: THREE.Frustum, camera: THREE.Vector3, focal: number, area: number, distance: number) {
    const changed = !this.hasView || this.camera.distanceTo(camera) >= 8 || Math.abs(focal / this.focal - 1) > .05
      || area !== this.area || distance !== this.distance || this.budgetDirty;
    this.hasView = true; this.distance = distance;
    if (changed) { this.camera.copy(camera); this.focal = focal; this.area = area; }
    if (changed) { this.areaScale = 1; this.fitBudget(); }
    for (const zone of this.zones.values()) {
      if (changed || zone.projection !== getWorldProjectionRevision()) this.select(zone);
      for (const batch of zone.batches.values()) {
        batch.advance();
        batch.setVisible(frustum.intersectsSphere(batch.bounds) && camera.distanceTo(batch.bounds.center) - batch.bounds.radius <= this.distance);
      }
    }
  }
  removeZone(x: number, z: number) {
    const key = `${x},${z}`, zone = this.zones.get(key);
    if (!zone) return;
    for (const batch of zone.batches.values()) batch.dispose();
    this.zones.delete(key);
    this.budgetDirty = true;
  }
}
