import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import * as THREE from 'three';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import {
  TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_RHO, TORUS_GREF,
  computeBentBoundsSphere, getWorldShapeMode, hookSceneMaterials,
} from '../torus/TorusWorld.ts';

const CHUNK_SIZE = 16;
const ZONE_SIZE_CHUNKS = 32;
const ZONE_WORLD_SIZE = CHUNK_SIZE * ZONE_SIZE_CHUNKS;
const FINE_SAMPLE_SIZE = 2;
const FINE_SAMPLES_PER_CHUNK_AXIS = CHUNK_SIZE / FINE_SAMPLE_SIZE;
const MAX_SURFACE_INSTANCES = 512 * 1024;
const MAX_SURFACE_CONNECTIONS = 1024 * 1024;
const LOD_SAMPLE_SIZES = [2, 4, 8, 16, 32, 64] as const;
const FINE_WORLD_Z_AXIS = TORUS_SIZE_Z / FINE_SAMPLE_SIZE;
const WORLD_CHUNKS_X = TORUS_SIZE_X / CHUNK_SIZE;
const WORLD_CHUNKS_Z = TORUS_SIZE_Z / CHUNK_SIZE;
const DISTANCE_STEP = 50;

export interface DistantSurfaceSettings {
  lod2Distance: number;
  lod4Distance: number;
  lod8Distance: number;
  lod16Distance: number;
  lod32Distance: number;
  maxDistance: number;
  connectionDistance: number;
  lod2Enabled: boolean;
  lod4Enabled: boolean;
  lod8Enabled: boolean;
  lod16Enabled: boolean;
  lod32Enabled: boolean;
  lod64Enabled: boolean;
}

export type DistantSurfaceSettingKey = keyof DistantSurfaceSettings;
export type DistantSurfaceDistanceSettingKey =
  | 'lod2Distance'
  | 'lod4Distance'
  | 'lod8Distance'
  | 'lod16Distance'
  | 'lod32Distance'
  | 'maxDistance'
  | 'connectionDistance';
export type DistantSurfaceEnabledSettingKey =
  | 'lod2Enabled'
  | 'lod4Enabled'
  | 'lod8Enabled'
  | 'lod16Enabled'
  | 'lod32Enabled'
  | 'lod64Enabled';

export const DEFAULT_DISTANT_SURFACE_SETTINGS: Readonly<DistantSurfaceSettings> = Object.freeze({
  lod2Distance: 400,
  lod4Distance: 600,
  lod8Distance: 800,
  lod16Distance: 1000,
  lod32Distance: 1600,
  maxDistance: 8500,
  connectionDistance: 4000,
  lod2Enabled: true,
  lod4Enabled: true,
  lod8Enabled: true,
  lod16Enabled: true,
  lod32Enabled: true,
  lod64Enabled: true,
});

export const DISTANT_SURFACE_SETTING_LIMITS = Object.freeze({
  lod2Distance: Object.freeze({ min: 100, max: 500, step: DISTANCE_STEP }),
  lod4Distance: Object.freeze({ min: 150, max: 1000, step: DISTANCE_STEP }),
  lod8Distance: Object.freeze({ min: 200, max: 1600, step: DISTANCE_STEP }),
  lod16Distance: Object.freeze({ min: 250, max: 3000, step: DISTANCE_STEP }),
  lod32Distance: Object.freeze({ min: 300, max: 8450, step: DISTANCE_STEP }),
  maxDistance: Object.freeze({ min: 350, max: 8500, step: DISTANCE_STEP }),
  connectionDistance: Object.freeze({ min: 0, max: 8500, step: 250 }),
});

const LOD_SETTING_KEYS = [
  'lod2Distance',
  'lod4Distance',
  'lod8Distance',
  'lod16Distance',
  'lod32Distance',
] as const;
const LOD_ENABLED_KEYS = [
  'lod2Enabled',
  'lod4Enabled',
  'lod8Enabled',
  'lod16Enabled',
  'lod32Enabled',
  'lod64Enabled',
] as const;
const ORDERED_DISTANCE_KEYS = [...LOD_SETTING_KEYS, 'maxDistance'] as const;

function snapDistance(value: unknown, fallback: number, step: number) {
  const numeric = Number(value);
  return Math.round((Number.isFinite(numeric) ? numeric : fallback) / step) * step;
}

export function normalizeDistantSurfaceSettings(
  value: Partial<DistantSurfaceSettings> | null | undefined,
): DistantSurfaceSettings {
  const normalized = {} as DistantSurfaceSettings;
  let previous = -DISTANCE_STEP;
  for (const key of ORDERED_DISTANCE_KEYS) {
    const limits = DISTANT_SURFACE_SETTING_LIMITS[key];
    const candidate = snapDistance(
      value?.[key],
      DEFAULT_DISTANT_SURFACE_SETTINGS[key],
      limits.step,
    );
    normalized[key] = Math.max(
      limits.min,
      previous + DISTANCE_STEP,
      Math.min(limits.max, candidate),
    );
    previous = normalized[key];
  }
  for (const key of LOD_ENABLED_KEYS) {
    normalized[key] = typeof value?.[key] === 'boolean'
      ? value[key]
      : DEFAULT_DISTANT_SURFACE_SETTINGS[key];
  }
  const connectionLimits = DISTANT_SURFACE_SETTING_LIMITS.connectionDistance;
  normalized.connectionDistance = Math.max(
    connectionLimits.min,
    Math.min(
      connectionLimits.max,
      snapDistance(
        value?.connectionDistance,
        DEFAULT_DISTANT_SURFACE_SETTINGS.connectionDistance,
        connectionLimits.step,
      ),
    ),
  );
  return normalized;
}
// Move the legacy distance-only topology anchor in 64 m increments. Chunk crossings
// then avoid rebuilding roughly 190k surface cells; a separate ready mask
// handles the exact per-chunk transition to detailed terrain.
const LOD_CENTER_STEP_CHUNKS = 4;
// A topology move may inspect roughly 190k cells. Work in short macrotasks so
// connection generation cannot consume a complete 8.33 ms frame at 120 Hz.
const CONNECTION_BUILD_BUDGET_MS = 2;
const MAX_SCREEN_ERROR_PX = 2;
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
vSurfaceFlatPosition = transformed.xz;
vSurfaceHeight = surfaceHeight;
`;

const SURFACE_FRAGMENT_DECLARATIONS = `
uniform vec2 uSurfaceWorldSize;
uniform vec2 uSurfaceWorldChunks;
uniform sampler2D uSurfaceDetailMask;
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
if (texture2D(uSurfaceDetailMask, surfaceMaskUv).r > 0.5) discard;
#include <color_fragment>
`;

interface SurfaceMip {
  cellSize: number;
  axis: number;
  heights: Uint16Array;
  colors: Uint8Array;
  minHeights: Uint16Array;
  colorErrors: Float32Array;
}

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
  worldX: number;
  worldZ: number;
  cellSize: number;
  height: number;
  red: number;
  green: number;
  blue: number;
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

function createMaterial(detailMask: THREE.DataTexture, side = false) {
  // Match LowPolyMesher's solid terrain response exactly at the AOI handoff.
  // Keeping shadows disabled on the distant meshes avoids expanding the local
  // 90 m shadow workload, while the shared Standard parameters remove the
  // otherwise visible Lambert/PBR color step at the seam.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.65,
    metalness: 0.15,
    shadowSide: THREE.DoubleSide,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.uSurfaceWorldSize = { value: new THREE.Vector2(TORUS_SIZE_X, TORUS_SIZE_Z) };
    shader.uniforms.uSurfaceWorldChunks = { value: new THREE.Vector2(WORLD_CHUNKS_X, WORLD_CHUNKS_Z) };
    shader.uniforms.uSurfaceDetailMask = { value: detailMask };
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
    side ? 'distant-surface-zone-v4-connections' : 'distant-surface-zone-v4-tops'
  );
  return material;
}

function buildMipPyramid(zone: SurfaceZoneSnapshot): Map<number, SurfaceMip> {
  const sampleSize = zone.sampleSize ?? FINE_SAMPLE_SIZE;
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
    minHeights: finestHeights.slice(),
    colorErrors: new Float32Array(fineAxis * fineAxis),
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

function desiredSampleSize(distance: number, settings: DistantSurfaceSettings): number | null {
  const bands = ORDERED_DISTANCE_KEYS.map(key => settings[key]);
  for (let index = 0; index < bands.length; index++) {
    if (distance <= bands[index] && settings[LOD_ENABLED_KEYS[index]]) {
      return LOD_SAMPLE_SIZES[index];
    }
  }
  return null;
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
  readonly loadedZones = new Set<string>();
  private readonly detailMaskData = new Uint8Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
  private readonly zones = new Map<string, StoredSurfaceZone>();
  private settings = normalizeDistantSurfaceSettings(DEFAULT_DISTANT_SURFACE_SETTINGS);
  private offsets: Uint16Array | null = null;
  private heights: Uint16Array | null = null;
  private sizes: Uint8Array | null = null;
  private colors: Uint8Array | null = null;
  private sideOffsets: Uint16Array | null = null;
  private sideHeights: Uint16Array | null = null;
  private sideBottomHeights: Uint16Array | null = null;
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
  private readonly batches = new Map<string, { top: SurfaceMesh; side: SurfaceMesh; bounds: THREE.Sphere }>();
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly lodPosition = new THREE.Vector3();
  private readonly cellBounds = new THREE.Sphere();
  private readonly recentlyVisible = new Map<string, number>();
  private readonly zoneDemandSizes = new Map<string, number>();
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

    this.mesh = new THREE.Mesh(createTopGeometry(), createMaterial(this.detailMaskTexture));
    this.mesh.name = 'DistantSurfaceZones';
    this.mesh.userData.distantSurfaceZones = true;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.sideMesh = new THREE.Mesh(createSideGeometry(), createMaterial(this.detailMaskTexture, true));
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
    this.mesh.add(this.sideMesh);
    hookSceneMaterials(this.mesh);
  }

  private syncVisibility() {
    this.mesh.visible = this.enabled && this.mesh.geometry.instanceCount > 0;
    this.sideMesh.visible = this.enabled && this.sideMesh.geometry.instanceCount > 0;
  }

  /** Called with the bent camera. Visibility updates immediately, without
   * rebuilding geometry when the player turns toward the opposite ring. */
  updateView(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    if (!this.enabled || getWorldShapeMode() !== 'torus') return;
    if (!this.hasView) {
      // Snapshots can arrive while Earth mode has the far layer disabled.
      for (const [key, zone] of this.zones) {
        computeBentBoundsSphere({ minX: zone.zoneX * 512, maxX: (zone.zoneX + 1) * 512,
          minZ: zone.zoneZ * 512, maxZ: (zone.zoneZ + 1) * 512, minY: 0,
          maxY: Math.max(...zone.mips.get(64)!.heights) * MICRO_SIZE }, zone.bounds);
        this.batches.get(key)?.bounds.copy(zone.bounds);
      }
    }
    this.hasView = true;
    this.cameraPosition.copy(camera.position);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    const now = performance.now();
    for (const [key, batch] of this.batches) {
      const visible = this.frustum.intersectsSphere(batch.bounds);
      batch.top.visible = visible && batch.top.geometry.instanceCount > 0;
      batch.side.visible = visible && batch.side.geometry.instanceCount > 0;
      if (visible) this.recentlyVisible.set(key, now);
    }
    const scale = Math.max(1, viewportHeight * camera.projectionMatrix.elements[5] / 2);
    // A stable 64 m cell and a 10% projection step avoid rebuilding for small
    // motion, zoom changes, or adaptive-resolution fluctuations.
    if (this.lodViewKey && this.lodPosition.distanceTo(camera.position) < 64
      && scale < this.pixelScale * 1.1 && scale > this.pixelScale / 1.1) return;
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
    const distance = Math.max(0, this.cameraPosition.distanceTo(sphere.center) - sphere.radius);
    const visible = this.frustum.intersectsSphere(sphere)
      || performance.now() - (this.recentlyVisible.get(key) ?? -Infinity) < 2000;
    const projectedDistance = distance * REFERENCE_PIXEL_SCALE / this.pixelScale;
    let sampleSize = visible ? desiredSampleSize(projectedDistance, this.settings) ?? 64 : 64;
    const previous = this.zoneDemandSizes.get(key);
    if (visible && previous !== undefined && sampleSize !== previous) {
      const margin = sampleSize < previous ? 1.1 : 0.9;
      sampleSize = desiredSampleSize(projectedDistance * margin, this.settings) ?? 64;
    }
    this.zoneDemandSizes.set(key, sampleSize);
    return { sampleSize, priority: distance + (visible ? 0 : 20_000) };
  }

  private requestRebuild() {
    // Coalesce downloads and camera updates. Keep the uploaded batches alive
    // until one complete top/side replacement can be published atomically.
    this.connectionBuildGeneration++;
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.enabled) this.scheduleRebuild();
    }, 16);
  }

  private rangeFor(key: string): SurfaceRange {
    let range = this.ranges.get(key);
    if (!range) {
      range = { topStart: this.writeIndex, topCount: 0, sideStart: 0, sideCount: 0 };
      this.ranges.set(key, range);
    }
    return range;
  }

  private publishBatches() {
    // WebGL has no base-instance offset. Compact copies give each zone a
    // bounded draw and keep staging writes separate from active GPU uploads.
    // The parent geometries remain aggregate diagnostics, not duplicate draws.
    this.mesh.geometry.setDrawRange(0, 0);
    this.sideMesh.geometry.setDrawRange(0, 0);
    for (const [key, batch] of this.batches) {
      this.mesh.remove(batch.top, batch.side);
      batch.top.geometry.dispose();
      batch.side.geometry.dispose();
      this.batches.delete(key);
    }
    for (const [key, range] of this.ranges) {
      const zone = this.zones.get(key);
      if (!zone || (!range.topCount && !range.sideCount)) continue;
      const make = (source: SurfaceMesh, start: number, count: number, side: boolean) => {
        const geometry = side ? createSideGeometry() : createTopGeometry();
        for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
          if (!(attribute instanceof THREE.InstancedBufferAttribute)) continue;
          geometry.setAttribute(name, new THREE.InstancedBufferAttribute(
            attribute.array.slice(start * attribute.itemSize, (start + count) * attribute.itemSize),
            attribute.itemSize, attribute.normalized,
          ));
        }
        geometry.instanceCount = count;
        geometry.boundingSphere = zone.bounds.clone();
        const mesh = new THREE.Mesh(geometry, source.material);
        mesh.name = `DistantSurface:${key}:${side ? 'sides' : 'tops'}`;
        mesh.frustumCulled = false;
        mesh.visible = count > 0 && (!this.hasView || this.frustum.intersectsSphere(zone.bounds));
        return mesh;
      };
      const top = make(this.mesh, range.topStart, range.topCount, false);
      const side = make(this.sideMesh, range.sideStart, range.sideCount, true);
      this.mesh.add(top, side);
      this.batches.set(key, { top, side, bounds: zone.bounds.clone() });
    }
  }

  setEnabled(enabled: boolean): boolean {
    const next = Boolean(enabled);
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    if (!next) {
      this.connectionBuildGeneration++;
      this.connectionBuildPending = false;
      this.connectionsDirty = true;
      if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      this.hasView = false;
      this.lodViewKey = '';
      this.syncVisibility();
      return this.enabled;
    }
    if (this.zones.size > 0) {
      if (getWorldShapeMode() === 'torus') this.requestRebuild();
      else this.rebuild();
    } else {
      this.writeIndex = 0;
      this.sideWriteIndex = 0;
      this.ranges.clear();
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
  setDetailChunkReady(chunkX: number, chunkZ: number, ready: boolean) {
    const wrappedX = ((chunkX % WORLD_CHUNKS_X) + WORLD_CHUNKS_X) % WORLD_CHUNKS_X;
    const wrappedZ = ((chunkZ % WORLD_CHUNKS_Z) + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z;
    const index = wrappedZ * WORLD_CHUNKS_X + wrappedX;
    const value = ready ? 255 : 0;
    if (this.detailMaskData[index] === value) return;
    this.detailMaskData[index] = value;
    this.detailMaskTexture.needsUpdate = true;
  }

  private ensureStorage() {
    if (
      this.offsets && this.heights && this.sizes && this.colors
      && this.sideOffsets && this.sideHeights && this.sideBottomHeights
      && this.sideSizes && this.sideAxes && this.sideNormals && this.sideColors
    ) return;
    this.offsets = new Uint16Array(MAX_SURFACE_INSTANCES * 2);
    this.heights = new Uint16Array(MAX_SURFACE_INSTANCES);
    this.sizes = new Uint8Array(MAX_SURFACE_INSTANCES);
    this.colors = new Uint8Array(MAX_SURFACE_INSTANCES * 3);
    this.sideOffsets = new Uint16Array(MAX_SURFACE_CONNECTIONS * 2);
    this.sideHeights = new Uint16Array(MAX_SURFACE_CONNECTIONS);
    this.sideBottomHeights = new Uint16Array(MAX_SURFACE_CONNECTIONS);
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
    const zoneKey = `${zone.zoneX},${zone.zoneZ}`;
    if (
      this.settings.connectionDistance > 0
      && distance <= this.settings.connectionDistance
    ) {
      this.connectedCells.push({ zoneKey, worldX, worldZ, cellSize, height, red, green, blue });
    }
    if (height === 0) return;
    if (this.writeIndex >= MAX_SURFACE_INSTANCES) {
      throw new Error('Adaptive Space surface instance budget exceeded.');
    }
    const index = this.writeIndex++;
    const range = this.rangeFor(zoneKey);
    if (range.topCount === 0) range.topStart = index;
    range.topCount++;
    this.offsets![index * 2] = worldX;
    this.offsets![index * 2 + 1] = worldZ;
    this.heights![index] = height;
    this.sizes![index] = cellSize;
    this.colors![index * 3] = red;
    this.colors![index * 3 + 1] = green;
    this.colors![index * 3 + 2] = blue;
  }

  private visitCell(zone: StoredSurfaceZone, localX: number, localZ: number, cellSize: number) {
    const worldX = zone.zoneX * ZONE_WORLD_SIZE + localX;
    const worldZ = zone.zoneZ * ZONE_WORLD_SIZE + localZ;
    const playerX = (this.centerChunkX + 0.5) * CHUNK_SIZE;
    const playerZ = (this.centerChunkZ + 0.5) * CHUNK_SIZE;
    const dx = wrappedAxisDistanceToCell(playerX, worldX, cellSize, TORUS_SIZE_X);
    const dz = wrappedAxisDistanceToCell(playerZ, worldZ, cellSize, TORUS_SIZE_Z);
    let distance = Math.hypot(dx, dz);
    let mustSplit = true;
    if (this.hasView) {
      const mip = zone.mips.get(Math.max(cellSize, zone.sampleSize))!;
      const index = Math.floor(localX / mip.cellSize) * mip.axis + Math.floor(localZ / mip.cellSize);
      const height = mip.heights[index];
      const minHeight = mip.minHeights[index];
      computeBentBoundsSphere({ minX: worldX, maxX: worldX + cellSize,
        minZ: worldZ, maxZ: worldZ + cellSize,
        minY: minHeight * MICRO_SIZE, maxY: height * MICRO_SIZE }, this.cellBounds);
      distance = Math.max(1, this.lodPosition.distanceTo(this.cellBounds.center) - this.cellBounds.radius);
      const error = (height - minHeight) * MICRO_SIZE
        + curvatureError(cellSize, height) + cellSize * mip.colorErrors[index] * 0.25;
      mustSplit = error * this.pixelScale / distance > MAX_SCREEN_ERROR_PX;
    }
    if (distance > this.settings.maxDistance) return;
    const sampleSize = desiredSampleSize(this.hasView
      ? Math.min(this.settings.maxDistance, distance * REFERENCE_PIXEL_SCALE / this.pixelScale)
      : distance, this.settings);
    if (sampleSize === null) return;
    // Coarse data may still need extra vertices to follow the tube's curvature.
    // Conversely a flat, uniform patch can stay coarse even near the camera.
    // Reserve a coarse cell for every remaining root even at extreme zoom.
    // Exceeding the budget reduces refinement instead of dropping terrain.
    const canRefine = !this.hasView || this.writeIndex < MAX_SURFACE_INSTANCES - 4 * 8192;
    const tierIndex = LOD_SAMPLE_SIZES.indexOf(cellSize as typeof LOD_SAMPLE_SIZES[number]);
    const tierEnabled = this.settings[LOD_ENABLED_KEYS[tierIndex]];
    if (cellSize > sampleSize && (mustSplit || !tierEnabled) && canRefine
      && (this.hasView || cellSize > zone.sampleSize)) {
      const childSize = cellSize / 2;
      this.visitCell(zone, localX, localZ, childSize);
      this.visitCell(zone, localX + childSize, localZ, childSize);
      this.visitCell(zone, localX, localZ + childSize, childSize);
      this.visitCell(zone, localX + childSize, localZ + childSize, childSize);
      return;
    }
    this.emit(zone, localX, localZ, cellSize, distance);
  }

  private appendZone(zone: StoredSurfaceZone) {
    for (let localX = 0; localX < ZONE_WORLD_SIZE; localX += 64) {
      for (let localZ = 0; localZ < ZONE_WORLD_SIZE; localZ += 64) {
        this.visitCell(zone, localX, localZ, 64);
      }
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
        if (this.hasView && neighbor && cell.cellSize < neighbor.cellSize && cell.height >= neighbor.height) {
          const skirt = Math.ceil((curvatureError(neighbor.cellSize, cell.height) + MICRO_SIZE) / MICRO_SIZE);
          bottom = Math.max(0, Math.min(neighbor.height, cell.height - skirt));
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
  }

  private rebuildConnections() {
    this.ensureStorage();
    this.connectionBuildGeneration++;
    this.connectionBuildPending = false;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const cells = this.connectedCells;
    this.sideWriteIndex = 0;
    for (const range of this.ranges.values()) range.sideCount = 0;
    this.clearConnectionOwners();
    for (const cell of cells) this.fillConnectionOwner(cell);
    for (const cell of cells) this.emitCellConnections(cell);
    this.finishConnectionUpload(previousCount);
  }

  private async stageConnections(
    generation: number,
    cells: ConnectedSurfaceCell[],
  ): Promise<boolean> {
    this.sideWriteIndex = 0;
    for (const range of this.ranges.values()) range.sideCount = 0;
    this.clearConnectionOwners();

    let cellIndex = 0;
    while (cellIndex < cells.length) {
      const startedAt = performance.now();
      do {
        this.fillConnectionOwner(cells[cellIndex]);
        cellIndex++;
      } while (
        cellIndex < cells.length
        && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
      );
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return false;
    }

    cellIndex = 0;
    while (cellIndex < cells.length) {
      const startedAt = performance.now();
      do {
        this.emitCellConnections(cells[cellIndex]);
        cellIndex++;
      } while (
        cellIndex < cells.length
        && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
      );
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return false;
    }
    return true;
  }

  private scheduleConnectionRebuild(): Promise<void> {
    this.ensureStorage();
    const generation = ++this.connectionBuildGeneration;
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
    const previousTopCount = this.mesh.geometry.instanceCount;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const rootCells = [...this.zones.values()].flatMap(zone => {
      const roots: { zone: StoredSurfaceZone; localX: number; localZ: number }[] = [];
      for (let localX = 0; localX < ZONE_WORLD_SIZE; localX += 64) {
        for (let localZ = 0; localZ < ZONE_WORLD_SIZE; localZ += 64) {
          roots.push({ zone, localX, localZ });
        }
      }
      return roots;
    });
    this.connectionsDirty = true;
    this.connectionBuildPending = true;

    this.pendingBuild = (async () => {
      // Retain the currently uploaded topology until the replacement is
      // complete. Typed arrays are only sent to WebGL after every staged batch.
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return;

      this.writeIndex = 0;
      this.ranges.clear();
      this.connectedCells.length = 0;
      let rootIndex = 0;
      while (rootIndex < rootCells.length) {
        const startedAt = performance.now();
        do {
          const root = rootCells[rootIndex];
          this.visitCell(root.zone, root.localX, root.localZ, 64);
          rootIndex++;
        } while (
          rootIndex < rootCells.length
          && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
        );
        await yieldToRender();
        if (generation !== this.connectionBuildGeneration) return;
      }

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
    const sampleSize = zone.sampleSize ?? FINE_SAMPLE_SIZE;
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
    if (replacing || this.connectionBuildPending || this.rebuildTimer !== null) {
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

  async finalizeConnections() {
    this.connectionsReady = true;
    if (!this.enabled) return;
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      this.scheduleRebuild();
    }
    if (this.connectionBuildPending) {
      await this.pendingBuild;
      return;
    }
    if (!this.connectionsDirty) return;
    await this.scheduleConnectionRebuild();
  }

  removeZone(zoneX: number, zoneZ: number) {
    const key = `${zoneX},${zoneZ}`;
    if (!this.zones.delete(key)) return;
    this.loadedZones.delete(key);
    this.connectionsDirty = true;
    if (!this.enabled) return;
    if (this.hasView) {
      const batch = this.batches.get(key);
      if (batch) {
        this.mesh.remove(batch.top, batch.side);
        batch.top.geometry.dispose();
        batch.side.geometry.dispose();
        this.batches.delete(key);
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
    this.settings = next;
    if (this.enabled && this.zones.size > 0) {
      if (this.connectionsReady) this.scheduleRebuild();
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
      if (this.connectionsReady) this.scheduleRebuild();
      else this.rebuild();
    }
  }
}
