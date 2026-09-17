import { TERRAIN_DITHER_GLSL } from './TerrainHandoff.ts';
import * as THREE from 'three';
import { Chunk } from '../voxel/Chunk.ts';
import type { MicroVoxelLayer } from '../voxel/MicroVoxelLayer.ts';
import type { DistantChunkSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { computeBentBoundsSphere, getWorldProjectionRevision, hookSceneMaterials } from '../torus/TorusWorld.ts';

type Solid = [number, number, number, number, number, number, number];

/** Exact vertical runs: no height-field fill beneath floating structures. */
export function captureDistantChunk(chunk: Chunk, micro: MicroVoxelLayer, revision: number): DistantChunkSnapshot {
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

/** Sparse authored geometry lives independently of the streamed terrain mips. */
export class DistantChunkLayer {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1, 2, 1, 2);
  private readonly material: THREE.MeshStandardMaterial;
  private readonly entries = new Map<string, {
    mesh: THREE.InstancedMesh; bounds: THREE.Sphere; revision: number; local: boolean;
    chunkX: number; chunkZ: number; top: number; projectionRevision: number;
  }>();
  private readonly onCoverage: (cx: number, cz: number, ready: boolean) => void;
  constructor(mask: THREE.DataTexture, onCoverage: (cx: number, cz: number, ready: boolean) => void) {
    this.onCoverage = onCoverage;
    this.group.name = 'DistantAuthoredChunks';
    this.material = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.65,
      metalness: 0.15, flatShading: true });
    this.material.onBeforeCompile = shader => {
      shader.uniforms.uDistantChunkMask = { value: mask };
      shader.vertexShader = shader.vertexShader.replace('#include <common>',
        '#include <common>\nvarying vec2 vDistantChunk;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vDistantChunk = floor(instanceMatrix[3].xz / 16.0);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
        `#include <common>\nuniform sampler2D uDistantChunkMask;\nvarying vec2 vDistantChunk;\n${TERRAIN_DITHER_GLSL}`)
        .replace('#include <color_fragment>', `
          if (terrainDither(gl_FragCoord.xy) < texture2D(uDistantChunkMask, (vDistantChunk + 0.5) / vec2(1024.0, 128.0)).r) discard;
          #include <color_fragment>`);
    };
    this.material.customProgramCacheKey = () => 'distant-authored-solids-v7';
  }
  install(chunk: DistantChunkSnapshot, local = false) {
    const key = `${chunk.chunkX},${chunk.chunkZ}`;
    const previous = this.entries.get(key);
    if (previous && !local && (previous.revision > chunk.revision
      || (!previous.local && previous.revision === chunk.revision))) return;
    // Local data stays authoritative until its accepted server revision arrives.
    const count = chunk.boxes.length / 6;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    mesh.name = `DistantAuthored:${key}`;
    mesh.frustumCulled = false;
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
      minZ: chunk.chunkZ * 16, maxZ: chunk.chunkZ * 16 + 16, minY: 0, maxY: top });
    this.group.add(mesh);
    this.entries.set(key, { mesh, bounds, revision: chunk.revision, local,
      chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, top, projectionRevision: getWorldProjectionRevision() });
    this.onCoverage(chunk.chunkX, chunk.chunkZ, true);
    if (previous) { this.group.remove(previous.mesh); previous.mesh.dispose(); }
  }
  acknowledge(cx: number, cz: number, revision: number) {
    const entry = this.entries.get(`${cx},${cz}`);
    if (entry?.local) entry.revision = Math.max(Number.isFinite(entry.revision) ? entry.revision : 0, revision);
  }
  updateView(frustum: THREE.Frustum, camera: THREE.Vector3, maxDistance: number) {
    for (const entry of this.entries.values()) {
      if (entry.projectionRevision !== getWorldProjectionRevision()) {
        computeBentBoundsSphere({ minX: entry.chunkX * 16, maxX: entry.chunkX * 16 + 16,
          minZ: entry.chunkZ * 16, maxZ: entry.chunkZ * 16 + 16, minY: 0, maxY: entry.top }, entry.bounds);
        entry.projectionRevision = getWorldProjectionRevision();
      }
      entry.mesh.visible = frustum.intersectsSphere(entry.bounds)
        && camera.distanceTo(entry.bounds.center) - entry.bounds.radius <= maxDistance;
    }
  }
  has(cx: number, cz: number) { return this.entries.has(`${cx},${cz}`); }
}
