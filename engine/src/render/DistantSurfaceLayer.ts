import { SurfaceBatch } from './SurfaceBatch.ts';
import { TerrainHandoff, TERRAIN_DITHER_GLSL } from './TerrainHandoff.ts';
import { DistantChunkLayer } from './DistantChunkLayer.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import * as THREE from 'three';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import { getTerrainKernels, type SurfaceMip, type SurfaceConnectionKernel } from '../wasm/TerrainKernels.ts';
import { prepareSurfaceSelection, surfaceNodeIndex } from '../wasm/SurfaceSelection.ts';
import { surfaceSubdivisionWorldArea, surfaceSubdivisionDistance, SURFACE_AREA_HYSTERESIS } from './SurfaceSubdivision.ts';
import {
  TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_RHO, TORUS_GREF,
  computeBentBoundsSphere, hookSceneMaterials,
} from '../torus/TorusWorld.ts';

const CHUNK_SIZE = 16;
const ZONE_SIZE_CHUNKS = 32;
const ZONE_WORLD_SIZE = CHUNK_SIZE * ZONE_SIZE_CHUNKS;
const DRAW_TILE_SIZE = 128;
// Tile-contiguous traversal makes both top and side ranges directly uploadable
// without sorting/copying a million cells at publication time.
const SURFACE_ROOT_ORIGINS: [number, number][] = [];
for (let tx = 0; tx < ZONE_WORLD_SIZE; tx += DRAW_TILE_SIZE) {
  for (let tz = 0; tz < ZONE_WORLD_SIZE; tz += DRAW_TILE_SIZE) {
    for (let x = tx; x < tx + DRAW_TILE_SIZE; x += 64) {
      for (let z = tz; z < tz + DRAW_TILE_SIZE; z += 64) SURFACE_ROOT_ORIGINS.push([x, z]);
    }
  }
}
const FINE_SAMPLE_SIZE = 1;
const LEGACY_SAMPLE_SIZE = 2;
const FINE_SAMPLES_PER_CHUNK_AXIS = CHUNK_SIZE / LEGACY_SAMPLE_SIZE;
export const MAX_DISTANT_SURFACE_CELLS = 1024 * 1024;
const MAX_SURFACE_INSTANCES = MAX_DISTANT_SURFACE_CELLS;
const MAX_SURFACE_CONNECTIONS = 4 * MAX_SURFACE_INSTANCES;
const LOD_SAMPLE_SIZES = [1, 2, 4, 8, 16, 32, 64] as const;
const FINE_WORLD_Z_AXIS = TORUS_SIZE_Z / FINE_SAMPLE_SIZE;
const WORLD_CHUNKS_X = TORUS_SIZE_X / CHUNK_SIZE;
const WORLD_CHUNKS_Z = TORUS_SIZE_Z / CHUNK_SIZE;
export interface DistantSurfaceSettings {
  subdivisionSizePx2: number;
  renderDistanceChunks: number;
  dataBudgetMiB: number;
}
export type DistantSurfaceSettingKey = keyof DistantSurfaceSettings;
export const DEFAULT_DISTANT_SURFACE_SETTINGS: Readonly<DistantSurfaceSettings> = Object.freeze({
  subdivisionSizePx2: 63, renderDistanceChunks: 2048, dataBudgetMiB: 256,
});
export const DISTANT_SURFACE_SETTING_LIMITS = Object.freeze({
  subdivisionSizePx2: Object.freeze({ min: 1, max: 256, step: 1 }),
  renderDistanceChunks: Object.freeze({ min: 32, max: 2048, step: 1 }),
  dataBudgetMiB: Object.freeze({ min: 4, max: 1024, step: 4 }),
});
/** Old pixel-error/metre distance settings have different semantics. Migrate
 * them to the new defaults while retaining the user's independent cache budget. */
export function normalizeDistantSurfaceSettings(
  value: Partial<DistantSurfaceSettings> | null | undefined,
): DistantSurfaceSettings {
  const normalized = { ...DEFAULT_DISTANT_SURFACE_SETTINGS };
  for (const key of Object.keys(normalized) as DistantSurfaceSettingKey[]) {
    const limits = DISTANT_SURFACE_SETTING_LIMITS[key];
    const candidate = value?.[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    normalized[key] = Math.max(limits.min, Math.min(limits.max,
      Math.round(candidate / limits.step) * limits.step));
  }
  return normalized;
}
// Keep the pre-camera fallback anchor stable during bootstrap. Once the bent
// camera is available, subdivision uses its projection and actual position.
const LOD_CENTER_STEP_CHUNKS = 4;
// Work in short macrotasks so
// connection generation cannot consume a complete 8.33 ms frame at 120 Hz.
const CONNECTION_BUILD_BUDGET_MS = 2;
const REFERENCE_PIXEL_SCALE = 720;
// Voxel colors are authored and serialized as sRGB hex values. Three.Color.setHex,
// used by the detailed chunk mesher, converts those values to linear RGB before
// placing them in a vertex attribute. Do the same conversion here so the two
// terrain layers receive identical lighting and tone mapping at their seam.
const SRGB_TO_LINEAR_BYTE = Uint8Array.from({ length: 256 }, (_, value) => {
  const srgb = value / 255;
  const linear = srgb <= 0.04045
    ? srgb / 12.92
    : ((srgb + 0.055) / 1.055) ** 2.4;
  return Math.round(linear * 255);
});

const SURFACE_VERTEX_DECLARATIONS = `
#define TORUS_SURFACE_POSITION
attribute vec2 surfaceOffset;
attribute float surfaceHeight;
attribute float surfaceSize;
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_BEGIN_VERTEX = `
vec3 transformed = vec3(
  position.x * surfaceSize + surfaceOffset.x,
  position.y * surfaceHeight * ${MICRO_SIZE},
  position.z * surfaceSize + surfaceOffset.y
);
vSurfaceFlatPosition = transformed.xz;
vSurfaceHeight = surfaceHeight;
`;

const SURFACE_SIDE_VERTEX_DECLARATIONS = `
#define TORUS_SURFACE_POSITION
#define TORUS_SURFACE_AXIS
#define TORUS_SURFACE_NORMAL
attribute vec2 surfaceOffset;
attribute float surfaceHeight;
attribute float surfaceBottomHeight;
attribute float surfaceSize;
attribute float surfaceAxis;
attribute vec2 surfaceNormal;
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_SIDE_BEGIN_VERTEX = `
vec2 surfaceAlong = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), surfaceAxis);
// The unit quad faces +Z when it runs on X and -X when it runs on Z. Reverse
// its along-edge coordinate for the opposite two directions so FrontSide can
// cull backfaces without making half of the terrain discontinuities vanish.
float surfaceWinding = mix(surfaceNormal.y, -surfaceNormal.x, surfaceAxis);
float surfaceAlongPosition = surfaceWinding >= 0.0 ? position.x : 1.0 - position.x;
vec2 surfaceFlatPosition = surfaceOffset + surfaceAlong * surfaceAlongPosition * surfaceSize;
vec3 transformed = vec3(
  surfaceFlatPosition.x,
  mix(surfaceBottomHeight, surfaceHeight, position.y) * ${MICRO_SIZE},
  surfaceFlatPosition.y
);
vSurfaceFlatPosition = transformed.xz - surfaceNormal * 0.01;
vSurfaceHeight = surfaceHeight;
`;

const SURFACE_FRAGMENT_DECLARATIONS = `
uniform vec2 uSurfaceWorldSize;
uniform vec2 uSurfaceWorldChunks;
uniform sampler2D uTerrainHandoff;
uniform vec2 uSurfaceTransition;
${TERRAIN_DITHER_GLSL}
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_COLOR_FRAGMENT = `
if (vSurfaceHeight < 0.5) discard;
vec2 surfaceWrapped = mod(
  mod(vSurfaceFlatPosition, uSurfaceWorldSize) + uSurfaceWorldSize,
  uSurfaceWorldSize
);
vec2 surfaceChunk = floor(surfaceWrapped / ${CHUNK_SIZE.toFixed(1)});
vec2 surfaceMaskUv = (surfaceChunk + 0.5) / uSurfaceWorldChunks;
vec2 handoff = texture2D(uTerrainHandoff, surfaceMaskUv).rg;
if (handoff.g > 0.5 || terrainDither(gl_FragCoord.xy) < handoff.r) discard;
float transitionPixel = terrainDither(gl_FragCoord.xy + vec2(37.0, 19.0));
if (transitionPixel < uSurfaceTransition.x || transitionPixel >= uSurfaceTransition.y) discard;
#include <color_fragment>
`;

interface StoredSurfaceZone {
  zoneX: number;
  zoneZ: number;
  mips: Map<number, SurfaceMip>;
  sampleSize: number;
  sourceTerrainRevision: number;
  bounds: THREE.Sphere;
}

interface ConnectedSurfaceCell {
  zoneKey: string;
  drawKey: string;
  worldX: number;
  worldZ: number;
  cellSize: number;
  height: number;
  red: number;
  green: number;
  blue: number;
}

function connectionRecords(cells: ConnectedSurfaceCell[], start: number, end: number) {
  const records = new Int32Array((end - start) * 4);
  for (let i = start; i < end; i++) {
    const cell = cells[i], offset = (i - start) * 4;
    records[offset] = cell.worldX; records[offset + 1] = cell.worldZ;
    records[offset + 2] = cell.cellSize; records[offset + 3] = cell.height;
  }
  return records;
}

interface SurfaceRange {
  topStart: number; topCount: number;
  sideStart: number; sideCount: number;
}

type SurfaceMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;

/** Bound the chord error even for elevated terrain on the tube. */
function curvatureError(size: number, heightMicro: number) {
  const rho = Math.max(1, TORUS_RHO + heightMicro * MICRO_SIZE - TORUS_GREF);
  return rho * (size / TORUS_RHO) ** 2 / 8 * 1.2;
}

function createTopGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

function createSideGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  // A connection is one exact vertical rectangle between two unequal surface
  // samples. Per-instance attributes rotate and place this unit quad.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 1, 0,
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

function createMaterial(handoff: THREE.DataTexture, side = false, coverage = new THREE.Vector2(0, 1)) {
  // Match LowPolyMesher's solid terrain response exactly at the AOI handoff.
  // Keeping shadows disabled on the distant meshes avoids expanding the local
  // 90 m shadow workload, while the shared Standard parameters remove the
  // otherwise visible Lambert/PBR color step at the seam.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: side,
    roughness: 0.65,
    metalness: 0.15,
    shadowSide: THREE.DoubleSide,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.uSurfaceWorldSize = { value: new THREE.Vector2(TORUS_SIZE_X, TORUS_SIZE_Z) };
    shader.uniforms.uSurfaceWorldChunks = { value: new THREE.Vector2(WORLD_CHUNKS_X, WORLD_CHUNKS_Z) };
    shader.uniforms.uTerrainHandoff = { value: handoff };
    shader.uniforms.uSurfaceTransition = { value: coverage };
    material.userData.shader = shader;
    const vertexDeclarations = side
      ? SURFACE_SIDE_VERTEX_DECLARATIONS
      : SURFACE_VERTEX_DECLARATIONS;
    const beginVertex = side ? SURFACE_SIDE_BEGIN_VERTEX : SURFACE_BEGIN_VERTEX;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDeclarations}`)
      .replace('#include <begin_vertex>', beginVertex);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAGMENT_DECLARATIONS}`)
      .replace('#include <color_fragment>', SURFACE_COLOR_FRAGMENT);
  };
  material.customProgramCacheKey = () => (
    side ? 'distant-surface-zone-v7-connections' : 'distant-surface-zone-v7-tops'
  );
  return material;
}

export function buildMipPyramid(zone: SurfaceZoneSnapshot): Map<number, SurfaceMip> {
  const kernels = getTerrainKernels();
  if (kernels) return kernels.buildSurfaceMips(zone, SRGB_TO_LINEAR_BYTE);
  const sampleSize = zone.sampleSize ?? LEGACY_SAMPLE_SIZE;
  const fineAxis = ZONE_WORLD_SIZE / sampleSize;
  const finestHeights = new Uint16Array(fineAxis * fineAxis);
  const finestColors = new Uint8Array(fineAxis * fineAxis * 3);
  let sourceIndex = 0;
  if (zone.sampleSize !== undefined) {
    finestHeights.set(zone.heightsMicro);
    for (let index = 0; index < finestColors.length; index++) {
      finestColors[index] = SRGB_TO_LINEAR_BYTE[zone.colors[index]];
    }
  } else for (let chunkX = 0; chunkX < ZONE_SIZE_CHUNKS; chunkX++) {
    for (let chunkZ = 0; chunkZ < ZONE_SIZE_CHUNKS; chunkZ++) {
      for (let sampleX = 0; sampleX < FINE_SAMPLES_PER_CHUNK_AXIS; sampleX++) {
        const gridX = chunkX * FINE_SAMPLES_PER_CHUNK_AXIS + sampleX;
        for (let sampleZ = 0; sampleZ < FINE_SAMPLES_PER_CHUNK_AXIS; sampleZ++) {
          const gridZ = chunkZ * FINE_SAMPLES_PER_CHUNK_AXIS + sampleZ;
          const targetIndex = gridX * fineAxis + gridZ;
          finestHeights[targetIndex] = zone.heightsMicro[sourceIndex];
          finestColors[targetIndex * 3] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3]];
          finestColors[targetIndex * 3 + 1] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3 + 1]];
          finestColors[targetIndex * 3 + 2] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3 + 2]];
          sourceIndex++;
        }
      }
    }
  }

  const mips = new Map<number, SurfaceMip>();
  let current: SurfaceMip = {
    cellSize: sampleSize,
    axis: fineAxis,
    heights: finestHeights,
    colors: finestColors,
    minHeights: zone.minHeightsMicro?.slice() ?? finestHeights.slice(),
    colorErrors: zone.colorErrors ? Float32Array.from(zone.colorErrors, value => Math.min(1, value / 255 * 2.4))
      : new Float32Array(fineAxis * fineAxis),
  };
  mips.set(current.cellSize, current);
  while (current.cellSize < 64) {
    const nextAxis = current.axis / 2;
    const nextHeights = new Uint16Array(nextAxis * nextAxis);
    const nextColors = new Uint8Array(nextAxis * nextAxis * 3);
    const minHeights = new Uint16Array(nextAxis * nextAxis);
    const colorErrors = new Float32Array(nextAxis * nextAxis);
    for (let x = 0; x < nextAxis; x++) {
      for (let z = 0; z < nextAxis; z++) {
        const targetIndex = x * nextAxis + z;
        let bestSource = (x * 2) * current.axis + z * 2;
        let bestHeight = current.heights[bestSource];
        for (let dx = 0; dx < 2; dx++) {
          for (let dz = 0; dz < 2; dz++) {
            const candidate = (x * 2 + dx) * current.axis + z * 2 + dz;
            if (current.heights[candidate] > bestHeight) {
              bestHeight = current.heights[candidate];
              bestSource = candidate;
            }
          }
        }
        nextHeights[targetIndex] = bestHeight;
        nextColors[targetIndex * 3] = current.colors[bestSource * 3];
        nextColors[targetIndex * 3 + 1] = current.colors[bestSource * 3 + 1];
        nextColors[targetIndex * 3 + 2] = current.colors[bestSource * 3 + 2];
        let minHeight = bestHeight;
        let colorError = 0;
        for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
          const candidate = (x * 2 + dx) * current.axis + z * 2 + dz;
          minHeight = Math.min(minHeight, current.minHeights[candidate]);
          let difference = 0;
          for (let channel = 0; channel < 3; channel++) {
            difference = Math.max(difference, Math.abs(current.colors[candidate * 3 + channel]
              - current.colors[bestSource * 3 + channel]) / 255);
          }
          colorError = Math.max(colorError, current.colorErrors[candidate] + difference);
        }
        minHeights[targetIndex] = minHeight;
        colorErrors[targetIndex] = Math.min(1, colorError);
      }
    }
    current = {
      cellSize: current.cellSize * 2,
      axis: nextAxis,
      heights: nextHeights,
      colors: nextColors,
      minHeights,
      colorErrors,
    };
    mips.set(current.cellSize, current);
  }
  for (const mip of mips.values()) {
    let maximum = 0;
    for (let index = 0; index < mip.heights.length; index++) {
      maximum = Math.max(maximum, (mip.heights[index] - mip.minHeights[index]) * MICRO_SIZE
        + mip.cellSize * mip.colorErrors[index] * 0.25);
    }
    mip.maxResidual = maximum;
  }
  return mips;
}

function wrappedAxisDistanceToCell(
  player: number,
  cellStart: number,
  cellSize: number,
  worldSize: number,
) {
  const center = cellStart + cellSize / 2;
  const direct = Math.abs(center - player);
  const centerDistance = Math.min(direct, worldSize - direct);
  return Math.max(0, centerDistance - cellSize / 2);
}

function quantizedChunkCenter(chunk: number, worldChunks: number) {
  const quantized = Math.round(chunk / LOD_CENTER_STEP_CHUNKS) * LOD_CENTER_STEP_CHUNKS;
  return ((quantized % worldChunks) + worldChunks) % worldChunks;
}

function yieldToRender() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** One adaptive instanced far-field layer derived from backend surface snapshots. */
export class DistantSurfaceLayer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly sideMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly detailMaskTexture: THREE.DataTexture;
  readonly authoredChunks: DistantChunkLayer;
  readonly handoff = new TerrainHandoff();
  readonly loadedZones = new Set<string>();
  private readonly detailMaskData = new Uint8Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
  private readonly zones = new Map<string, StoredSurfaceZone>();
  private settings = normalizeDistantSurfaceSettings(DEFAULT_DISTANT_SURFACE_SETTINGS);
  private offsets: Uint16Array | null = null;
  private heights: Float32Array | null = null;
  private sizes: Uint8Array | null = null;
  private colors: Uint8Array | null = null;
  private sideOffsets: Uint16Array | null = null;
  private sideHeights: Float32Array | null = null;
  private sideBottomHeights: Float32Array | null = null;
  private sideSizes: Uint8Array | null = null;
  private sideAxes: Uint8Array | null = null;
  private sideNormals: Int8Array | null = null;
  private sideColors: Uint8Array | null = null;
  private readonly connectedCells: ConnectedSurfaceCell[] = [];
  // One origin lookup per emitted LOD cell avoids a 2 m occupancy grid. A dense
  // 4000 m connection grid would reserve about 66 MB and clear it on each move.
  private readonly connectionOwners = new Map<number, Map<number, ConnectedSurfaceCell>>(
    LOD_SAMPLE_SIZES.map(sampleSize => (
      [sampleSize, new Map<number, ConnectedSurfaceCell>()] as const
    )),
  );
  private writeIndex = 0;
  private sideWriteIndex = 0;
  private connectionsReady = false;
  private connectionsDirty = true;
  private connectionBuildGeneration = 0;
  private connectionBuildPending = false;
  private enabled = true;
  private centerChunkX = 0;
  private centerChunkZ = 0;
  private lodCenterKey = '';
  private readonly ranges = new Map<string, SurfaceRange>();
  private readonly drawRanges = new Map<string, SurfaceRange>();
  private readonly batches = new Map<string, SurfaceBatch>();
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly lodPosition = new THREE.Vector3();

  private readonly cellBounds = new THREE.Sphere();
  private readonly zoneDemandSizes = new Map<string, number>();
  // 683 bytes per touched 64m root (bounded by the 8192 roots on the torus).
  private readonly rootSplits = new Map<number, Uint8Array>();
  private readonly rootCache = new Map<string, {
    zone: StoredSurfaceZone; epoch: number; cells: ConnectedSurfaceCell[];
    position: THREE.Vector3; scale: number; tolerance: number;
  }>();
  private readonly coverageEpochs = new Map<string, number>();
  private readonly cellGroups = new Map<string, ConnectedSurfaceCell[]>();
  private readonly sideCache = new Map<string, {
    dependencies: (ConnectedSurfaceCell[] | undefined)[];
    attributes: Record<string, THREE.TypedArray>; count: number;
    draws: { key: string; offset: number; count: number }[];
  }>();
  private readonly buildPosition = new THREE.Vector3();
  private buildPixelScale = REFERENCE_PIXEL_SCALE;
  private geometryAreaScale = 1;
  private buildSubdivisionAreaPx2 = DEFAULT_DISTANT_SURFACE_SETTINGS.subdivisionSizePx2;
  private rootMotionTolerance = Infinity;
  private readonly buildDetailMask = new Uint8Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
  private buildCoverageEpochs = new Map<string, number>();
  private readonly buildStats = { rebuiltRoots: 0, reusedRoots: 0, rebuiltSideZones: 0, reusedSideZones: 0, publications: 0 };
  private rebuildQueued = false;
  private hasView = false;
  private pixelScale = REFERENCE_PIXEL_SCALE;
  private lodViewKey = '';
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBuild: Promise<void> | null = null;

  constructor() {
    this.detailMaskTexture = new THREE.DataTexture(
      this.detailMaskData,
      WORLD_CHUNKS_X,
      WORLD_CHUNKS_Z,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.detailMaskTexture.name = 'DistantSurfaceDetailMask';
    this.detailMaskTexture.magFilter = THREE.NearestFilter;
    this.detailMaskTexture.minFilter = THREE.NearestFilter;
    this.detailMaskTexture.wrapS = THREE.RepeatWrapping;
    this.detailMaskTexture.wrapT = THREE.RepeatWrapping;
    this.detailMaskTexture.generateMipmaps = false;
    this.detailMaskTexture.needsUpdate = true;
    this.authoredChunks = new DistantChunkLayer(this.handoff.texture, (cx, cz) => {
      const index = cz * WORLD_CHUNKS_X + cx;
      this.handoff.setAuthored(cx, cz);
      this.invalidateCoverage(cx, cz);
      if (this.detailMaskData[index] !== 255) this.detailMaskData[index] = 128;
      this.detailMaskTexture.needsUpdate = true;
      if (this.zones.size > 0) this.requestRebuild();
      this.syncVisibility();
    });

    this.mesh = new THREE.Mesh(createTopGeometry(), createMaterial(this.handoff.texture));
    this.mesh.name = 'DistantSurfaceZones';
    this.mesh.userData.distantSurfaceZones = true;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.sideMesh = new THREE.Mesh(createSideGeometry(), createMaterial(this.handoff.texture, true));
    this.sideMesh.name = 'DistantSurfaceZoneConnections';
    this.sideMesh.visible = false;
    this.sideMesh.frustumCulled = false;
    this.sideMesh.castShadow = false;
    this.sideMesh.receiveShadow = false;
    // Keep CPU staging/diagnostic geometries out of every render pass. A zero
    // draw range alone still makes Three upload their full capacity buffers.
    // Child batches use the default camera layer independently of the parent.
    this.mesh.layers.disableAll();
    this.sideMesh.layers.disableAll();
    this.mesh.add(this.sideMesh, this.authoredChunks.group);
    hookSceneMaterials(this.mesh);
  }

  private syncVisibility() {
    this.mesh.visible = this.enabled && (this.mesh.geometry.instanceCount > 0 || this.authoredChunks.group.children.length > 0);
    this.sideMesh.visible = this.enabled && this.sideMesh.geometry.instanceCount > 0;
  }

  /** Called with the bent camera. Visibility updates immediately, without
   * rebuilding geometry when the player turns toward the opposite ring. */
  updateView(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    this.updateHandoffs();
    if (!this.enabled) return;
    if (!this.hasView) {
      // Snapshots can arrive before the far layer has received its first view.
      for (const [key, zone] of this.zones) {
        computeBentBoundsSphere({ minX: zone.zoneX * 512, maxX: (zone.zoneX + 1) * 512,
          minZ: zone.zoneZ * 512, maxZ: (zone.zoneZ + 1) * 512, minY: 0,
          maxY: Math.max(...zone.mips.get(64)!.heights) * MICRO_SIZE }, zone.bounds);
      }
      for (const [key, batch] of this.batches) batch.bounds.copy(this.drawBounds(key));
    }
    this.hasView = true;
    this.cameraPosition.copy(camera.position);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.authoredChunks.updateView(this.frustum, this.cameraPosition, (this.settings.renderDistanceChunks * CHUNK_SIZE));
    const now = performance.now();
    for (const batch of this.batches.values()) {
      const visible = this.frustum.intersectsSphere(batch.bounds);
      batch.advance(now);
      batch.setVisible(visible);
    }
    const scale = Math.max(1, viewportHeight * camera.projectionMatrix.elements[5] / 2);
    // Hysteresis avoids rebuilding for sub-pixel motion or tiny resolution changes.
    if (this.lodViewKey && this.lodPosition.distanceTo(camera.position) < 8
      && scale < this.pixelScale * 1.05 && scale > this.pixelScale / 1.05) return;
    this.lodViewKey = 'active';
    this.lodPosition.copy(camera.position);
    this.pixelScale = scale;
    if (this.zones.size > 0) this.requestRebuild();
  }

  getZoneDemand(zoneX: number, zoneZ: number): { sampleSize: number; priority: number } {
    if (!this.enabled || !this.hasView) return { sampleSize: 64, priority: 0 };
    const key = `${zoneX},${zoneZ}`;
    const sphere = this.zones.get(key)?.bounds ?? computeBentBoundsSphere({
      minX: zoneX * 512, maxX: (zoneX + 1) * 512,
      minZ: zoneZ * 512, maxZ: (zoneZ + 1) * 512, minY: 0, maxY: 256,
    }, this.cellBounds);
    // Residency is a 360-degree, position-based working set. Frustum visibility
    // only controls drawing, never source resolution, eviction or allocation.
    // Use the same hysteretic position as topology selection (not head bob).
    const distance = Math.max(0, this.lodPosition.distanceTo(sphere.center) - sphere.radius);
    let sampleSize = 64;
    const zone = this.zones.get(key);
    if (distance <= (this.settings.renderDistanceChunks * CHUNK_SIZE)) {
      // Match data demand to the geometric pixel-area budget. A tall residual
      // must not force every far-away column down to 1m when its footprint is
      // already subpixel. Unknown finer levels retain conservative bounds.
      const high = zone ? Math.max(...zone.mips.get(64)!.heights) * MICRO_SIZE : 256;
      const low = zone ? Math.min(...zone.mips.get(64)!.minHeights) * MICRO_SIZE : 0;
      for (const size of [...LOD_SAMPLE_SIZES].reverse()) {
        sampleSize = size;
        const mip = zone?.mips.get(size);
        const error = mip?.maxResidual ?? Infinity;
        const previous = this.zoneDemandSizes.get(key) ?? 64;
        const hysteresis = size > previous ? SURFACE_AREA_HYSTERESIS : 1;
        const area = surfaceSubdivisionWorldArea(size, high, low);
        if (distance >= surfaceSubdivisionDistance(area, error, this.pixelScale,
          this.settings.subdivisionSizePx2 * hysteresis)) break;
      }
    }
    this.zoneDemandSizes.set(key, sampleSize);
    return { sampleSize, priority: distance };
  }

  private requestRebuild() {
    // Coalesce downloads and camera updates. Keep the uploaded batches alive
    // until one complete top/side replacement can be published atomically.
    if (this.connectionBuildPending) { this.rebuildQueued = true; return; }
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.enabled) this.scheduleRebuild();
    }, 16);
  }

  private rangeFor(key: string, ranges = this.ranges): SurfaceRange {
    let range = ranges.get(key);
    if (!range) {
      range = { topStart: this.writeIndex, topCount: 0, sideStart: 0, sideCount: 0 };
      ranges.set(key, range);
    }
    return range;
  }

  private drawKey(zoneKey: string, worldX: number, worldZ: number) {
    return `${zoneKey}:${Math.floor(worldX % 512 / DRAW_TILE_SIZE)},${Math.floor(worldZ % 512 / DRAW_TILE_SIZE)}`;
  }

  private drawBounds(key: string) {
    const [zoneKey, tile] = key.split(':');
    const zone = this.zones.get(zoneKey)!;
    const [x, z] = tile.split(',').map(Number);
    const minX = zone.zoneX * 512 + x * DRAW_TILE_SIZE, minZ = zone.zoneZ * 512 + z * DRAW_TILE_SIZE;
    return computeBentBoundsSphere({ minX, maxX: minX + DRAW_TILE_SIZE,
      minZ, maxZ: minZ + DRAW_TILE_SIZE, minY: 0,
      maxY: Math.max(...zone.mips.get(64)!.heights) * MICRO_SIZE });
  }

  private publishBatches() {
    this.mesh.geometry.setDrawRange(0, 0);
    this.sideMesh.geometry.setDrawRange(0, 0);
    for (const [key, batch] of this.batches) {
      if (!this.zones.has(key.split(':')[0]) || !this.drawRanges.has(key)) {
        batch.dispose(); this.batches.delete(key);
      }
    }
    const now = performance.now();
    this.buildStats.publications++;
    this.mesh.userData.lodBuildStats = { ...this.buildStats };
    for (const [key, range] of this.drawRanges) {
      const zone = this.zones.get(key.split(':')[0]);
      if (!zone || (!range.topCount && !range.sideCount)) continue;
      const bounds = this.drawBounds(key);
      let batch = this.batches.get(key);
      if (!batch) {
        batch = new SurfaceBatch(this.mesh, key, bounds, (side, coverage) => {
          const mesh = new THREE.Mesh(side ? createSideGeometry() : createTopGeometry(),
            createMaterial(this.handoff.texture, side, coverage));
          mesh.frustumCulled = false;
          hookSceneMaterials(mesh);
          return mesh;
        });
        this.batches.set(key, batch);
      }
      batch.bounds.copy(bounds);
      batch.advance(now);
      const visible = !this.hasView || this.frustum.intersectsSphere(bounds);
      batch.setVisible(visible);
      batch.submit(this.mesh, range.topStart, range.topCount, this.sideMesh,
        range.sideStart, range.sideCount, this.hasView && visible, now);
    }
  }

  /** Advance before culling, including while disabling LOD. */
  updateHandoffs(now = performance.now()) {
    this.handoff.enabled.value = this.enabled;
    this.handoff.advance(now);
  }

  retainsDetailChunk(cx: number, cz: number) {
    return this.handoff.retains(cx, cz);
  }

  setEnabled(enabled: boolean): boolean {
    const next = Boolean(enabled);
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    this.updateHandoffs();
    if (!next) {
      this.connectionBuildGeneration++;
      this.connectionBuildPending = false;
      this.connectionsDirty = true;
      if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      this.hasView = false;
      this.rootCache.clear();
      this.sideCache.clear();
      this.lodViewKey = '';
      this.syncVisibility();
      return this.enabled;
    }
    if (this.zones.size > 0) {
      this.requestRebuild();
    } else {
      this.writeIndex = 0;
      this.sideWriteIndex = 0;
      this.ranges.clear();
      this.drawRanges.clear();
      this.mesh.geometry.instanceCount = 0;
      this.sideMesh.geometry.instanceCount = 0;
      this.publishBatches();
      this.syncVisibility();
    }
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Atomically hand one chunk between the snapshot surface and its detailed
   * mesh. The 128 KiB mask is sampled per fragment, so even a 64 m far cell can
   * be hidden one 16 m chunk at a time without rebuilding far topology.
   */
  setDetailChunkReady(chunkX: number, chunkZ: number, ready: boolean, immediate = false) {
    const wrappedX = ((chunkX % WORLD_CHUNKS_X) + WORLD_CHUNKS_X) % WORLD_CHUNKS_X;
    const wrappedZ = ((chunkZ % WORLD_CHUNKS_Z) + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z;
    const index = wrappedZ * WORLD_CHUNKS_X + wrappedX;
    const zoneKey = `${Math.floor(wrappedX / 32)},${Math.floor(wrappedZ / 32)}`;
    const farReady = this.batches.has(this.drawKey(zoneKey, wrappedX * 16, wrappedZ * 16))
      || this.authoredChunks.has(wrappedX, wrappedZ);
    this.handoff.setReady(wrappedX, wrappedZ, ready,
      !immediate && this.enabled && this.hasView && farReady);
    const value = ready ? 255 : this.authoredChunks.has(wrappedX, wrappedZ) ? 128 : 0;
    if (this.detailMaskData[index] === value) return;
    this.detailMaskData[index] = value;
    this.invalidateCoverage(wrappedX, wrappedZ);
    this.detailMaskTexture.needsUpdate = true;
    if (this.zones.size > 0) this.requestRebuild();
  }

  private invalidateCoverage(cx: number, cz: number) {
    // A one-chunk skirt can touch the neighbouring source zone, including the
    // two periodic seams. Invalidate only those roots, not the whole world.
    for (const x of [cx - 1, cx, cx + 1]) for (const z of [cz - 1, cz, cz + 1]) {
      const key = `${Math.floor((x + WORLD_CHUNKS_X) % WORLD_CHUNKS_X / 32)},${Math.floor((z + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z / 32)}`;
      this.coverageEpochs.set(key, (this.coverageEpochs.get(key) ?? 0) + 1);
    }
  }

  private nearDetail(worldX: number, worldZ: number, size: number, nearOnly = false) {
    // Match chunk ownership boundaries before the fragment mask cuts a hole.
    // Include one neighbouring chunk for a closed, fine-resolution handoff.
    for (let x = Math.floor(worldX / 16) - 1; x <= Math.floor((worldX + size - 1) / 16) + 1; x++) {
      for (let z = Math.floor(worldZ / 16) - 1; z <= Math.floor((worldZ + size - 1) / 16) + 1; z++) {
        const cx = (x + WORLD_CHUNKS_X) % WORLD_CHUNKS_X;
        const cz = (z + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z;
        const ownership = (this.connectionBuildPending ? this.buildDetailMask : this.detailMaskData)[cz * WORLD_CHUNKS_X + cx];
        if (nearOnly ? ownership === 255 : ownership !== 0) return true;
      }
    }
    return false;
  }

  private ensureStorage() {
    if (
      this.offsets && this.heights && this.sizes && this.colors
      && this.sideOffsets && this.sideHeights && this.sideBottomHeights
      && this.sideSizes && this.sideAxes && this.sideNormals && this.sideColors
    ) return;
    this.offsets = new Uint16Array(MAX_SURFACE_INSTANCES * 2);
    this.heights = new Float32Array(MAX_SURFACE_INSTANCES);
    this.sizes = new Uint8Array(MAX_SURFACE_INSTANCES);
    this.colors = new Uint8Array(MAX_SURFACE_INSTANCES * 3);
    this.sideOffsets = new Uint16Array(MAX_SURFACE_CONNECTIONS * 2);
    this.sideHeights = new Float32Array(MAX_SURFACE_CONNECTIONS);
    this.sideBottomHeights = new Float32Array(MAX_SURFACE_CONNECTIONS);
    this.sideSizes = new Uint8Array(MAX_SURFACE_CONNECTIONS);
    this.sideAxes = new Uint8Array(MAX_SURFACE_CONNECTIONS);
    this.sideNormals = new Int8Array(MAX_SURFACE_CONNECTIONS * 2);
    this.sideColors = new Uint8Array(MAX_SURFACE_CONNECTIONS * 3);
    this.attachTopAttributes();
    this.attachSideAttributes();
  }

  private attachTopAttributes() {
    const attributes = {
      surfaceOffset: new THREE.InstancedBufferAttribute(this.offsets!, 2),
      surfaceHeight: new THREE.InstancedBufferAttribute(this.heights!, 1),
      surfaceSize: new THREE.InstancedBufferAttribute(this.sizes!, 1),
      color: new THREE.InstancedBufferAttribute(this.colors!, 3, true),
    };
    for (const [name, attribute] of Object.entries(attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.mesh.geometry.setAttribute(name, attribute);
    }
  }

  private attachSideAttributes() {
    const attributes = {
      surfaceOffset: new THREE.InstancedBufferAttribute(this.sideOffsets!, 2),
      surfaceHeight: new THREE.InstancedBufferAttribute(this.sideHeights!, 1),
      surfaceBottomHeight: new THREE.InstancedBufferAttribute(this.sideBottomHeights!, 1),
      surfaceSize: new THREE.InstancedBufferAttribute(this.sideSizes!, 1),
      surfaceAxis: new THREE.InstancedBufferAttribute(this.sideAxes!, 1),
      surfaceNormal: new THREE.InstancedBufferAttribute(this.sideNormals!, 2, true),
      color: new THREE.InstancedBufferAttribute(this.sideColors!, 3, true),
    };
    for (const [name, attribute] of Object.entries(attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.sideMesh.geometry.setAttribute(name, attribute);
    }
  }

  private emit(
    zone: StoredSurfaceZone,
    localX: number,
    localZ: number,
    cellSize: number,
    distance: number,
  ) {
    const mip = zone.mips.get(Math.max(cellSize, zone.sampleSize))!;
    const sampleX = Math.floor(localX / mip.cellSize);
    const sampleZ = Math.floor(localZ / mip.cellSize);
    const sourceIndex = sampleX * mip.axis + sampleZ;
    const height = mip.heights[sourceIndex];
    const worldX = zone.zoneX * ZONE_WORLD_SIZE + localX;
    const worldZ = zone.zoneZ * ZONE_WORLD_SIZE + localZ;
    const red = mip.colors[sourceIndex * 3];
    const green = mip.colors[sourceIndex * 3 + 1];
    const blue = mip.colors[sourceIndex * 3 + 2];
    // Geometry stays identical between topology changes. Temporal coverage
    // resolves the new height/color each frame, including source mip arrivals.
    const zoneKey = `${zone.zoneX},${zone.zoneZ}`;
    this.appendCell({ zoneKey, drawKey: this.drawKey(zoneKey, worldX, worldZ),
      worldX, worldZ, cellSize, height, red, green, blue });
  }

  private appendCell(cell: ConnectedSurfaceCell) {
    const { zoneKey, worldX, worldZ, cellSize, height, red, green, blue } = cell;
    this.connectedCells.push(cell);
    if (height === 0) return;
    if (this.writeIndex >= MAX_SURFACE_INSTANCES) {
      throw new Error('Adaptive Space surface instance budget exceeded.');
    }
    const index = this.writeIndex++;
    const range = this.rangeFor(zoneKey);
    if (range.topCount === 0) range.topStart = index;
    range.topCount++;
    const draw = this.rangeFor(cell.drawKey, this.drawRanges);
    if (draw.topCount === 0) draw.topStart = index;
    draw.topCount++;
    this.offsets![index * 2] = worldX;
    this.offsets![index * 2 + 1] = worldZ;
    this.heights![index] = height;
    this.sizes![index] = cellSize;
    this.colors![index * 3] = red;
    this.colors![index * 3 + 1] = green;
    this.colors![index * 3 + 2] = blue;
  }

  private visitCell(zone: StoredSurfaceZone, localX: number, localZ: number, cellSize: number, work?: number[]) {
    const worldX = zone.zoneX * ZONE_WORLD_SIZE + localX;
    const worldZ = zone.zoneZ * ZONE_WORLD_SIZE + localZ;
    const playerX = (this.centerChunkX + 0.5) * CHUNK_SIZE;
    const playerZ = (this.centerChunkZ + 0.5) * CHUNK_SIZE;
    const dx = wrappedAxisDistanceToCell(playerX, worldX, cellSize, TORUS_SIZE_X);
    const dz = wrappedAxisDistanceToCell(playerZ, worldZ, cellSize, TORUS_SIZE_Z);
    let distance = Math.hypot(dx, dz);
    const mip = zone.mips.get(Math.max(cellSize, zone.sampleSize))!;
    const index = Math.floor(localX / mip.cellSize) * mip.axis + Math.floor(localZ / mip.cellSize);
    const height = mip.heights[index], minHeight = mip.minHeights[index];
    if (this.hasView) {
      computeBentBoundsSphere({ minX: worldX, maxX: worldX + cellSize,
        minZ: worldZ, maxZ: worldZ + cellSize,
        minY: minHeight * MICRO_SIZE, maxY: height * MICRO_SIZE }, this.cellBounds);
      distance = Math.max(1, (this.connectionBuildPending ? this.buildPosition : this.lodPosition).distanceTo(this.cellBounds.center) - this.cellBounds.radius);
    }
    this.rootMotionTolerance = Math.min(this.rootMotionTolerance, Math.abs(distance - (this.settings.renderDistanceChunks * CHUNK_SIZE)));
    if (distance > (this.settings.renderDistanceChunks * CHUNK_SIZE)) return;
    const error = (height - minHeight) * MICRO_SIZE + curvatureError(cellSize, height)
      + cellSize * mip.colorErrors[index] * 0.25;
    const splits = this.getRootSplits(worldX, worldZ), node = surfaceNodeIndex(localX, localZ, cellSize);
    const splitByte = node >> 3, splitBit = 1 << (node & 7);
    const areaPx2 = this.connectionBuildPending ? this.buildSubdivisionAreaPx2 : this.settings.subdivisionSizePx2;
    const threshold = areaPx2 * ((splits[splitByte] & splitBit) !== 0 ? SURFACE_AREA_HYSTERESIS : 1);
    // Below the downloaded resolution only curvature can improve. Repeating
    // one 64m height in thousands of 1m quads cannot fix its sampling error.
    const refinableError = cellSize > zone.sampleSize ? error : curvatureError(cellSize, height);
    const scale = this.connectionBuildPending ? this.buildPixelScale : this.pixelScale;
    const worldArea = surfaceSubdivisionWorldArea(cellSize, height * MICRO_SIZE, minHeight * MICRO_SIZE);
    const boundarySplit = (cellSize > 16 && this.nearDetail(worldX, worldZ, cellSize))
      || this.nearDetail(worldX, worldZ, cellSize, true);
    const mustSplit = distance < surfaceSubdivisionDistance(worldArea, refinableError, scale, threshold) || boundarySplit;
    // Reserve coverage for every remaining root; under pressure reduce quality,
    // never omit a tile. Data and geometry resolution are independent.
    const canRefine = this.writeIndex < MAX_SURFACE_INSTANCES - 4 * 8192;
    if (cellSize > FINE_SAMPLE_SIZE && mustSplit && canRefine) {
      if (!boundarySplit) this.rootMotionTolerance = Math.min(this.rootMotionTolerance,
        Math.max(0, surfaceSubdivisionDistance(worldArea, refinableError, scale, areaPx2 * SURFACE_AREA_HYSTERESIS) - distance));
      splits[splitByte] |= splitBit;
      const childSize = cellSize / 2;
      if (work) {
        work.push(localX + childSize, localZ + childSize, childSize,
          localX, localZ + childSize, childSize, localX + childSize, localZ, childSize,
          localX, localZ, childSize);
        return;
      }
      this.visitCell(zone, localX, localZ, childSize);
      this.visitCell(zone, localX + childSize, localZ, childSize);
      this.visitCell(zone, localX, localZ + childSize, childSize);
      this.visitCell(zone, localX + childSize, localZ + childSize, childSize);
      return;
    }
    if (cellSize > FINE_SAMPLE_SIZE) this.rootMotionTolerance = Math.min(this.rootMotionTolerance,
      Math.max(0, distance - surfaceSubdivisionDistance(worldArea, refinableError, scale, areaPx2)));
    splits[splitByte] &= ~splitBit;
    this.emit(zone, localX, localZ, cellSize, distance);
  }

  private getRootSplits(worldX: number, worldZ: number) {
    const key = Math.floor(worldX / 64) * 32 + Math.floor(worldZ / 64);
    let splits = this.rootSplits.get(key);
    if (!splits) { splits = new Uint8Array(683); this.rootSplits.set(key, splits); }
    return splits;
  }

  private beginWasmSelection(zone: StoredSurfaceZone, localX: number, localZ: number) {
    // One cheap host decision avoids packing thousands of unused samples for
    // distant roots that are culled or already satisfy the pixel-area budget.
    const work: number[] = [];
    this.visitCell(zone, localX, localZ, 64, work);
    if (!work.length) return null;
    const worldX = zone.zoneX * 512 + localX, worldZ = zone.zoneZ * 512 + localZ;
    const selection = prepareSurfaceSelection(zone.mips, zone.sampleSize, localX, localZ, worldX, worldZ,
      this.connectionBuildPending ? this.buildDetailMask : this.detailMaskData,
      this.getRootSplits(worldX, worldZ), this.connectionBuildPending ? this.buildPosition : this.lodPosition,
      (this.settings.renderDistanceChunks * CHUNK_SIZE), this.connectionBuildPending ? this.buildSubdivisionAreaPx2 : this.settings.subdivisionSizePx2,
      this.connectionBuildPending ? this.buildPixelScale : this.pixelScale);
    selection.work[0] = work.length;
    for (let i = 0; i < work.length; i += 3) {
      selection.work.set([work[i] - localX, work[i + 1] - localZ, work[i + 2]], i + 1);
    }
    selection.parameters[8] = this.rootMotionTolerance;
    return selection;
  }

  private async appendRoot(zone: StoredSurfaceZone, localX: number, localZ: number, generation: number) {
    if (!this.hasView) { this.visitCell(zone, localX, localZ, 64); return true; }
    const zoneKey = `${zone.zoneX},${zone.zoneZ}`, key = `${zoneKey}:${localX},${localZ}`;
    const epoch = this.buildCoverageEpochs.get(zoneKey) ?? 0;
    const cached = this.rootCache.get(key);
    if (cached && cached.zone === zone && cached.epoch === epoch
      && cached.position.distanceTo(this.buildPosition) < cached.tolerance
      && cached.scale === this.buildPixelScale
      && this.writeIndex + cached.cells.length < MAX_SURFACE_INSTANCES - 4 * 8192) {
      for (const cell of cached.cells) this.appendCell(cell);
      this.buildStats.reusedRoots++;
      return true;
    }
    const start = this.connectedCells.length;
    this.rootMotionTolerance = Infinity;
    const kernel = getTerrainKernels();
    const work = kernel ? [] : [localX, localZ, 64];
    const selection = kernel ? this.beginWasmSelection(zone, localX, localZ) : null;
    let sliceStarted = performance.now();
    while (selection ? selection.work[0] > 0 : work.length > 0) {
      if (selection && kernel) {
        const leaves = kernel.selectSurfaceBatch(selection, this.writeIndex);
        for (let i = 0; i < leaves.length; i += 3) this.emit(zone, localX + leaves[i], localZ + leaves[i + 1], leaves[i + 2], 0);
        this.rootMotionTolerance = selection.parameters[8];
      } else {
        const size = work.pop()!, z = work.pop()!, x = work.pop()!;
        this.visitCell(zone, x, z, size, work);
      }
      // A single dense root can contain thousands of leaves. Yield inside
      // subdivision too, rather than allowing a full root to block a frame.
      if (performance.now() - sliceStarted >= CONNECTION_BUILD_BUDGET_MS) {
        await yieldToRender();
        if (generation !== this.connectionBuildGeneration) return false;
        sliceStarted = performance.now();
      }
    }
    // Distance-to-sphere is 1-Lipschitz. Every visited split/merge decision
    // contributes its distance to the next SSE threshold, so unchanged roots
    // can survive large movements without loosening the pixel-area budget.
    this.rootCache.set(key, { zone, epoch, cells: this.connectedCells.slice(start),
      position: this.buildPosition.clone(), scale: this.buildPixelScale,
      tolerance: Math.max(0, this.rootMotionTolerance * 0.9) });
    this.buildStats.rebuiltRoots++;
    return true;
  }

  private appendZone(zone: StoredSurfaceZone) {
    for (const [localX, localZ] of SURFACE_ROOT_ORIGINS) {
      const kernel = this.hasView ? getTerrainKernels() : null;
      if (!kernel) { this.visitCell(zone, localX, localZ, 64); continue; }
      const selection = this.beginWasmSelection(zone, localX, localZ);
      if (!selection) continue;
      while (selection.work[0] > 0) {
        const leaves = kernel.selectSurfaceBatch(selection, this.writeIndex);
        for (let i = 0; i < leaves.length; i += 3) this.emit(zone, localX + leaves[i], localZ + leaves[i + 1], leaves[i + 2], 0);
      }
      this.rootMotionTolerance = Math.min(this.rootMotionTolerance, selection.parameters[8]);
    }
  }

  private connectionCellKey(worldX: number, worldZ: number, cellSize: number) {
    const wrappedX = ((worldX % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
    const wrappedZ = ((worldZ % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
    const originX = Math.floor(wrappedX / cellSize) * cellSize;
    const originZ = Math.floor(wrappedZ / cellSize) * cellSize;
    return (originX / FINE_SAMPLE_SIZE) * FINE_WORLD_Z_AXIS + originZ / FINE_SAMPLE_SIZE;
  }

  private emitConnection(
    cell: ConnectedSurfaceCell,
    worldX: number,
    worldZ: number,
    length: number,
    bottomHeight: number,
    axis: number,
    normalX: number,
    normalZ: number,
  ) {
    if (this.sideWriteIndex >= MAX_SURFACE_CONNECTIONS) {
      throw new Error('Connected Space surface instance budget exceeded.');
    }
    const index = this.sideWriteIndex++;
    const range = this.rangeFor(cell.zoneKey);
    if (range.sideCount === 0) range.sideStart = index;
    range.sideCount++;
    const draw = this.rangeFor(cell.drawKey, this.drawRanges);
    if (draw.sideCount === 0) draw.sideStart = index;
    draw.sideCount++;
    this.sideOffsets![index * 2] = worldX;
    this.sideOffsets![index * 2 + 1] = worldZ;
    this.sideHeights![index] = cell.height;
    this.sideBottomHeights![index] = bottomHeight;
    this.sideSizes![index] = length;
    this.sideAxes![index] = axis;
    this.sideNormals![index * 2] = normalX * 127;
    this.sideNormals![index * 2 + 1] = normalZ * 127;
    this.sideColors![index * 3] = cell.red;
    this.sideColors![index * 3 + 1] = cell.green;
    this.sideColors![index * 3 + 2] = cell.blue;
  }

  private clearConnectionOwners() {
    for (const owners of this.connectionOwners.values()) owners.clear();
  }

  private fillConnectionOwner(cell: ConnectedSurfaceCell) {
    this.connectionOwners.get(cell.cellSize)!.set(
      this.connectionCellKey(cell.worldX, cell.worldZ, cell.cellSize),
      cell,
    );
  }

  private connectionOwnerAt(worldX: number, worldZ: number, preferredSize: number) {
    const preferred = this.connectionOwners.get(preferredSize)!.get(
      this.connectionCellKey(worldX, worldZ, preferredSize),
    );
    if (preferred) return preferred;
    for (const sampleSize of LOD_SAMPLE_SIZES) {
      if (sampleSize === preferredSize) continue;
      const owner = this.connectionOwners.get(sampleSize)!.get(
        this.connectionCellKey(worldX, worldZ, sampleSize),
      );
      if (owner) return owner;
    }
    return null;
  }

  private emitCellConnections(cell: ConnectedSurfaceCell) {
    const detailBoundary = this.nearDetail(cell.worldX, cell.worldZ, cell.cellSize);
    const ownerAt = (worldX: number, worldZ: number) => {
      return this.connectionOwnerAt(worldX, worldZ, cell.cellSize);
    };
    const emitRuns = (
      axis: number,
      normalX: number,
      normalZ: number,
      neighborAt: (offset: number) => ConnectedSurfaceCell | null,
      edgeAt: (offset: number) => [number, number],
    ) => {
      let runStart = -1;
      let runBottom = -1;
      const flush = (end: number) => {
        if (runStart < 0) return;
        const [worldX, worldZ] = edgeAt(runStart);
        this.emitConnection(
          cell,
          worldX,
          worldZ,
          end - runStart,
          runBottom,
          axis,
          normalX,
          normalZ,
        );
        runStart = -1;
      };
      for (let offset = 0; offset <= cell.cellSize; offset += FINE_SAMPLE_SIZE) {
        const neighbor = offset < cell.cellSize ? neighborAt(offset) : null;
        let bottom = neighbor && cell.height > neighbor.height ? neighbor.height : -1;
        // Fine edges follow the arc above the coarse chord. Extend the fine
        // boundary below it, including equal-height patches, to close cracks.
        if (neighbor && cell.cellSize < neighbor.cellSize) {
          const skirt = Math.ceil((curvatureError(neighbor.cellSize, cell.height) + MICRO_SIZE) / MICRO_SIZE);
          bottom = Math.max(0, Math.min(neighbor.height, cell.height - skirt));
        }
        if (offset < cell.cellSize && (!neighbor || detailBoundary || neighbor.zoneKey !== cell.zoneKey)) {
          // A near mesh / authored solid can replace either neighbour without
          // sharing our maximum height. Closed skirts cover that vertical gap.
          bottom = 0;
        }
        if (bottom >= 0 && bottom === runBottom) {
          if (runStart < 0) runStart = offset;
          continue;
        }
        flush(offset);
        runBottom = bottom;
        if (bottom >= 0) runStart = offset;
      }
    };

    emitRuns(
      1, -1, 0,
      offset => ownerAt(cell.worldX - FINE_SAMPLE_SIZE, cell.worldZ + offset),
      offset => [cell.worldX, cell.worldZ + offset],
    );
    emitRuns(
      1, 1, 0,
      offset => ownerAt(cell.worldX + cell.cellSize, cell.worldZ + offset),
      offset => [cell.worldX + cell.cellSize, cell.worldZ + offset],
    );
    emitRuns(
      0, 0, -1,
      offset => ownerAt(cell.worldX + offset, cell.worldZ - FINE_SAMPLE_SIZE),
      offset => [cell.worldX + offset, cell.worldZ],
    );
    emitRuns(
      0, 0, 1,
      offset => ownerAt(cell.worldX + offset, cell.worldZ + cell.cellSize),
      offset => [cell.worldX + offset, cell.worldZ + cell.cellSize],
    );
  }

  private emitConnectionBatch(kernel: SurfaceConnectionKernel, cells: ConnectedSurfaceCell[], start: number, end: number) {
    const edges = kernel.edges(connectionRecords(cells, start, end));
    for (let i = 0; i < edges.length; i += 8) {
      this.emitConnection(cells[start + edges[i]], edges[i + 1], edges[i + 2], edges[i + 3],
        edges[i + 4], edges[i + 5], edges[i + 6], edges[i + 7]);
    }
  }

  private finishConnectionUpload(previousCount: number) {
    if (this.sideWriteIndex < previousCount) {
      this.sideHeights!.fill(0, this.sideWriteIndex, previousCount);
    }
    this.sideMesh.geometry.instanceCount = this.sideWriteIndex;
    this.uploadRange(this.sideMesh, 0, Math.max(this.sideWriteIndex, previousCount), true);
    this.syncVisibility();
    this.connectionsDirty = false;
    this.connectionBuildPending = false;
    this.publishBatches();
    if (this.rebuildQueued) { this.rebuildQueued = false; this.requestRebuild(); }
  }

  private rebuildConnections() {
    this.ensureStorage();
    this.connectionBuildGeneration++;
    this.connectionBuildPending = false;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const cells = this.connectedCells;
    this.sideWriteIndex = 0;
    for (const range of this.ranges.values()) range.sideCount = 0;
    for (const range of this.drawRanges.values()) range.sideCount = 0;
    this.clearConnectionOwners();
    const kernel = getTerrainKernels()?.createSurfaceConnections(cells.length, this.detailMaskData);
    if (kernel) {
      for (let i = 0; i < cells.length; i += 128) kernel.add(connectionRecords(cells, i, Math.min(i + 128, cells.length)));
      for (let i = 0; i < cells.length; i += 128) this.emitConnectionBatch(kernel, cells, i, Math.min(i + 128, cells.length));
    } else {
      for (const cell of cells) this.fillConnectionOwner(cell);
      for (const cell of cells) this.emitCellConnections(cell);
    }
    this.finishConnectionUpload(previousCount);
  }

  private async stageConnections(
    generation: number,
    cells: ConnectedSurfaceCell[],
  ): Promise<boolean> {
    this.sideWriteIndex = 0;
    for (const range of this.ranges.values()) range.sideCount = 0;
    for (const range of this.drawRanges.values()) range.sideCount = 0;
    this.clearConnectionOwners();

    const kernel = getTerrainKernels()?.createSurfaceConnections(cells.length, this.buildDetailMask);
    const groups = new Map<string, ConnectedSurfaceCell[]>();
    let cellIndex = 0;
    while (cellIndex < cells.length) {
      const startedAt = performance.now();
      do {
        const end = Math.min(cellIndex + 128, cells.length);
        if (kernel) kernel.add(connectionRecords(cells, cellIndex, end));
        while (cellIndex < end) {
          const cell = cells[cellIndex++];
          if (!kernel) this.fillConnectionOwner(cell);
          let group = groups.get(cell.zoneKey);
          if (!group) { group = []; groups.set(cell.zoneKey, group); }
          group.push(cell);
        }
      } while (
        cellIndex < cells.length
        && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
      );
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return false;
    }

    for (const [key, group] of groups) {
      const previous = this.cellGroups.get(key);
      if (previous?.length === group.length && group.every((cell, i) => cell === previous[i])) groups.set(key, previous);
    }
    this.cellGroups.clear();
    for (const [key, group] of groups) this.cellGroups.set(key, group);
    let sliceStarted = performance.now();
    for (const [key, group] of groups) {
      const [zx, zz] = key.split(',').map(Number);
      const dependencies: (ConnectedSurfaceCell[] | undefined)[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        dependencies.push(groups.get(`${(zx + dx + 32) % 32},${(zz + dz + 4) % 4}`));
      }
      const cached = this.sideCache.get(key);
      const range = this.rangeFor(key);
      range.sideStart = this.sideWriteIndex;
      if (cached && dependencies.every((value, i) => value === cached.dependencies[i])) {
        for (const draw of cached.draws) {
          const target = this.rangeFor(draw.key, this.drawRanges);
          target.sideStart = this.sideWriteIndex + draw.offset;
          target.sideCount = draw.count;
        }
        for (const [name, array] of Object.entries(cached.attributes)) {
          const attribute = this.sideMesh.geometry.getAttribute(name);
          attribute.array.set(array, this.sideWriteIndex * attribute.itemSize);
        }
        this.sideWriteIndex += cached.count;
        range.sideCount = cached.count;
        this.buildStats.reusedSideZones++;
      } else {
        let index = 0;
        while (index < group.length) {
          do {
            if (kernel) {
              const end = Math.min(index + 128, group.length);
              this.emitConnectionBatch(kernel, group, index, end);
              index = end;
            } else this.emitCellConnections(group[index++]);
          }
          while (index < group.length && performance.now() - sliceStarted < CONNECTION_BUILD_BUDGET_MS);
          if (performance.now() - sliceStarted >= CONNECTION_BUILD_BUDGET_MS) {
            await yieldToRender();
            if (generation !== this.connectionBuildGeneration) return false;
            sliceStarted = performance.now();
          }
        }
        const attributes: Record<string, THREE.TypedArray> = {};
        for (const [name, attribute] of Object.entries(this.sideMesh.geometry.attributes)) {
          if (attribute instanceof THREE.InstancedBufferAttribute) attributes[name] = attribute.array.slice(
            range.sideStart * attribute.itemSize, (range.sideStart + range.sideCount) * attribute.itemSize);
        }
        const draws = [...this.drawRanges].filter(([drawKey]) => drawKey.startsWith(`${key}:`))
          .map(([drawKey, draw]) => ({ key: drawKey, offset: draw.sideStart - range.sideStart, count: draw.sideCount }));
        this.sideCache.set(key, { dependencies, attributes, count: range.sideCount, draws });
        this.buildStats.rebuiltSideZones++;
      }
      if (performance.now() - sliceStarted >= CONNECTION_BUILD_BUDGET_MS) {
        await yieldToRender();
        if (generation !== this.connectionBuildGeneration) return false;
        sliceStarted = performance.now();
      }
    }
    for (const key of this.sideCache.keys()) if (!groups.has(key)) this.sideCache.delete(key);
    return true;
  }

  private scheduleConnectionRebuild(): Promise<void> {
    this.ensureStorage();
    const generation = ++this.connectionBuildGeneration;
    this.buildPosition.copy(this.lodPosition);
    this.buildPixelScale = this.pixelScale;
    this.buildDetailMask.set(this.detailMaskData);
    this.buildCoverageEpochs = new Map(this.coverageEpochs);
    this.buildStats.rebuiltRoots = this.buildStats.reusedRoots = 0;
    this.buildStats.rebuiltSideZones = this.buildStats.reusedSideZones = 0;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const cells = this.connectedCells.slice();
    this.connectionsDirty = true;
    this.connectionBuildPending = true;

    const pending = (async () => {
      // Let the final progressive top-surface upload reach WebGL before using
      // the separate side buffers for a frame-sliced connection build.
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return;
      if (!await this.stageConnections(generation, cells)) return;
      this.finishConnectionUpload(previousCount);
    })().catch(error => {
      if (generation !== this.connectionBuildGeneration) return;
      this.connectionBuildPending = false;
      console.error('Failed to rebuild distant surface connections:', error);
    });
    this.pendingBuild = pending;
    return pending;
  }

  private scheduleRebuild() {
    this.ensureStorage();
    const generation = ++this.connectionBuildGeneration;
    this.buildPosition.copy(this.lodPosition);
    this.buildPixelScale = this.pixelScale;
    this.buildDetailMask.set(this.detailMaskData);
    this.buildCoverageEpochs = new Map(this.coverageEpochs);
    this.buildStats.rebuiltRoots = this.buildStats.reusedRoots = 0;
    this.buildStats.rebuiltSideZones = this.buildStats.reusedSideZones = 0;
    const previousTopCount = this.mesh.geometry.instanceCount;
    // A single nearby zone must not spend the whole geometry budget and leave
    // the opposite ring as 64m cubes. Fit one global area threshold instead.
    // Only position/data/settings updates run this, never camera rotation.
    if (previousTopCount < MAX_SURFACE_INSTANCES * 0.4 && this.geometryAreaScale > 1) {
      this.geometryAreaScale = Math.max(1, this.geometryAreaScale * 0.75);
      this.rootCache.clear();
    }
    this.buildSubdivisionAreaPx2 = this.settings.subdivisionSizePx2 * this.geometryAreaScale;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const orderedZones = [...this.zones.values()];
    if (this.hasView) orderedZones.sort((a, b) => {
      const priority = (zone: StoredSurfaceZone) => this.lodPosition.distanceTo(zone.bounds.center) - zone.bounds.radius;
      return priority(a) - priority(b) || a.zoneX - b.zoneX || a.zoneZ - b.zoneZ;
    });
    const rootCells = orderedZones.flatMap(zone => SURFACE_ROOT_ORIGINS
      .map(([localX, localZ]) => ({ zone, localX, localZ })));
    this.connectionsDirty = true;
    this.connectionBuildPending = true;

    this.pendingBuild = (async () => {
      // Retain the currently uploaded topology until the replacement is
      // complete. Typed arrays are only sent to WebGL after every staged batch.
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return;

      for (let attempt = 0; ; attempt++) {
        this.writeIndex = 0;
        this.ranges.clear();
        this.drawRanges.clear();
        this.connectedCells.length = 0;
        let rootIndex = 0;
        while (rootIndex < rootCells.length) {
          const startedAt = performance.now();
          do {
            const root = rootCells[rootIndex];
            if (!await this.appendRoot(root.zone, root.localX, root.localZ, generation)) return;
            rootIndex++;
          } while (
            rootIndex < rootCells.length
            && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
          );
          await yieldToRender();
          if (generation !== this.connectionBuildGeneration) return;
        }
        if (this.writeIndex < MAX_SURFACE_INSTANCES - 4 * 8192 || attempt >= 6) break;
        this.geometryAreaScale *= 2;
        this.buildSubdivisionAreaPx2 = this.settings.subdivisionSizePx2 * this.geometryAreaScale;
        this.rootCache.clear();
        this.rootSplits.clear();
      }
      this.mesh.userData.lodEffectiveSubdivisionPx2 = this.buildSubdivisionAreaPx2;

      const cells = this.connectedCells.slice();
      if (!await this.stageConnections(generation, cells)) return;

      if (this.writeIndex < previousTopCount) {
        this.heights!.fill(0, this.writeIndex, previousTopCount);
      }
      this.mesh.geometry.instanceCount = this.writeIndex;
      this.uploadRange(this.mesh, 0, Math.max(this.writeIndex, previousTopCount), true);
      this.syncVisibility();
      this.finishConnectionUpload(previousCount);
    })().catch(error => {
      if (generation !== this.connectionBuildGeneration) return;
      this.connectionBuildPending = false;
      console.error('Failed to rebuild distant surface connections:', error);
    });
  }

  private uploadRange(
    mesh: THREE.Mesh<THREE.InstancedBufferGeometry>,
    start: number,
    count: number,
    replacePending = false,
  ) {
    if (count <= 0) return;
    const names = mesh === this.sideMesh
      ? [
          'surfaceOffset',
          'surfaceHeight',
          'surfaceBottomHeight',
          'surfaceSize',
          'surfaceAxis',
          'surfaceNormal',
          'color',
        ]
      : ['surfaceOffset', 'surfaceHeight', 'surfaceSize', 'color'];
    for (const name of names) {
      const attribute = mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      if (replacePending) attribute.clearUpdateRanges();
      attribute.addUpdateRange(start * attribute.itemSize, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  private rebuild() {
    this.ensureStorage();
    const previousCount = this.mesh.geometry.instanceCount;
    const previousSideCount = this.sideMesh.geometry.instanceCount;
    this.writeIndex = 0;
    this.ranges.clear();
    this.drawRanges.clear();
    this.connectedCells.length = 0;
    for (const zone of this.zones.values()) this.appendZone(zone);
    if (this.writeIndex < previousCount) {
      this.heights!.fill(0, this.writeIndex, previousCount);
    }
    this.mesh.geometry.instanceCount = this.writeIndex;
    this.uploadRange(this.mesh, 0, Math.max(this.writeIndex, previousCount), true);
    this.syncVisibility();
    if (this.connectionsReady) {
      this.rebuildConnections();
    } else {
      this.connectionBuildGeneration++;
      this.connectionBuildPending = false;
      this.sideWriteIndex = 0;
      if (previousSideCount > 0) this.sideHeights!.fill(0, 0, previousSideCount);
      this.sideMesh.geometry.instanceCount = 0;
      this.uploadRange(this.sideMesh, 0, previousSideCount, true);
      this.sideMesh.visible = false;
      this.publishBatches();
    }
  }

  installZone(zone: SurfaceZoneSnapshot) {
    const sampleSize = zone.sampleSize ?? LEGACY_SAMPLE_SIZE;
    const recordsPerZone = (ZONE_WORLD_SIZE / sampleSize) ** 2;
    if (
      !LOD_SAMPLE_SIZES.includes(sampleSize as typeof LOD_SAMPLE_SIZES[number])
      || zone.samplesPerChunkAxis !== CHUNK_SIZE / sampleSize
      || zone.zoneSizeChunks !== ZONE_SIZE_CHUNKS
      || zone.heightsMicro.length !== recordsPerZone
      || zone.colors.length !== recordsPerZone * 3
      || zone.zoneX < 0
      || zone.zoneX >= TORUS_SIZE_X / ZONE_WORLD_SIZE
      || zone.zoneZ < 0
      || zone.zoneZ >= TORUS_SIZE_Z / ZONE_WORLD_SIZE
    ) {
      throw new Error('Surface zone does not match this world.');
    }
    this.ensureStorage();
    const key = `${zone.zoneX},${zone.zoneZ}`;
    const replacing = this.zones.has(key);
    if ((this.zones.get(key)?.sourceTerrainRevision ?? -1) > zone.sourceTerrainRevision) return;
    for (const chunk of zone.detailChunks ?? []) this.authoredChunks.install(chunk);
    const mips = buildMipPyramid(zone);
    const coarsest = mips.get(64)!;
    const stored = { zoneX: zone.zoneX, zoneZ: zone.zoneZ, mips, sampleSize,
      sourceTerrainRevision: zone.sourceTerrainRevision,
      bounds: computeBentBoundsSphere({ minX: zone.zoneX * 512, maxX: (zone.zoneX + 1) * 512,
        minZ: zone.zoneZ * 512, maxZ: (zone.zoneZ + 1) * 512,
        minY: 0, maxY: Math.max(...coarsest.heights) * MICRO_SIZE }),
    };
    this.zones.set(key, stored);
    this.loadedZones.add(key);
    this.connectionsDirty = true;
    if (!this.enabled) return;
    if (replacing || this.hasView || this.connectionBuildPending || this.rebuildTimer !== null) {
      this.connectionsReady = true;
      this.requestRebuild();
      return;
    }
    const start = this.writeIndex;
    this.appendZone(stored);
    this.mesh.geometry.instanceCount = this.writeIndex;
    this.uploadRange(this.mesh, start, this.writeIndex - start);
    this.syncVisibility();
    this.publishBatches();
    if (this.connectionsReady) void this.scheduleConnectionRebuild();
  }

  async finalizeConnections(waitForIdle = true) {
    this.connectionsReady = true;
    if (!this.enabled) return;
    if (!waitForIdle) {
      if (this.connectionsDirty) this.requestRebuild();
      return;
    }
    // Drain coalesced work too, including installs arriving during a build.
    do {
      if (this.connectionBuildPending) await this.pendingBuild;
      else if (this.rebuildTimer !== null) {
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = null;
        this.scheduleRebuild();
        await this.pendingBuild;
      } else if (this.connectionsDirty) await this.scheduleConnectionRebuild();
      else break;
    } while (this.enabled);
  }

  removeZone(zoneX: number, zoneZ: number) {
    const key = `${zoneX},${zoneZ}`;
    if (!this.zones.delete(key)) return;
    this.loadedZones.delete(key);
    for (const root of this.rootCache.keys()) if (root.startsWith(`${key}:`)) this.rootCache.delete(root);
    this.sideCache.delete(key);
    this.cellGroups.delete(key);
    this.connectionsDirty = true;
    if (!this.enabled) return;
    if (this.hasView) {
      for (const [drawKey, batch] of this.batches) if (drawKey.startsWith(`${key}:`)) {
        batch.dispose();
        this.batches.delete(drawKey);
      }
      this.requestRebuild();
      return;
    }
    this.rebuild();
  }

  getSettings(): DistantSurfaceSettings {
    return { ...this.settings };
  }

  setSettings(value: Partial<DistantSurfaceSettings>): DistantSurfaceSettings {
    const next = normalizeDistantSurfaceSettings({ ...this.settings, ...value });
    const changed = (Object.keys(next) as DistantSurfaceSettingKey[])
      .some(key => next[key] !== this.settings[key]);
    if (!changed) return this.getSettings();
    const geometryChanged = next.subdivisionSizePx2 !== this.settings.subdivisionSizePx2
      || next.renderDistanceChunks !== this.settings.renderDistanceChunks;
    this.settings = next;
    if (geometryChanged) { this.geometryAreaScale = 1; this.rootCache.clear(); }
    if (geometryChanged && this.enabled && this.zones.size > 0) {
      if (this.connectionsReady) this.requestRebuild();
      else this.rebuild();
    }
    return this.getSettings();
  }

  setNearField(centerChunkX: number, centerChunkZ: number, _renderDistance: number) {
    const lodCenterChunkX = quantizedChunkCenter(centerChunkX, TORUS_SIZE_X / CHUNK_SIZE);
    const lodCenterChunkZ = quantizedChunkCenter(centerChunkZ, TORUS_SIZE_Z / CHUNK_SIZE);
    const nextLodCenterKey = `${lodCenterChunkX},${lodCenterChunkZ}`;
    if (nextLodCenterKey === this.lodCenterKey) return;
    this.centerChunkX = lodCenterChunkX;
    this.centerChunkZ = lodCenterChunkZ;
    this.lodCenterKey = nextLodCenterKey;
    if (this.enabled && !this.hasView && this.zones.size > 0) {
      // Progressive zone installation writes into the same staging arrays, so
      // only defer topology moves after the initial snapshot set is complete.
      if (this.connectionsReady) this.requestRebuild();
      else this.rebuild();
    }
  }
}
