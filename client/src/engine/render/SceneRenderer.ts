import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import {
  applyCameraBend, hookSceneMaterials, cullChunks,
  bendPoint, bendDirection, unbendPoint, unbendDirection,
  TORUS_SIZE_X, TORUS_SIZE_Z, unwrapPeriodicNear, wrapX, wrapZ,
  getWorldShapeMode, setWorldProjectionAnchor,
  setWorldShapeMode as setGlobalWorldShapeMode,
  type WorldShapeMode,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { CuteCharacter, loadCuteCharacter, type SkinModel } from './CuteCharacter.ts';
import {
  isProjectedPlayerVisible,
  resolveRemotePlayerLod,
  type RemotePlayerLod,
} from './RemotePlayerLod.ts';
import {
  estimateRemotePlayerMotion,
  remoteMotionFreshness,
  wrappedAxisDelta,
} from './RemotePlayerMotion.ts';
import { AdaptiveResolutionController } from './AdaptiveResolution.ts';
import type { AdaptiveEffectsQuality } from './AdaptiveResolution.ts';
import { CinematicEffects } from './CinematicEffects.ts';
import { CrossPlaneImpostorLod } from './CrossPlaneImpostor.ts';
import { normalizeEntityImpostorSettings, type EntityImpostorSettings } from './EntityImpostorSettings.ts';
import { VoxelImpostorSources } from './VoxelImpostorSources.ts';
import { CINEMATIC_SKY_GLSL } from './CinematicSky.ts';
import {
  DEFAULT_LIGHTING_QUALITY, LIGHTING_PRESETS, normalizeLightingQuality,
  type LightingQuality,
} from './LightingQuality.ts';

export const ENTITY_PREVIEW_LAYER = 1;
export const ENTITY_PREVIEW_FORCE_LIMIT_RATIO = 0.72;
export const ENTITY_PREVIEW_MAX_FPS = 30;
const ENTITY_PREVIEW_FRAME_INTERVAL_MS = 1000 / ENTITY_PREVIEW_MAX_FPS;
const MAX_SELECTION_BEND_SEGMENTS = 64;
/** Invisible pick-sphere radius for a selection axis handle, in metres (pre-scale). */
const SELECTION_GIZMO_PICK_RADIUS = 0.32;
const remotePlayerCullCamera = new THREE.PerspectiveCamera();
const remotePlayerProjectedPosition = new THREE.Vector3();

function createPlayerNameTag(username: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Glassmorphism dark rounded badge
    ctx.fillStyle = 'rgba(12, 18, 28, 0.78)';
    const r = 12;
    ctx.beginPath();
    ctx.roundRect(6, 6, 244, 52, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 210, 211, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Player name text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px "Inter", "Outfit", -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(username.slice(0, 16), 128, 32);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.4, 0.35, 1);
  sprite.position.set(0, 2.05, 0);
  sprite.renderOrder = 50;
  return sprite;
}

function createRemotePlayerFallback() {
  const group = new THREE.Group();
  group.name = 'RemotePlayerFallback';
  const material = new THREE.MeshStandardMaterial({
    color: 0x00d2d3,
    roughness: 0.72,
    metalness: 0.05,
  });
  const addBox = (size: [number, number, number], position: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.castShadow = false;
    group.add(mesh);
  };
  addBox([0.62, 0.78, 0.34], [0, 1.05, 0]);
  addBox([0.52, 0.52, 0.52], [0, 1.72, 0]);
  addBox([0.2, 0.72, 0.2], [-0.42, 1.06, 0]);
  addBox([0.2, 0.72, 0.2], [0.42, 1.06, 0]);
  addBox([0.24, 0.76, 0.24], [-0.18, 0.38, 0]);
  addBox([0.24, 0.76, 0.24], [0.18, 0.38, 0]);
  hookSceneMaterials(group);
  return group;
}

function disposeRemotePlayerFallback(group: THREE.Group | null | undefined) {
  if (!group) return;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object: any) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) if (material) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  group.removeFromParent();
}

interface PlayerAppearance {
  skinUrl: string;
  skinModel: SkinModel;
}

/**
 * The torus shader bends vertices, not the straight line between two vertices.
 * A default BoxGeometry therefore turns a large selection edge into a chord
 * through the curved terrain. Subdivide at roughly one segment per selected
 * cell (with a safety cap) so fills and outlines follow the rendered surface.
 */
function updateTorusSelectionBoxGeometry(fill, edges, sizeX, sizeY, sizeZ) {
  if (!fill || !edges) return;
  const segments = [sizeX, sizeY, sizeZ].map(size => (
    Math.max(1, Math.min(MAX_SELECTION_BEND_SEGMENTS, Math.max(1, Math.round(Math.abs(Number(size)) * 5))))
  ));
  const signature = segments.join(',');
  if (fill.userData.torusSelectionSegments === signature) return;

  const box = new THREE.BoxGeometry(1, 1, 1, segments[0], segments[1], segments[2]);
  const outline = new THREE.EdgesGeometry(box);
  fill.geometry?.dispose?.();
  edges.geometry?.dispose?.();
  fill.geometry = box;
  edges.geometry = outline;
  fill.userData.torusSelectionSegments = signature;
}

function previewVector3(value, fallback = new THREE.Vector3()) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  return fallback.clone();
}

function previewQuaternion(value) {
  if (value?.isQuaternion) return value.clone().normalize();
  if (Array.isArray(value) && value.length >= 4) {
    const components = value.slice(0, 4).map(Number);
    if (components.every(Number.isFinite)) {
      const quaternion = new THREE.Quaternion(
        components[0], components[1], components[2], components[3]
      );
      if (quaternion.lengthSq() > 1e-12) return quaternion.normalize();
    }
    return new THREE.Quaternion();
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      'XYZ'
    ));
  }
  return new THREE.Quaternion();
}

/**
 * Convert either inventory format into voxel instances relative to the exact
 * placement origin. Entity component transforms mirror Contraption's initial
 * hierarchy, so articulated copies preview in the same pose they build in.
 */
export function getInventoryPreviewBlocks(slot) {
  if (!slot || !Array.isArray(slot.blocks)) return [];
  if (slot.kind === 'blockset') {
    return slot.blocks.map(block => ({
      center: new THREE.Vector3(
        Number(block.dx) + (Number(block.size) || 1) / 2,
        Number(block.dy) + (Number(block.size) || 1) / 2,
        Number(block.dz) + (Number(block.size) || 1) / 2
      ),
      size: Number(block.size) || 1,
      color: block.color
    }));
  }

  if (slot.blocks.length === 0) return [];
  const rootComponentId = String(slot.rootComponentId || '');
  if (!rootComponentId) return [];
  const sourceChildIds = new Set((slot.childEntities || []).map(definition => definition.id));
  const blocks = slot.blocks.map(block => ({
    ...block,
    entityId: block.entityId ?? rootComponentId
  }));
  const definitions = (slot.childEntities || []).map(definition => ({
    ...definition,
    parentId: sourceChildIds.has(definition.parentId)
      ? definition.parentId
      : rootComponentId
  })).filter(definition => definition.id !== rootComponentId);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const block of blocks) {
    const x = Number(block.localX);
    const y = Number(block.localY);
    const z = Number(block.localZ);
    const size = Number(block.size) || 1;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x + size); maxY = Math.max(maxY, y + size); maxZ = Math.max(maxZ, z + size);
  }
  const defaultRootPivot = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );
  const rootPivot = previewVector3(slot.rootPivotOverride, defaultRootPivot);
  const rootMatrix = new THREE.Matrix4().makeTranslation(rootPivot.x, rootPivot.y, rootPivot.z);
  const nodes = new Map([[rootComponentId, { pivot: rootPivot, matrix: rootMatrix }]]);
  const pending = [...definitions];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const definition = pending[index];
      const parent = nodes.get(definition.parentId);
      if (!parent) continue;
      const pivot = previewVector3(definition.pivot, rootPivot);
      const defaultPosition = pivot.clone().sub(parent.pivot);
      const localPosition = previewVector3(definition.localPosition, defaultPosition);
      const localMatrix = new THREE.Matrix4().compose(
        localPosition,
        previewQuaternion(definition.localRotation),
        new THREE.Vector3(1, 1, 1)
      );
      nodes.set(definition.id, {
        pivot,
        matrix: new THREE.Matrix4().multiplyMatrices(parent.matrix, localMatrix)
      });
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) break;
  }

  // Match Contraption's safe fallback for invalid/cyclic parents.
  for (const definition of pending) {
    const pivot = previewVector3(definition.pivot, rootPivot);
    const localMatrix = new THREE.Matrix4().makeTranslation(
      pivot.x - rootPivot.x,
      pivot.y - rootPivot.y,
      pivot.z - rootPivot.z
    );
    nodes.set(definition.id, {
      pivot,
      matrix: new THREE.Matrix4().multiplyMatrices(rootMatrix, localMatrix)
    });
  }

  return blocks.flatMap(block => {
    const node = nodes.get(block.entityId ?? rootComponentId);
    if (!node) return [];
    const size = Number(block.size) || 1;
    const center = new THREE.Vector3(
      Number(block.localX) + size / 2,
      Number(block.localY) + size / 2,
      Number(block.localZ) + size / 2
    ).sub(node.pivot).applyMatrix4(node.matrix);
    return [{ center, size, color: block.color }];
  });
}

/**
 * Builds a single unified boundary mesh and wireframe for voxel placement preview,
 * culling all internal adjoining faces between voxels so the ghost renders as a clean solid
 * without multi-box transparent overdraw or internal line clutter.
 */
export function buildUnifiedInventoryPreviewMesh(entries) {
  if (!entries || entries.length === 0) return null;

  let minSize = Infinity;
  let allSize1 = true;
  for (const entry of entries) {
    const s = Number(entry.size) || 1;
    minSize = Math.min(minSize, s);
    if (Math.abs(s - 1) > 1e-4) allSize1 = false;
  }

  // Quantization step in milli-units (1.0 block -> 1000, 0.125 microblock -> 125)
  const step = allSize1 ? 1000 : (minSize < 0.9 ? MICRO_SIZE * 1000 : 1000);
  const toCoord = (val) => Math.round(val * 1000);

  // Map of patchKey -> { pos?: Patch, neg?: Patch }
  // Back-to-back opposing faces cancel each other out (internal face culling).
  const patchMap = new Map();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const size = Number(entry.size) || 1;
    const color = entry.color ?? 0xf2a93b;
    const cx = entry.center.x;
    const cy = entry.center.y;
    const cz = entry.center.z;

    const qx0 = toCoord(cx - size / 2);
    const qy0 = toCoord(cy - size / 2);
    const qz0 = toCoord(cz - size / 2);
    const qx1 = toCoord(cx + size / 2);
    const qy1 = toCoord(cy + size / 2);
    const qz1 = toCoord(cz + size / 2);

    // 1. +X Face (Plane X = qx1, Normal +X, Dir +1)
    for (let u = qy0; u < qy1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qy1);
        const v1 = Math.min(v + step, qz1);
        const key = `X:${qx1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [qx1 / 1000, u / 1000, v1 / 1000],
              v1: [qx1 / 1000, u / 1000, v / 1000],
              v2: [qx1 / 1000, u1 / 1000, v / 1000],
              v3: [qx1 / 1000, u1 / 1000, v1 / 1000],
              normal: [1, 0, 0],
              color
            }
          });
        }
      }
    }

    // 2. -X Face (Plane X = qx0, Normal -X, Dir -1)
    for (let u = qy0; u < qy1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qy1);
        const v1 = Math.min(v + step, qz1);
        const key = `X:${qx0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [qx0 / 1000, u / 1000, v / 1000],
              v1: [qx0 / 1000, u / 1000, v1 / 1000],
              v2: [qx0 / 1000, u1 / 1000, v1 / 1000],
              v3: [qx0 / 1000, u1 / 1000, v / 1000],
              normal: [-1, 0, 0],
              color
            }
          });
        }
      }
    }

    // 3. +Y Face (Plane Y = qy1, Normal +Y, Dir +1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qz1);
        const key = `Y:${qy1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [u / 1000, qy1 / 1000, v1 / 1000],
              v1: [u1 / 1000, qy1 / 1000, v1 / 1000],
              v2: [u1 / 1000, qy1 / 1000, v / 1000],
              v3: [u / 1000, qy1 / 1000, v / 1000],
              normal: [0, 1, 0],
              color
            }
          });
        }
      }
    }

    // 4. -Y Face (Plane Y = qy0, Normal -Y, Dir -1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qz1);
        const key = `Y:${qy0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [u / 1000, qy0 / 1000, v / 1000],
              v1: [u1 / 1000, qy0 / 1000, v / 1000],
              v2: [u1 / 1000, qy0 / 1000, v1 / 1000],
              v3: [u / 1000, qy0 / 1000, v1 / 1000],
              normal: [0, -1, 0],
              color
            }
          });
        }
      }
    }

    // 5. +Z Face (Plane Z = qz1, Normal +Z, Dir +1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qy0; v < qy1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qy1);
        const key = `Z:${qz1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [u / 1000, v / 1000, qz1 / 1000],
              v1: [u1 / 1000, v / 1000, qz1 / 1000],
              v2: [u1 / 1000, v1 / 1000, qz1 / 1000],
              v3: [u / 1000, v1 / 1000, qz1 / 1000],
              normal: [0, 0, 1],
              color
            }
          });
        }
      }
    }

    // 6. -Z Face (Plane Z = qz0, Normal -Z, Dir -1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qy0; v < qy1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qy1);
        const key = `Z:${qz0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [u1 / 1000, v / 1000, qz0 / 1000],
              v1: [u / 1000, v / 1000, qz0 / 1000],
              v2: [u / 1000, v1 / 1000, qz0 / 1000],
              v3: [u1 / 1000, v1 / 1000, qz0 / 1000],
              normal: [0, 0, -1],
              color
            }
          });
        }
      }
    }
  }

  const patchCount = patchMap.size;
  if (patchCount === 0) return null;

  const fillPositions = new Float32Array(patchCount * 18);
  const fillNormals = new Float32Array(patchCount * 18);
  const fillColors = new Float32Array(patchCount * 18);

  const edgePositions: number[] = [];
  const edgeSet = new Set<string>();
  const tempColor = new THREE.Color();

  let vertOffset = 0;
  for (const item of patchMap.values()) {
    const patch = item.pos || item.neg;
    if (!patch) continue;

    tempColor.set(patch.color ?? 0xf2a93b);
    const r = tempColor.r;
    const g = tempColor.g;
    const b = tempColor.b;
    const [nx, ny, nz] = patch.normal;
    const { v0, v1, v2, v3 } = patch;

    // Triangle 1: v0, v1, v2
    fillPositions[vertOffset] = v0[0];
    fillPositions[vertOffset + 1] = v0[1];
    fillPositions[vertOffset + 2] = v0[2];
    fillPositions[vertOffset + 3] = v1[0];
    fillPositions[vertOffset + 4] = v1[1];
    fillPositions[vertOffset + 5] = v1[2];
    fillPositions[vertOffset + 6] = v2[0];
    fillPositions[vertOffset + 7] = v2[1];
    fillPositions[vertOffset + 8] = v2[2];

    // Triangle 2: v0, v2, v3
    fillPositions[vertOffset + 9] = v0[0];
    fillPositions[vertOffset + 10] = v0[1];
    fillPositions[vertOffset + 11] = v0[2];
    fillPositions[vertOffset + 12] = v2[0];
    fillPositions[vertOffset + 13] = v2[1];
    fillPositions[vertOffset + 14] = v2[2];
    fillPositions[vertOffset + 15] = v3[0];
    fillPositions[vertOffset + 16] = v3[1];
    fillPositions[vertOffset + 17] = v3[2];

    for (let k = 0; k < 6; k++) {
      const idx = vertOffset + k * 3;
      fillNormals[idx] = nx;
      fillNormals[idx + 1] = ny;
      fillNormals[idx + 2] = nz;
      fillColors[idx] = r;
      fillColors[idx + 1] = g;
      fillColors[idx + 2] = b;
    }
    vertOffset += 18;

    // Outer quad boundary edges
    const edges = [
      [v0, v1],
      [v1, v2],
      [v2, v3],
      [v3, v0]
    ];
    for (const [p1, p2] of edges) {
      const k1 = `${Math.round(p1[0] * 1000)},${Math.round(p1[1] * 1000)},${Math.round(p1[2] * 1000)}`;
      const k2 = `${Math.round(p2[0] * 1000)},${Math.round(p2[1] * 1000)},${Math.round(p2[2] * 1000)}`;
      const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edgePositions.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      }
    }
  }

  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', new THREE.BufferAttribute(fillPositions, 3));
  fillGeometry.setAttribute('normal', new THREE.BufferAttribute(fillNormals, 3));
  fillGeometry.setAttribute('color', new THREE.BufferAttribute(fillColors, 3));

  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

  return { fillGeometry, wireGeometry, patchCount };
}

export function calculatePreviewDragForce(
  cameraQuaternion,
  deltaX,
  deltaY,
  maxForce,
  flatReferencePoint = null
) {
  const dx = Number(deltaX) || 0;
  const dy = Number(deltaY) || 0;
  const dragLength = Math.hypot(dx, dy);
  const safeMaxForce = Math.max(0, Number(maxForce) || 0);
  const forceLimit = safeMaxForce * ENTITY_PREVIEW_FORCE_LIMIT_RATIO;
  if (dragLength < 0.5 || forceLimit <= 0) return new THREE.Vector3();

  const orientation = cameraQuaternion?.isQuaternion
    ? cameraQuaternion
    : new THREE.Quaternion();
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  // The preview camera lives in the torus-bent render space, while physics
  // forces live in the flat simulation space. Convert both screen axes back at
  // the grabbed point before composing the force; otherwise the displayed
  // arrow rotates with the entity's position around the torus.
  if (flatReferencePoint?.isVector3) {
    unbendDirection(
      flatReferencePoint.x,
      flatReferencePoint.y,
      flatReferencePoint.z,
      cameraRight,
      cameraRight
    ).normalize();
    unbendDirection(
      flatReferencePoint.x,
      flatReferencePoint.y,
      flatReferencePoint.z,
      cameraUp,
      cameraUp
    ).normalize();
  }
  const direction = cameraRight.multiplyScalar(dx)
    .addScaledVector(cameraUp, -dy)
    .normalize();
  const magnitude = Math.min(forceLimit, (dragLength / 140) * forceLimit);
  return direction.multiplyScalar(magnitude);
}

export function calculateEntityPreviewCameraPose(contraption, aspect = 1, fov = 42) {
  const safeAspect = Math.max(0.2, Number(aspect) || 1);
  const radius = Math.max(0.75, contraption.boundingRadius || 0.75);
  const verticalHalfFov = THREE.MathUtils.degToRad(fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
  const limitingHalfFov = Math.max(0.1, Math.min(verticalHalfFov, horizontalHalfFov));
  const distance = (radius / Math.sin(limitingHalfFov)) * 1.16;
  const center = contraption.position.clone();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const localRear = new THREE.Vector3(0, 0, 1).applyQuaternion(contraption.quaternion).normalize();
  const position = center.clone()
    .addScaledVector(localRear, distance)
    .addScaledVector(worldUp, radius * 0.28);

  return { center, position, up: worldUp, distance, radius };
}

export class SceneRenderer {
  declare container: any;
  declare scene: THREE.Scene;
  declare skyColorDay: THREE.Color;
  declare camera: THREE.PerspectiveCamera;
  declare renderer: THREE.WebGLRenderer;
  declare adaptiveResolution: AdaptiveResolutionController;
  declare adaptiveEffectsQuality: AdaptiveEffectsQuality;
  declare shadowsEnabled: boolean;
  declare lightingQuality: LightingQuality;
  declare cinematicEffects: CinematicEffects | null;
  declare resolutionScale: number;
  declare onResolutionScaleChange: ((state: any) => void) | null;
  declare previewRenderer: any;
  declare previewCamera: any;
  declare previewCanvas: any;
  declare previewTarget: any;
  declare previewRaycaster: any;
  declare previewPointer: any;
  declare previewOrbit: any;
  declare previewInteraction: any;
  declare previewForceArrow: any;
  declare previewArrowHoldUntil: number;
  declare previewLastRenderedAt: number;
  declare onPreviewPointerDown: any;
  declare onPreviewPointerMove: any;
  declare onPreviewPointerUp: any;
  declare onPreviewContextMenu: any;
  declare onEntityPreviewNodeSelect: any;
  declare hemiLight: THREE.HemisphereLight;
  declare sunLight: THREE.DirectionalLight;
  declare fillLight: THREE.DirectionalLight;
  declare cursorMesh: THREE.LineSegments;
  declare microCarveGroup: THREE.Group;
  declare microCarveFocusCell: THREE.LineSegments;
  declare focusBlockGuide: THREE.LineSegments;
  declare boxSelectionGroup: THREE.Group;
  declare boxSelectionFill: THREE.Mesh;
  declare boxSelectionEdges: THREE.LineSegments;
  declare wrenchTetherLine: THREE.Line;
  declare wrenchPivotGizmo: THREE.Group;
  declare wrenchPivotArrows: Map<string, THREE.ArrowHelper>;
  declare wrenchPivotOrigin: THREE.Mesh;
  declare selectionAxisGizmo: THREE.Group;
  declare selectionGizmoHandles: Map<string, THREE.Group>;
  declare selectionGizmoMaterials: Map<string, THREE.MeshBasicMaterial>;
  declare selectionGizmoLineX: THREE.Line;
  declare selectionGizmoLineY: THREE.Line;
  declare selectionGizmoLineZ: THREE.Line;
  declare selectionGizmoOrigin: THREE.Mesh;
  declare playerAvatar: THREE.Group;
  declare playerAvatarCharacter: CuteCharacter | null;
  declare playerFirstPersonHand: THREE.Group | null;
  declare remotePlayersGroup: THREE.Group;
  declare remotePlayers: Map<string, any>;
  declare inventoryPlacementGroup: THREE.Group;
  declare inventoryPlacementFill: THREE.Mesh | null;
  declare inventoryPlacementWire: THREE.LineSegments | null;
  declare inventoryPlacementSlot: any;
  declare selectionGroup: THREE.Group;
  declare selectionWireframe: any;
  declare selectionFill: any;
  declare selectionCellsGroup: THREE.Group;
  declare selectionCellBoxGeometry: THREE.BoxGeometry;
  declare selectionCellEdgeGeometry: THREE.EdgesGeometry;
  declare selectionCellLineMaterial: THREE.LineBasicMaterial;
  declare selectionCellFillMaterial: THREE.MeshBasicMaterial;
  declare selectionCellsSignature: string;
  declare selectionMicroCellsGroup: THREE.Group;
  declare selectionMicroCellBoxGeometry: THREE.BoxGeometry;
  declare selectionMicroCellEdgeGeometry: THREE.EdgesGeometry;
  declare selectionMicroCellLineMaterial: THREE.LineBasicMaterial;
  declare selectionMicroCellFillMaterial: THREE.MeshBasicMaterial;
  declare selectionMicroCellsSignature: string;
  declare timeOfDay: number;
  declare world: any;
  private contraptionManager: any = null;
  private impostorLod: CrossPlaneImpostorLod | null = null;
  private impostorSources: VoxelImpostorSources | null = null;
  private entityImpostorSettings = normalizeEntityImpostorSettings();
  private retainRemoteEntityImpostor?: (publicId: string) => boolean;
  declare flatCameraPosition: THREE.Vector3;
  declare flatCameraQuaternion: THREE.Quaternion;
  declare bentLightTarget: THREE.Vector3;
  declare bentLightDirection: THREE.Vector3;
  declare bentSurfaceUp: THREE.Vector3;
  declare bentFillDirection: THREE.Vector3;
  declare materialScanCountdown: number;
  declare skyDome: THREE.Mesh;
  declare skyDomeUniforms: Record<string, { value: any }>;
  declare playerAppearance: PlayerAppearance;

  constructor(canvasContainer, playerAppearance: PlayerAppearance) {
    this.container = canvasContainer;
    this.playerAppearance = playerAppearance;
    this.world = null;
    // Reused every frame so render-time torus transforms do not allocate or leak
    // back into the flat simulation camera.
    this.flatCameraPosition = new THREE.Vector3();
    this.flatCameraQuaternion = new THREE.Quaternion();
    this.bentLightTarget = new THREE.Vector3();
    this.bentLightDirection = new THREE.Vector3();
    this.bentSurfaceUp = new THREE.Vector3();
    this.bentFillDirection = new THREE.Vector3();
    this.materialScanCountdown = 0;
    this.adaptiveResolution = new AdaptiveResolutionController();
    this.adaptiveEffectsQuality = 'full';
    this.shadowsEnabled = true;
    this.lightingQuality = DEFAULT_LIGHTING_QUALITY;
    this.cinematicEffects = null;
    this.resolutionScale = this.adaptiveResolution.currentScale;
    this.onResolutionScaleChange = null;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.skyColorDay = new THREE.Color('#74b9ff');
    this.scene.background = this.skyColorDay.clone();
    // Preserve opposite-ring visibility after doubling both map circumferences.
    // The opposite inner wall is now about 4,563 m away, so fog density scales
    // down so distant real chunks remain visible across the curved world.
    this.scene.fog = new THREE.FogExp2('#74b9ff', 0.00012);

    // 2. Camera
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 10000);
    this.camera.rotation.order = 'YXZ';
    // Camera-local viewmodels (such as the first-person hand) need to be part
    // of the scene graph so they inherit the final bent render camera pose.
    this.scene.add(this.camera);

    // 3. Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.cappedDevicePixelRatio() * this.resolutionScale);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.container.appendChild(this.renderer.domElement);

    // Programming-terminal entity preview (created lazily when UI connects).
    this.previewRenderer = null;
    this.previewCamera = null;
    this.previewCanvas = null;
    this.previewTarget = null;
    this.previewRaycaster = new THREE.Raycaster();
    this.previewPointer = new THREE.Vector2();
    this.previewOrbit = this.createDefaultPreviewOrbit();
    this.previewInteraction = null;
    this.previewForceArrow = null;
    this.previewArrowHoldUntil = 0;
    this.previewLastRenderedAt = 0;
    this.onPreviewPointerDown = event => this.handleEntityPreviewPointerDown(event);
    this.onPreviewPointerMove = event => this.handleEntityPreviewPointerMove(event);
    this.onPreviewPointerUp = event => this.handleEntityPreviewPointerUp(event);
    this.onPreviewContextMenu = event => event.preventDefault();

    // 4. Lighting & Environment
    this.setupLighting();
    this.setupSkyDome();
    this.applyLightingQuality();
    this.setupCursorHighlight();
    this.setupMicroCarvePreview();
    this.setupFocusBlockGuide();
    this.setupBoxSelectionPreview();
    this.setupWrenchPivotGizmo();
    this.setupInventoryPlacementPreview();
    this.setupSelectionHologram();
    this.setupSelectionAxisGizmo();
    this.setupPlayerAvatar();
    this.setupRemotePlayers();

    // 5. Lighting state — fixed daytime, no day/night cycle.
    this.timeOfDay = 10.0; // 10:00 AM, permanently

    // Resize handling
    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  setupLighting() {
    // Ambient / Hemisphere Light
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x556644, 0.7);
    this.hemiLight.layers.enable(ENTITY_PREVIEW_LAYER);
    this.scene.add(this.hemiLight);

    // Sun Light
    this.sunLight = new THREE.DirectionalLight(0xfffaed, 1.4);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.layers.enable(ENTITY_PREVIEW_LAYER);
    this.scene.add(this.sunLight);

    // A shadow-free cool bounce light lifts faces turned away from the sun.
    // It is omitted from rendering at Low/Medium and during adaptive fallback.
    this.fillLight = new THREE.DirectionalLight(0xc7dfff, 0);
    this.fillLight.visible = false;
    this.fillLight.layers.enable(ENTITY_PREVIEW_LAYER);
    this.scene.add(this.fillLight);
  }

  /**
   * Gradient sky dome.
   *
   * A flat scene.background reads as a featureless void in a torus world:
   * looking up through the central hole shows the opposite ring, but the sky
   * between has no depth cue. A dome centered on the camera adds a subtle
   * radial gradient (deeper toward the hole's center, lifting toward the
   * limb/sun side) so the donut reads as a planet in space instead of a
   * floating texture strip. Base color matches the fog color exactly so the
   * far terrain fades seamlessly into it.
   */
  setupSkyDome() {
    // Radius must exceed the far ring (~4563 m) but stay inside the camera far
    // plane (10000 m). 7000 m gives comfortable headroom for the torus.
    const RADIUS = 7000;
    const geometry = new THREE.SphereGeometry(RADIUS, 32, 16);

    this.skyDomeUniforms = {
      uSkyColor: { value: new THREE.Color('#74b9ff') },
      uHoleColor: { value: new THREE.Color('#3f7fc4') },
      uLimbColor: { value: new THREE.Color('#bfe3ff') },
      uHoleDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGradientStrength: { value: 0.55 },
      uSunGlow: { value: 0 },
      uCinematic: { value: 0 },
      uSurfaceUp: { value: new THREE.Vector3(0, 1, 0) },
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uNorth: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.skyDomeUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: `
        uniform vec3 uSkyColor;
        uniform vec3 uHoleColor;
        uniform vec3 uLimbColor;
        uniform vec3 uHoleDir;
        uniform vec3 uSunDir;
        uniform float uGradientStrength;
        uniform float uSunGlow;
        uniform float uCinematic;
        uniform vec3 uSurfaceUp;
        uniform vec3 uEast;
        uniform vec3 uNorth;
        uniform float uTime;
        varying vec3 vDir;
        ${CINEMATIC_SKY_GLSL}
        void main() {
          vec3 dir = normalize(vDir);
          // Toward the central hole: deeper space blue.
          float holeAmt = smoothstep( 0.15, 0.95, dot( dir, uHoleDir ) );
          // Opposite the hole / toward the sun-side limb: bright lift.
          float limbAmt = smoothstep( 0.25, 0.9, dot( dir, uSunDir ) );
          vec3 col = uSkyColor;
          col = mix( col, uHoleColor, holeAmt * uGradientStrength );
          col = mix( col, uLimbColor, limbAmt * uGradientStrength * 0.5 );
          // Sky-only sun haze is naturally occluded by world geometry.
          float sunAlignment = max( 0.0, dot( dir, uSunDir ) );
          float sunHalo = pow( sunAlignment, 32.0 ) + pow( sunAlignment, 256.0 );
          col += vec3( 1.0, 0.78, 0.48 ) * sunHalo * uSunGlow;
          if (uCinematic > 0.5) col = cinematicSky(dir, uSurfaceUp, uEast, uNorth, uSunDir, uTime);
          gl_FragColor = vec4( col, 1.0 );
          // Run the same ACES + sRGB pipeline as the lit terrain so the dome's
          // base color matches fully-fogged terrain exactly (no horizon seam).
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.skyDome = new THREE.Mesh(geometry, material);
    this.skyDome.name = 'SkyDome';
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -1;
    // Keep the GPU torus-bend hook off this dome: it is a camera-centered
    // background sphere, not world geometry.
    this.skyDome.userData.torusPreBent = true;
    this.scene.add(this.skyDome);

    // Fallback clear color in case the dome is ever culled/failed.
    this.renderer.setClearColor(new THREE.Color('#74b9ff'), 1);
    this.scene.background = null;
  }

  /** Point the dome's gradient at the torus hole and the sun each frame. */
  updateSkyDome(cameraBentPosition: THREE.Vector3) {
    if (!this.skyDome) return;
    this.skyDome.position.copy(cameraBentPosition);

    // Hole direction: from the camera toward the torus center (origin of the
    // major circle). This is the void you look up into.
    const hole = this.skyDomeUniforms.uHoleDir.value;
    const len = cameraBentPosition.length();
    if (len > 1e-6) {
      hole.set(-cameraBentPosition.x / len, -cameraBentPosition.y / len, -cameraBentPosition.z / len);
    } else {
      hole.set(1, 0, 0);
    }

    // Sun direction: reuse the bent light direction (points from target toward
    // the sun). The dome's limb brightens on the sun side.
    const sun = this.skyDomeUniforms.uSunDir.value;
    sun.copy(this.bentLightDirection).normalize();
  }

  setupCursorHighlight() {
    const geo = new THREE.BoxGeometry(1, 1, 1, 5, 5, 5);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
      color: 0x222222,
      linewidth: 2,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false
    });

    this.cursorMesh = new THREE.LineSegments(edges, mat);
    this.cursorMesh.name = 'CursorHighlight';
    this.cursorMesh.renderOrder = 40;
    this.cursorMesh.visible = false;
    this.scene.add(this.cursorMesh);
  }

  /**
   * Micro-carve focus preview: draws the 8x8x8 micro-voxel grid wireframe
   * inside the hit standard cell, and highlights the current 0.125³ micro cell
   * when a micro block is hit.
   */
  setupMicroCarvePreview() {
    this.microCarveGroup = new THREE.Group();
    this.microCarveGroup.name = 'MicroCarvePreview';

    // 8×8 grid lines on the outer surface of each 1×1×1 standard cell
    // (inner 3×3×3 lines hidden for a clean look)
    const positions = [];
    const N = MICRO_DIVISIONS;
    const step = 1 / N;
    for (const face of [0, 1]) {
      for (let j = 0; j <= N; j++) {
        const w = j * step;
        // x = the two faces: grid lines along Y and along Z
        positions.push(face, 0, w, face, 1, w);
        positions.push(face, w, 0, face, w, 1);
        // y = the two faces: grid lines along X and along Z
        positions.push(0, face, w, 1, face, w);
        positions.push(w, face, 0, w, face, 1);
        // z = the two faces: grid lines along X and along Y
        positions.push(0, w, face, 1, w, face);
        positions.push(w, 0, face, w, 1, face);
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.3,
      depthWrite: false
    });
    const gridLines = new THREE.LineSegments(gridGeo, gridMat);
    this.microCarveGroup.add(gridLines);

    // Highlight box for the focused micro cell (0.125³) with segments for curvature bending
    const cellGeo = new THREE.BoxGeometry(MICRO_SIZE, MICRO_SIZE, MICRO_SIZE, 2, 2, 2);
    const cellEdges = new THREE.EdgesGeometry(cellGeo);
    const cellMat = new THREE.LineBasicMaterial({
      color: 0xff9f43,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });
    this.microCarveFocusCell = new THREE.LineSegments(cellEdges, cellMat);
    this.microCarveFocusCell.visible = false;
    this.scene.add(this.microCarveFocusCell);

    this.microCarveGroup.visible = false;
    this.scene.add(this.microCarveGroup);
  }

  /**
   * Update the micro-carve focus preview.
   * @param {null | { cellOrigin: THREE.Vector3, microCenter: THREE.Vector3|null, quaternion?: THREE.Quaternion }} preview
   *   cellOrigin: world coordinates of the standard cell corner (8×8×8 grid drawn inside);
   *   microCenter: world coordinates of the focused micro cell center (when a micro
   *   block is hit), otherwise null;
   *   quaternion: optional orientation of the parent entity component.
   */
  setMicroCarvePreview(preview) {
    if (!this.microCarveGroup) return;
    if (!preview || !preview.cellOrigin) {
      this.microCarveGroup.visible = false;
      if (this.microCarveFocusCell) this.microCarveFocusCell.visible = false;
      return;
    }
    this.microCarveGroup.position.copy(preview.cellOrigin);
    if (preview.quaternion) {
      this.microCarveGroup.quaternion.copy(preview.quaternion);
    } else {
      this.microCarveGroup.quaternion.set(0, 0, 0, 1);
    }
    if (preview.microCenter && this.microCarveFocusCell) {
      this.microCarveFocusCell.position.copy(preview.microCenter);
      if (preview.quaternion) {
        this.microCarveFocusCell.quaternion.copy(preview.quaternion);
      } else {
        this.microCarveFocusCell.quaternion.set(0, 0, 0, 1);
      }
      this.microCarveFocusCell.visible = true;
    } else if (this.microCarveFocusCell) {
      this.microCarveFocusCell.visible = false;
    }
    this.microCarveGroup.visible = true;
  }

  setupInventoryPlacementPreview() {
    this.inventoryPlacementGroup = new THREE.Group();
    this.inventoryPlacementGroup.name = 'InventoryPlacementPreview';
    this.inventoryPlacementGroup.visible = false;
    this.inventoryPlacementFill = null;
    this.inventoryPlacementWire = null;
    this.inventoryPlacementSlot = null;
    this.scene.add(this.inventoryPlacementGroup);
  }

  rebuildInventoryPlacementPreview(slot) {
    this.inventoryPlacementGroup.clear();
    if (this.inventoryPlacementFill) {
      this.inventoryPlacementFill.geometry.dispose();
      const materials = Array.isArray(this.inventoryPlacementFill.material)
        ? this.inventoryPlacementFill.material
        : [this.inventoryPlacementFill.material];
      materials.forEach(material => material.dispose());
    }
    if (this.inventoryPlacementWire) {
      this.inventoryPlacementWire.geometry.dispose();
      const materials = Array.isArray(this.inventoryPlacementWire.material)
        ? this.inventoryPlacementWire.material
        : [this.inventoryPlacementWire.material];
      materials.forEach(material => material.dispose());
    }
    this.inventoryPlacementFill = null;
    this.inventoryPlacementWire = null;

    const entries = getInventoryPreviewBlocks(slot);
    if (entries.length === 0) return false;

    const meshData = buildUnifiedInventoryPreviewMesh(entries);
    if (!meshData) return false;

    // The unified ghost mesh renders only external visible faces and boundary edges,
    // avoiding internal multi-box overlapping transparency artifacts and improving performance.
    const fillMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.38,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide
    });
    const fill = new THREE.Mesh(meshData.fillGeometry, fillMaterial);

    const wireMaterial = new THREE.LineBasicMaterial({
      color: 0x74d9ff,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false
    });
    const wire = new THREE.LineSegments(meshData.wireGeometry, wireMaterial);

    fill.renderOrder = 38;
    wire.renderOrder = 39;
    fill.frustumCulled = false;
    wire.frustumCulled = false;
    this.inventoryPlacementGroup.add(fill, wire);
    this.inventoryPlacementFill = fill;
    this.inventoryPlacementWire = wire;
    // Slot changes can occur just after the periodic scene scan; hook the new
    // materials immediately so the ghost follows the torus on its first frame.
    hookSceneMaterials(this.inventoryPlacementGroup);
    return true;
  }

  setInventoryPlacementPreview(preview) {
    if (!this.inventoryPlacementGroup) return;
    if (!preview?.slot || !preview.position) {
      this.inventoryPlacementGroup.visible = false;
      return;
    }
    if (preview.slot !== this.inventoryPlacementSlot) {
      this.inventoryPlacementSlot = preview.slot;
      if (!this.rebuildInventoryPlacementPreview(preview.slot)) {
        this.inventoryPlacementGroup.visible = false;
        return;
      }
    }
    this.inventoryPlacementGroup.position.copy(preview.position);
    if (preview.quaternion?.isQuaternion) {
      this.inventoryPlacementGroup.quaternion.copy(preview.quaternion);
    } else {
      this.inventoryPlacementGroup.quaternion.identity();
    }
    this.inventoryPlacementGroup.visible = true;
  }

  setupSelectionHologram() {
    // 3D holographic box for confirmed Selector regions.
    this.selectionGroup = new THREE.Group();
    this.selectionGroup.name = 'SelectionHologram';

    // Outer Wireframe
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00d2d3,
      linewidth: 2,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false
    });
    this.selectionWireframe = new THREE.LineSegments(edgesGeo, lineMat);
    this.selectionWireframe.renderOrder = 42;
    this.selectionGroup.add(this.selectionWireframe);

    // Inner Translucent Shimmer Plane Box
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.15,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.selectionFill = new THREE.Mesh(boxGeo, fillMat);
    this.selectionFill.renderOrder = 41;
    this.selectionGroup.add(this.selectionFill);

    this.selectionGroup.visible = false;
    this.scene.add(this.selectionGroup);

    // Exact-cell mode uses independent breathing cells rather than a single
    // bounding box, so sparse Shift selections remain visually unambiguous.
    this.selectionCellsGroup = new THREE.Group();
    this.selectionCellsGroup.name = 'SingleCellSelectionHologram';
    this.selectionCellBoxGeometry = new THREE.BoxGeometry(1, 1, 1, 5, 5, 5);
    this.selectionCellEdgeGeometry = new THREE.EdgesGeometry(this.selectionCellBoxGeometry);
    this.selectionCellLineMaterial = new THREE.LineBasicMaterial({
      color: 0xff9f43,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    });
    this.selectionCellFillMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9f43,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.selectionCellsSignature = '';
    this.selectionCellsGroup.visible = false;
    this.scene.add(this.selectionCellsGroup);

    // Micro-mode sparse selection: each selected 0.125 m cell gets its own
    // breathing hologram so Tab-toggled micro picks read distinctly from the
    // standard orange single-cell mode.
    this.selectionMicroCellsGroup = new THREE.Group();
    this.selectionMicroCellsGroup.name = 'MicroCellSelectionHologram';
    this.selectionMicroCellBoxGeometry = new THREE.BoxGeometry(MICRO_SIZE, MICRO_SIZE, MICRO_SIZE, 2, 2, 2);
    this.selectionMicroCellEdgeGeometry = new THREE.EdgesGeometry(this.selectionMicroCellBoxGeometry);
    this.selectionMicroCellLineMaterial = new THREE.LineBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    });
    this.selectionMicroCellFillMaterial = new THREE.MeshBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.selectionMicroCellsSignature = '';
    this.selectionMicroCellsGroup.visible = false;
    this.scene.add(this.selectionMicroCellsGroup);
  }

  setCursor(hitPos, size = 1, quaternion = null, center = null) {
    if (center || hitPos) {
      if (center) {
        this.cursorMesh.position.set(center.x, center.y, center.z);
      } else {
        this.cursorMesh.position.set(hitPos.x + size / 2, hitPos.y + size / 2, hitPos.z + size / 2);
      }
      if (quaternion?.isQuaternion) {
        this.cursorMesh.quaternion.copy(quaternion);
      } else {
        this.cursorMesh.quaternion.set(0, 0, 0, 1);
      }
      this.cursorMesh.scale.setScalar(size);
      this.cursorMesh.visible = true;
    } else {
      this.cursorMesh.visible = false;
    }
  }

  setEntityPreviewCanvas(canvas) {
    if (!canvas || this.previewCanvas === canvas) return;

    if (this.previewCanvas) {
      this.previewCanvas.removeEventListener('pointerdown', this.onPreviewPointerDown);
      this.previewCanvas.removeEventListener('pointermove', this.onPreviewPointerMove);
      this.previewCanvas.removeEventListener('pointerup', this.onPreviewPointerUp);
      this.previewCanvas.removeEventListener('pointercancel', this.onPreviewPointerUp);
      this.previewCanvas.removeEventListener('contextmenu', this.onPreviewContextMenu);
    }
    if (this.previewRenderer) this.previewRenderer.dispose();
    this.previewCanvas = canvas;
    this.previewCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
    // The target entity is added to this layer while retaining layer 0 for the
    // main camera. Rendering layer 0 here used to draw the entire world a
    // second time for every tiny editor preview frame.
    this.previewCamera.layers.set(ENTITY_PREVIEW_LAYER);

    this.previewRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
    this.previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.previewRenderer.toneMappingExposure = this.renderer.toneMappingExposure;
    // The main renderer already pays for the world shadow map. A second
    // shadow pass caused large GPU spikes and adds little at 340x240.
    this.previewRenderer.shadowMap.enabled = false;
    this.previewLastRenderedAt = 0;

    this.previewForceArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      0xffb142,
      0.32,
      0.18
    );
    this.previewForceArrow.name = 'EntityPreviewAppliedForce';
    this.previewForceArrow.traverse(object => object.layers.set(ENTITY_PREVIEW_LAYER));
    this.previewForceArrow.visible = false;
    this.scene.add(this.previewForceArrow);

    canvas.addEventListener('pointerdown', this.onPreviewPointerDown);
    canvas.addEventListener('pointermove', this.onPreviewPointerMove);
    canvas.addEventListener('pointerup', this.onPreviewPointerUp);
    canvas.addEventListener('pointercancel', this.onPreviewPointerUp);
    canvas.addEventListener('contextmenu', this.onPreviewContextMenu);
  }

  setEntityPreviewTarget(contraption) {
    if (this.previewTarget === contraption) return;

    this.previewTarget?.rootGroup?.traverse?.(object => {
      object.layers.disable(ENTITY_PREVIEW_LAYER);
    });

    this.previewTarget = contraption || null;
    this.previewTarget?.rootGroup?.traverse?.(object => {
      object.layers.enable(ENTITY_PREVIEW_LAYER);
    });
    this.previewOrbit = this.createDefaultPreviewOrbit();
    this.previewInteraction = null;
    this.previewArrowHoldUntil = 0;
    this.previewLastRenderedAt = 0;
    if (this.previewForceArrow) this.previewForceArrow.visible = false;
    this.previewCanvas?.classList.remove('is-dragging', 'is-applying-force');
  }

  createDefaultPreviewOrbit() {
    return {
      yaw: 0,
      pitch: 0,
      distance: 1,
      initialized: false,
      userControlled: false
    };
  }

  getEntityPreviewPointer(event) {
    if (!this.previewCanvas) return this.previewPointer.set(0, 0);
    const rect = this.previewCanvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return this.previewPointer.set(
      ((event.clientX - rect.left) / width) * 2 - 1,
      -((event.clientY - rect.top) / height) * 2 + 1
    );
  }

  handleEntityPreviewPointerDown(event) {
    if (event.button !== 0 || !this.previewTarget || !this.previewCamera) return;
    event.preventDefault();
    event.stopPropagation();

    this.previewCanvas?.setPointerCapture?.(event.pointerId);
    this.previewTarget.rootGroup?.updateMatrixWorld(true);
    this.previewCamera.updateMatrixWorld(true);
    this.previewRaycaster.setFromCamera(this.getEntityPreviewPointer(event), this.previewCamera);
    // Entity meshes use flat-space geometry and are bent by the GPU; locally linearize the bent ray back into flat space.
    const ray = this.previewRaycaster.ray;
    const flatOrigin = unbendPoint(ray.origin.x, ray.origin.y, ray.origin.z, new THREE.Vector3());
    const flatDir = unbendDirection(flatOrigin.x, flatOrigin.y, flatOrigin.z, ray.direction, new THREE.Vector3());
    ray.origin.copy(flatOrigin);
    ray.direction.copy(flatDir);
    const targetHits = this.previewTarget.rootGroup
      ? this.previewRaycaster.intersectObject(this.previewTarget.rootGroup, true)
        .filter(hit => hit.object.isMesh)
      : [];

    if (targetHits.length > 0) {
      const hit = targetHits[0];
      let currentObj = hit.object;
      let hitNodeId = this.previewTarget.rootComponentId;
      while (currentObj && currentObj !== this.previewTarget.rootGroup) {
        if (currentObj.name?.startsWith('Entity_')) {
          hitNodeId = currentObj.name.replace('Entity_', '');
          break;
        }
        currentObj = currentObj.parent;
      }
      if (this.onEntityPreviewNodeSelect) {
        this.onEntityPreviewNodeSelect(hitNodeId);
      }

      this.previewInteraction = {
        mode: 'force',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        localPoint: this.previewTarget.worldToLocal(hit.point),
        force: new THREE.Vector3(),
        appliedFrames: 0,
        active: true
      };
      this.previewArrowHoldUntil = Infinity;
      this.previewCanvas?.classList.add('is-dragging', 'is-applying-force');

      return;
    }

    this.previewInteraction = {
      mode: 'orbit',
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      active: true
    };
    this.previewOrbit.userControlled = true;
    this.previewCanvas?.classList.add('is-dragging');
    this.previewCanvas?.classList.remove('is-applying-force');
    if (this.previewForceArrow) this.previewForceArrow.visible = false;

  }

  handleEntityPreviewPointerMove(event) {
    const interaction = this.previewInteraction;
    if (!interaction?.active || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    if (interaction.mode === 'force') {
      const forceOrigin = this.previewTarget.localToWorld(interaction.localPoint);
      interaction.force.copy(calculatePreviewDragForce(
        this.previewCamera.quaternion,
        event.clientX - interaction.startX,
        event.clientY - interaction.startY,
        this.previewTarget?.maxForce || 0,
        forceOrigin
      ));
      this.updatePreviewForceArrow(interaction);

      return;
    }

    const dx = event.clientX - interaction.lastX;
    const dy = event.clientY - interaction.lastY;
    interaction.lastX = event.clientX;
    interaction.lastY = event.clientY;
    this.previewOrbit.yaw -= dx * 0.008;
    this.previewOrbit.pitch = THREE.MathUtils.clamp(
      this.previewOrbit.pitch + dy * 0.006,
      -1.25,
      1.25
    );
  }

  handleEntityPreviewPointerUp(event) {
    const interaction = this.previewInteraction;
    if (!interaction?.active || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    interaction.active = false;
    this.previewCanvas?.releasePointerCapture?.(event.pointerId);
    this.previewCanvas?.classList.remove('is-dragging', 'is-applying-force');

    if (interaction.mode === 'force') {
      if (interaction.appliedFrames === 0 && interaction.force.lengthSq() > 0) {
        this.applyEntityPreviewForce(interaction);
      }
      this.previewArrowHoldUntil = performance.now() + 650;

    } else {
      this.previewInteraction = null;
    }
  }

  applyEntityPreviewForce(interaction) {
    if (!this.previewTarget || !interaction?.localPoint || !interaction?.force) return;
    const force = interaction.force;
    const point = interaction.localPoint;
    this.previewTarget.applyForceAt(
      [force.x, force.y, force.z],
      [point.x, point.y, point.z]
    );
    interaction.appliedFrames += 1;
  }

  updatePreviewForceArrow(interaction = this.previewInteraction) {
    if (!this.previewForceArrow || !this.previewTarget || interaction?.mode !== 'force') return;
    const magnitude = interaction.force.length();
    if (magnitude < 0.01) {
      this.previewForceArrow.visible = false;
      return;
    }

    const origin = this.previewTarget.localToWorld(interaction.localPoint);
    const direction = interaction.force.clone().normalize();
    const limit = Math.max(1, this.previewTarget.maxForce * ENTITY_PREVIEW_FORCE_LIMIT_RATIO);
    const ratio = THREE.MathUtils.clamp(magnitude / limit, 0, 1);
    const radius = Math.max(0.75, this.previewTarget.boundingRadius || 0.75);
    const length = radius * (0.48 + ratio * 1.65);
    this.previewForceArrow.position.copy(origin);
    this.previewForceArrow.setDirection(direction);
    this.previewForceArrow.setLength(
      length,
      Math.min(radius * 0.52, length * 0.38),
      Math.min(radius * 0.28, length * 0.2)
    );
    this.previewForceArrow.visible = true;
    this.previewForceArrow.updateMatrixWorld(true);
  }


  renderEntityPreview(contraption = this.previewTarget) {
    if (!this.previewRenderer || !this.previewCamera || !this.previewCanvas || !contraption) return;
    this.setEntityPreviewTarget(contraption);
    // Hierarchy rebuilds can introduce new meshes while the same entity stays
    // selected, so ensure only that small subtree joins the preview layer.
    contraption.rootGroup?.traverse?.(object => {
      object.layers.enable(ENTITY_PREVIEW_LAYER);
    });

    const width = Math.max(1, Math.round(this.previewCanvas.clientWidth));
    const height = Math.max(1, Math.round(this.previewCanvas.clientHeight));
    if (width <= 1 || height <= 1) return;

    const pixelRatio = this.previewRenderer.getPixelRatio();
    if (this.previewCanvas.width !== Math.round(width * pixelRatio)
      || this.previewCanvas.height !== Math.round(height * pixelRatio)) {
      this.previewRenderer.setSize(width, height, false);
    }

    const aspect = width / height;
    const pose = calculateEntityPreviewCameraPose(contraption, aspect, this.previewCamera.fov);
    if (!this.previewOrbit.initialized || !this.previewOrbit.userControlled) {
      const offset = pose.position.clone().sub(pose.center);
      const distance = Math.max(0.01, offset.length());
      this.previewOrbit.yaw = Math.atan2(offset.x, offset.z);
      this.previewOrbit.pitch = Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1));
      this.previewOrbit.distance = distance;
      this.previewOrbit.initialized = true;
    }

    const cosPitch = Math.cos(this.previewOrbit.pitch);
    const cameraOffset = new THREE.Vector3(
      Math.sin(this.previewOrbit.yaw) * cosPitch,
      Math.sin(this.previewOrbit.pitch),
      Math.cos(this.previewOrbit.yaw) * cosPitch
    ).multiplyScalar(this.previewOrbit.distance);
    this.previewCamera.aspect = aspect;
    this.previewCamera.near = Math.max(0.03, pose.radius * 0.015);
    this.previewCamera.far = Math.max(500, pose.distance + pose.radius * 12);
    this.previewCamera.position.copy(pose.center).add(cameraOffset);
    this.previewCamera.up.set(0, 1, 0);
    this.previewCamera.lookAt(pose.center);
    this.previewCamera.updateProjectionMatrix();
    this.previewCamera.updateMatrixWorld(true);
    // Torus world: bend the preview camera as well; the GPU bends entity meshes.
    applyCameraBend(this.previewCamera);

    if (this.previewInteraction?.mode === 'force') {
      if (this.previewInteraction.active && this.previewInteraction.force.lengthSq() > 0) {
        this.applyEntityPreviewForce(this.previewInteraction);
      }
      this.updatePreviewForceArrow(this.previewInteraction);
      if (!this.previewInteraction.active && performance.now() > this.previewArrowHoldUntil) {
        this.previewForceArrow.visible = false;
        this.previewInteraction = null;
      }
    }

    this.previewRenderer.render(this.scene, this.previewCamera);
    this.previewLastRenderedAt = performance.now();
  }

  /** Render the editor preview smoothly without tying it to the 10 Hz React HUD. */
  renderEntityPreviewIfDue(now = performance.now()) {
    if (!this.previewTarget || !this.previewRenderer || !this.previewCamera || !this.previewCanvas) return false;
    if (this.previewLastRenderedAt > 0
      && now - this.previewLastRenderedAt < ENTITY_PREVIEW_FRAME_INTERVAL_MS) return false;
    this.renderEntityPreview(this.previewTarget);
    // Tests and non-browser render adapters may not update the timestamp in
    // renderEntityPreview, so the scheduler owns the definitive due time.
    this.previewLastRenderedAt = now;
    return true;
  }

  /**
   * Selector focus guide: a simple 1x1x1 wireframe for the block under the crosshair.
   */
  setupFocusBlockGuide() {
    const box = new THREE.BoxGeometry(1, 1, 1, 5, 5, 5);
    const edges = new THREE.EdgesGeometry(box);
    const mat = new THREE.LineBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.85,
      // The wireframe is inside the block, so disable depth testing for an X-ray view.
      depthTest: false,
      depthWrite: false
    });
    this.focusBlockGuide = new THREE.LineSegments(edges, mat);
    this.focusBlockGuide.name = 'FocusBlockGuide';
    this.focusBlockGuide.renderOrder = 40;
    this.focusBlockGuide.visible = false;
    this.scene.add(this.focusBlockGuide);
  }

  setFocusBlockGuide(center, active = false, cellSize = 1, quaternion = null) {
    if (!this.focusBlockGuide) return;
    if (!center) {
      this.focusBlockGuide.visible = false;
      return;
    }
    this.focusBlockGuide.position.set(center.x, center.y, center.z);
    this.focusBlockGuide.quaternion.copy(
      quaternion?.isQuaternion ? quaternion : new THREE.Quaternion()
    );
    // The geometry is 1.04 m across, so scaling by the target cell size makes
    // the guide hug a 1 m standard cell or a 0.125 m micro block.
    this.focusBlockGuide.scale.setScalar(cellSize);
    // Orange while point 1 is set; cyan while waiting for point 1.
    (this.focusBlockGuide.material as THREE.LineBasicMaterial).color
      .setHex(active ? 0xff9f43 : 0x48dbfb);
    this.focusBlockGuide.visible = true;
  }

  clearFocusBlockGuide() {
    if (this.focusBlockGuide) this.focusBlockGuide.visible = false;
  }

  setupWrenchPivotGizmo() {
    // Display-only local axes for the pointed component pivot. They are not
    // raycast handles and never change color in response to pointer state.
    this.wrenchPivotGizmo = new THREE.Group();
    this.wrenchPivotGizmo.name = 'WrenchPivotGizmo';
    this.wrenchPivotGizmo.visible = false;
    this.wrenchPivotGizmo.renderOrder = 95;
    this.wrenchPivotArrows = new Map();

    const definitions = [
      ['x', new THREE.Vector3(1, 0, 0), 0xff3b30],
      ['y', new THREE.Vector3(0, 1, 0), 0x34c759],
      ['z', new THREE.Vector3(0, 0, 1), 0x248aff]
    ] as const;
    for (const [axis, direction, color] of definitions) {
      const arrow = new THREE.ArrowHelper(direction, new THREE.Vector3(), 1, color, 0.24, 0.12);
      arrow.name = `WrenchPivotAxis_${axis.toUpperCase()}`;
      for (const object of [arrow.line, arrow.cone]) {
        const material: any = object.material;
        material.depthTest = false;
        material.depthWrite = false;
        material.transparent = true;
        material.opacity = 0.96;
        object.renderOrder = 96;
        object.frustumCulled = false;
      }
      this.wrenchPivotArrows.set(axis, arrow);
      this.wrenchPivotGizmo.add(arrow);
    }

    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
    );
    center.name = 'WrenchPivotOrigin';
    center.renderOrder = 97;
    center.frustumCulled = false;
    this.wrenchPivotOrigin = center;
    this.wrenchPivotGizmo.add(center);

    hookSceneMaterials(this.wrenchPivotGizmo);
    this.scene.add(this.wrenchPivotGizmo);
  }

  setWrenchPivotGizmo(
    position: THREE.Vector3 | null,
    quaternion: THREE.Quaternion | null = null,
    axisLength = 1
  ) {
    if (!this.wrenchPivotGizmo) this.setupWrenchPivotGizmo();
    if (!position) {
      this.wrenchPivotGizmo.visible = false;
      return;
    }

    this.wrenchPivotGizmo.position.copy(position);
    this.wrenchPivotGizmo.quaternion.copy(
      quaternion?.isQuaternion ? quaternion : new THREE.Quaternion()
    );
    this.wrenchPivotGizmo.scale.setScalar(Math.max(0.1, Number(axisLength) || 1));
    const baseColors = { x: 0xff3b30, y: 0x34c759, z: 0x248aff };
    for (const [axis, arrow] of this.wrenchPivotArrows) {
      arrow.setColor(new THREE.Color(baseColors[axis]));
    }
    if (this.wrenchPivotOrigin) {
      const material = this.wrenchPivotOrigin.material as THREE.MeshBasicMaterial;
      material.color.setHex(0xffffff);
      this.wrenchPivotOrigin.scale.setScalar(1);
    }
    this.wrenchPivotGizmo.visible = true;
    this.wrenchPivotGizmo.updateMatrixWorld(true);
  }

  clearWrenchPivotGizmo() {
    if (this.wrenchPivotGizmo) this.wrenchPivotGizmo.visible = false;
  }

  setupSelectionAxisGizmo() {
    this.selectionAxisGizmo = new THREE.Group();
    this.selectionAxisGizmo.name = 'SelectionAxisGizmo';
    this.selectionAxisGizmo.visible = false;
    this.selectionAxisGizmo.renderOrder = 98;

    this.selectionGizmoHandles = new Map();
    this.selectionGizmoMaterials = new Map();

    const handleDefs = [
      { key: '+x', axis: 'x' as const, dir: new THREE.Vector3(1, 0, 0), color: 0xff3b30 },
      { key: '-x', axis: 'x' as const, dir: new THREE.Vector3(-1, 0, 0), color: 0xff3b30 },
      { key: '+y', axis: 'y' as const, dir: new THREE.Vector3(0, 1, 0), color: 0x34c759 },
      { key: '-y', axis: 'y' as const, dir: new THREE.Vector3(0, -1, 0), color: 0x34c759 },
      { key: '+z', axis: 'z' as const, dir: new THREE.Vector3(0, 0, 1), color: 0x248aff },
      { key: '-z', axis: 'z' as const, dir: new THREE.Vector3(0, 0, -1), color: 0x248aff }
    ];

    for (const def of handleDefs) {
      const group = new THREE.Group();
      group.name = `SelectionGizmoHandle_${def.key}`;
      const directionVal: 1 | -1 = (def.dir.x > 0 || def.dir.y > 0 || def.dir.z > 0) ? 1 : -1;
      group.userData = {
        isGizmoHandle: true,
        handleKey: def.key,
        axis: def.axis,
        direction: directionVal,
        baseColor: def.color
      };

      // Arrow cone (compact and sleek)
      const coneGeo = new THREE.ConeGeometry(0.08, 0.20, 16);
      coneGeo.rotateX(Math.PI / 2);

      const mat = new THREE.MeshBasicMaterial({
        color: def.color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      });
      const cone = new THREE.Mesh(coneGeo, mat);
      cone.renderOrder = 98;
      cone.frustumCulled = false;
      cone.lookAt(def.dir);
      cone.userData = group.userData;
      group.add(cone);

      // Invisible pick sphere for accurate raycast hitting. It is larger than
      // the visible arrow so the small handles stay easy to grab.
      const pickGeo = new THREE.SphereGeometry(SELECTION_GIZMO_PICK_RADIUS, 10, 8);
      const pickMat = new THREE.MeshBasicMaterial({
        visible: false,
        depthTest: false,
        depthWrite: false
      });
      const pickMesh = new THREE.Mesh(pickGeo, pickMat);
      pickMesh.name = `SelectionGizmoPick_${def.key}`;
      pickMesh.userData = group.userData;
      group.add(pickMesh);

      this.selectionGizmoHandles.set(def.key, group);
      this.selectionGizmoMaterials.set(def.key, mat);
      this.selectionAxisGizmo.add(group);
    }

    // Axis lines (X in red, Y in green, Z in blue)
    const lineMatX = new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 });
    const lineMatY = new THREE.LineBasicMaterial({ color: 0x34c759, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 });
    const lineMatZ = new THREE.LineBasicMaterial({ color: 0x248aff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 });

    const lineGeoX = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const lineGeoY = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const lineGeoZ = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);

    this.selectionGizmoLineX = new THREE.Line(lineGeoX, lineMatX);
    this.selectionGizmoLineY = new THREE.Line(lineGeoY, lineMatY);
    this.selectionGizmoLineZ = new THREE.Line(lineGeoZ, lineMatZ);

    this.selectionGizmoLineX.renderOrder = 97;
    this.selectionGizmoLineY.renderOrder = 97;
    this.selectionGizmoLineZ.renderOrder = 97;

    this.selectionAxisGizmo.add(this.selectionGizmoLineX);
    this.selectionAxisGizmo.add(this.selectionGizmoLineY);
    this.selectionAxisGizmo.add(this.selectionGizmoLineZ);

    // Origin sphere (compact center point)
    const originGeo = new THREE.SphereGeometry(0.05, 12, 10);
    const originMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95
    });
    this.selectionGizmoOrigin = new THREE.Mesh(originGeo, originMat);
    this.selectionGizmoOrigin.renderOrder = 99;
    this.selectionAxisGizmo.add(this.selectionGizmoOrigin);

    hookSceneMaterials(this.selectionAxisGizmo);
    this.scene.add(this.selectionAxisGizmo);
  }

  updateSelectionAxisGizmo(bounds: any, isMicro = false, frame: any = null) {
    if (!bounds) {
      this.clearSelectionAxisGizmo();
      return;
    }
    if (!this.selectionAxisGizmo) this.setupSelectionAxisGizmo();

    let minWx: number, maxWx: number, minWy: number, maxWy: number, minWz: number, maxWz: number;
    if (isMicro) {
      minWx = bounds.minX * MICRO_SIZE;
      maxWx = (bounds.maxX + 1) * MICRO_SIZE;
      minWy = bounds.minY * MICRO_SIZE;
      maxWy = (bounds.maxY + 1) * MICRO_SIZE;
      minWz = bounds.minZ * MICRO_SIZE;
      maxWz = (bounds.maxZ + 1) * MICRO_SIZE;
    } else {
      minWx = bounds.minX;
      maxWx = bounds.maxX + 1;
      minWy = bounds.minY;
      maxWy = bounds.maxY + 1;
      minWz = bounds.minZ;
      maxWz = bounds.maxZ + 1;
    }

    const cx = (minWx + maxWx) * 0.5;
    const cy = (minWy + maxWy) * 0.5;
    const cz = (minWz + maxWz) * 0.5;

    const handleScale = isMicro ? 0.4 : 0.7;
    const arrowOffset = isMicro ? 0.05 : 0.15;

    if (frame?.object?.localToWorld) {
      frame.object.updateWorldMatrix?.(true, false);
      const pivot = frame.pivot ? new THREE.Vector3(frame.pivot.x, frame.pivot.y, frame.pivot.z) : new THREE.Vector3();
      const localCenter = new THREE.Vector3(cx, cy, cz).sub(pivot);
      this.selectionAxisGizmo.position.copy(frame.object.localToWorld(localCenter));
      frame.object.getWorldQuaternion(this.selectionAxisGizmo.quaternion);

      const hx = (maxWx - minWx) * 0.5;
      const hy = (maxWy - minWy) * 0.5;
      const hz = (maxWz - minWz) * 0.5;

      const handlePositions: Record<string, [number, number, number]> = {
        '+x': [hx + arrowOffset, 0, 0],
        '-x': [-(hx + arrowOffset), 0, 0],
        '+y': [0, hy + arrowOffset, 0],
        '-y': [0, -(hy + arrowOffset), 0],
        '+z': [0, 0, hz + arrowOffset],
        '-z': [0, 0, -(hz + arrowOffset)]
      };

      for (const [key, pos] of Object.entries(handlePositions)) {
        const handle = this.selectionGizmoHandles?.get(key);
        if (handle) {
          handle.position.set(pos[0], pos[1], pos[2]);
          handle.scale.setScalar(handleScale);
        }
      }

      this.selectionGizmoLineX.geometry.setFromPoints([
        new THREE.Vector3(-(hx + arrowOffset), 0, 0),
        new THREE.Vector3(hx + arrowOffset, 0, 0)
      ]);
      this.selectionGizmoLineY.geometry.setFromPoints([
        new THREE.Vector3(0, -(hy + arrowOffset), 0),
        new THREE.Vector3(0, hy + arrowOffset, 0)
      ]);
      this.selectionGizmoLineZ.geometry.setFromPoints([
        new THREE.Vector3(0, 0, -(hz + arrowOffset)),
        new THREE.Vector3(0, 0, hz + arrowOffset)
      ]);

      this.selectionGizmoOrigin.position.set(0, 0, 0);
      this.selectionGizmoOrigin.scale.setScalar(handleScale);
    } else {
      this.selectionAxisGizmo.position.set(0, 0, 0);
      this.selectionAxisGizmo.quaternion.identity();

      const handlePositions: Record<string, [number, number, number]> = {
        '+x': [maxWx + arrowOffset, cy, cz],
        '-x': [minWx - arrowOffset, cy, cz],
        '+y': [cx, maxWy + arrowOffset, cz],
        '-y': [cx, minWy - arrowOffset, cz],
        '+z': [cx, cy, maxWz + arrowOffset],
        '-z': [cx, cy, minWz - arrowOffset]
      };

      for (const [key, pos] of Object.entries(handlePositions)) {
        const handle = this.selectionGizmoHandles?.get(key);
        if (handle) {
          handle.position.set(pos[0], pos[1], pos[2]);
          handle.scale.setScalar(handleScale);
        }
      }

      this.selectionGizmoLineX.geometry.setFromPoints([
        new THREE.Vector3(minWx - arrowOffset, cy, cz),
        new THREE.Vector3(maxWx + arrowOffset, cy, cz)
      ]);
      this.selectionGizmoLineY.geometry.setFromPoints([
        new THREE.Vector3(cx, minWy - arrowOffset, cz),
        new THREE.Vector3(cx, maxWy + arrowOffset, cz)
      ]);
      this.selectionGizmoLineZ.geometry.setFromPoints([
        new THREE.Vector3(cx, cy, minWz - arrowOffset),
        new THREE.Vector3(cx, cy, maxWz + arrowOffset)
      ]);

      this.selectionGizmoOrigin.position.set(cx, cy, cz);
      this.selectionGizmoOrigin.scale.setScalar(handleScale);
    }

    this.selectionAxisGizmo.visible = true;
    this.selectionAxisGizmo.updateMatrixWorld(true);
  }

  highlightSelectionGizmoHandle(activeKey: string | null) {
    if (!this.selectionGizmoMaterials) return;
    const baseColors: Record<string, number> = {
      '+x': 0xff3b30,
      '-x': 0xff3b30,
      '+y': 0x34c759,
      '-y': 0x34c759,
      '+z': 0x248aff,
      '-z': 0x248aff
    };
    for (const [key, mat] of this.selectionGizmoMaterials) {
      const handle = this.selectionGizmoHandles?.get(key);
      if (key === activeKey) {
        mat.color.setHex(0xffea00); // Highlight yellow
        mat.opacity = 1.0;
        if (handle) handle.scale.setScalar(1.25 * (handle.scale.x < 0.8 ? 0.65 : 1.0));
      } else {
        mat.color.setHex(baseColors[key]);
        mat.opacity = 0.95;
        if (handle) handle.scale.setScalar(handle.scale.x > 0.8 ? 1.0 : 0.65);
      }
    }
  }

  clearSelectionAxisGizmo() {
    if (this.selectionAxisGizmo) {
      this.selectionAxisGizmo.visible = false;
      this.selectionAxisGizmo.position.set(0, 0, 0);
      this.selectionAxisGizmo.quaternion.identity();
      this.highlightSelectionGizmoHandle(null);
    }
  }

  raycastSelectionGizmo(raycaster: THREE.Raycaster) {
    if (!this.selectionAxisGizmo || !this.selectionAxisGizmo.visible) return null;
    const candidates: THREE.Object3D[] = [];
    if (this.selectionGizmoHandles) {
      for (const handleGroup of this.selectionGizmoHandles.values()) {
        candidates.push(...handleGroup.children);
      }
    }
    const intersects = raycaster.intersectObjects(candidates, false);
    if (intersects.length > 0) {
      const hitObj = intersects[0].object;
      const data = hitObj.userData;
      if (data && data.isGizmoHandle) {
        return {
          handleKey: data.handleKey as string,
          axis: data.axis as 'x' | 'y' | 'z',
          direction: data.direction as 1 | -1,
          point: intersects[0].point,
          distance: intersects[0].distance
        };
      }
    }
    return null;
  }

  /**
   * Bent-space counterpart of {@link raycastSelectionGizmo}. The gizmo is
   * rendered bent by the torus shader, so picking it with the flat ray made the
   * small handles miss whenever the selection sat away from the player. Bend the
   * ray and the handle centres the same way the renderer (and the entity pick)
   * do, so the arrows are grabbed exactly where they appear.
   */
  raycastSelectionGizmoBent(origin: THREE.Vector3, direction: THREE.Vector3) {
    if (!this.selectionAxisGizmo || !this.selectionAxisGizmo.visible) return null;
    if (!origin || !direction) return null;
    const ray = new THREE.Ray(origin.clone(), direction.clone().normalize());
    this.selectionAxisGizmo.updateMatrixWorld(true);
    let best: any = null;
    const worldPos = new THREE.Vector3();
    const bentCenter = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    for (const handleGroup of this.selectionGizmoHandles?.values() || []) {
      handleGroup.updateMatrixWorld(true);
      const pick = handleGroup.children.find(child => child.name?.startsWith('SelectionGizmoPick_')) as THREE.Mesh | undefined;
      if (!pick) continue;
      pick.getWorldPosition(worldPos);
      const pickRadius = (pick.geometry as any)?.parameters?.radius || SELECTION_GIZMO_PICK_RADIUS;
      const radius = pickRadius * (handleGroup.scale?.x || 1);
      bendPoint(worldPos.x, worldPos.y, worldPos.z, bentCenter);
      sphere.center.copy(bentCenter);
      sphere.radius = radius;
      const hit = ray.intersectSphere(sphere, hitPoint);
      if (!hit) continue;
      const distance = ray.origin.distanceTo(hit);
      if (best && distance >= best.distance) continue;
      const data = handleGroup.userData;
      best = {
        handleKey: data.handleKey as string,
        axis: data.axis as 'x' | 'y' | 'z',
        direction: data.direction as 1 | -1,
        point: hit.clone(),
        distance
      };
    }
    return best;
  }

  setWrenchTether(startPoint: THREE.Vector3 | null, endPoint: THREE.Vector3 | null) {
    if (!this.wrenchTetherLine) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3()
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false
      });
      this.wrenchTetherLine = new THREE.Line(geom, mat);
      this.wrenchTetherLine.name = 'WrenchTetherLine';
      this.wrenchTetherLine.renderOrder = 90;
      this.wrenchTetherLine.frustumCulled = false;
      this.wrenchTetherLine.visible = false;
      this.scene.add(this.wrenchTetherLine);
    }
    if (!startPoint || !endPoint) {
      this.wrenchTetherLine.visible = false;
      return;
    }
    const posAttr = this.wrenchTetherLine.geometry.attributes.position as THREE.BufferAttribute;
    posAttr.setXYZ(0, startPoint.x, startPoint.y, startPoint.z);
    posAttr.setXYZ(1, endPoint.x, endPoint.y, endPoint.z);
    posAttr.needsUpdate = true;
    this.wrenchTetherLine.visible = true;
  }


  /**
   * Live selector-box preview in a desktop drag-selection style.
   * After point 1 is set, show a translucent AABB from the start to the crosshair;
   * the second click confirms it.
   */
  setupBoxSelectionPreview() {
    this.boxSelectionGroup = new THREE.Group();
    this.boxSelectionGroup.name = 'BoxSelectionPreview';

    const unit = new THREE.BoxGeometry(1, 1, 1);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    this.boxSelectionFill = new THREE.Mesh(unit, fillMat);
    this.boxSelectionFill.renderOrder = 41;
    this.boxSelectionGroup.add(this.boxSelectionFill);

    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x48dbfb,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    });
    this.boxSelectionEdges = new THREE.LineSegments(new THREE.EdgesGeometry(unit), edgeMat);
    this.boxSelectionEdges.renderOrder = 42;
    this.boxSelectionGroup.add(this.boxSelectionEdges);

    this.boxSelectionGroup.visible = false;
    this.scene.add(this.boxSelectionGroup);
  }

  setBoxSelectionPreview(a, b, micro = false, frame = null) {
    if (!this.boxSelectionGroup) return;
    if (!a || !b) {
      this.boxSelectionGroup.visible = false;
      return;
    }
    const applyFrame = center => {
      this.boxSelectionGroup.scale.set(1, 1, 1);
      if (frame?.object?.localToWorld) {
        frame.object.updateWorldMatrix?.(true, false);
        const pivot = previewVector3(frame.pivot);
        this.boxSelectionGroup.position.copy(
          frame.object.localToWorld(center.clone().sub(pivot))
        );
        frame.object.getWorldQuaternion(this.boxSelectionGroup.quaternion);
      } else {
        this.boxSelectionGroup.position.copy(center);
        this.boxSelectionGroup.quaternion.identity();
      }
    };
    const frameLimits = divisions => {
      if (!frame?.bounds?.min || !frame?.bounds?.max) return null;
      const min = previewVector3(frame.bounds.min).multiplyScalar(divisions);
      const max = previewVector3(frame.bounds.max).multiplyScalar(divisions);
      if (!Number.isFinite(min.x) || !Number.isFinite(max.x) || min.x > max.x ||
        !Number.isFinite(min.y) || !Number.isFinite(max.y) || min.y > max.y ||
        !Number.isFinite(min.z) || !Number.isFinite(max.z) || min.z > max.z) {
        return null;
      }
      return {
        minX: Math.floor(min.x + 1e-6),
        minY: Math.floor(min.y + 1e-6),
        minZ: Math.floor(min.z + 1e-6),
        maxX: Math.ceil(max.x - 1e-6) - 1,
        maxY: Math.ceil(max.y - 1e-6) - 1,
        maxZ: Math.ceil(max.z - 1e-6) - 1
      };
    };
    const clampCell = (value, min, max) => Math.max(min, Math.min(max, value));
    if (micro) {
      // Micro mode (Selector Tab): a/b are the meter-space origins of 0.125 m
      // cells, so quantize to micro indices and span whole micro cells.
      let aMx = Math.floor(a.x * MICRO_DIVISIONS + 1e-6);
      let bMx = frame
        ? Math.floor(b.x * MICRO_DIVISIONS + 1e-6)
        : unwrapPeriodicNear(Math.floor(b.x * MICRO_DIVISIONS + 1e-6), aMx, TORUS_SIZE_X * MICRO_DIVISIONS);
      let aMy = Math.floor(a.y * MICRO_DIVISIONS + 1e-6);
      let bMy = Math.floor(b.y * MICRO_DIVISIONS + 1e-6);
      let aMz = Math.floor(a.z * MICRO_DIVISIONS + 1e-6);
      let bMz = frame
        ? Math.floor(b.z * MICRO_DIVISIONS + 1e-6)
        : unwrapPeriodicNear(Math.floor(b.z * MICRO_DIVISIONS + 1e-6), aMz, TORUS_SIZE_Z * MICRO_DIVISIONS);
      const limits = frameLimits(MICRO_DIVISIONS);
      if (limits) {
        aMx = clampCell(aMx, limits.minX, limits.maxX);
        bMx = clampCell(bMx, limits.minX, limits.maxX);
        aMy = clampCell(aMy, limits.minY, limits.maxY);
        bMy = clampCell(bMy, limits.minY, limits.maxY);
        aMz = clampCell(aMz, limits.minZ, limits.maxZ);
        bMz = clampCell(bMz, limits.minZ, limits.maxZ);
      }
      const minMx = Math.min(aMx, bMx);
      const maxMx = Math.max(aMx, bMx);
      const minMy = Math.min(aMy, bMy);
      const maxMy = Math.max(aMy, bMy);
      const minMz = Math.min(aMz, bMz);
      const maxMz = Math.max(aMz, bMz);
      const sx = (maxMx - minMx + 1) * MICRO_SIZE;
      const sy = (maxMy - minMy + 1) * MICRO_SIZE;
      const sz = (maxMz - minMz + 1) * MICRO_SIZE;
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) || sx <= 0 || sy <= 0 || sz <= 0) {
        this.boxSelectionGroup.visible = false;
        return;
      }
      updateTorusSelectionBoxGeometry(this.boxSelectionFill, this.boxSelectionEdges, sx, sy, sz);
      applyFrame(new THREE.Vector3(
        minMx * MICRO_SIZE + sx / 2,
        minMy * MICRO_SIZE + sy / 2,
        minMz * MICRO_SIZE + sz / 2
      ));
      this.boxSelectionFill.scale.set(sx, sy, sz);
      this.boxSelectionEdges.scale.set(sx, sy, sz);
      this.boxSelectionGroup.visible = true;
      return;
    }
    // Block alignment rounds corners, adds one cell to the span, and centers on
    // cell centers. This exactly matches updateSelectionHologram, so the preview
    // and confirmed selection have identical geometry.
    let aX = Math.floor(a.x);
    let bX = frame ? Math.floor(b.x) : unwrapPeriodicNear(Math.floor(b.x), aX, TORUS_SIZE_X);
    let aY = Math.floor(a.y);
    let bY = Math.floor(b.y);
    let aZ = Math.floor(a.z);
    let bZ = frame ? Math.floor(b.z) : unwrapPeriodicNear(Math.floor(b.z), aZ, TORUS_SIZE_Z);
    const limits = frameLimits(1);
    if (limits) {
      aX = clampCell(aX, limits.minX, limits.maxX);
      bX = clampCell(bX, limits.minX, limits.maxX);
      aY = clampCell(aY, limits.minY, limits.maxY);
      bY = clampCell(bY, limits.minY, limits.maxY);
      aZ = clampCell(aZ, limits.minZ, limits.maxZ);
      bZ = clampCell(bZ, limits.minZ, limits.maxZ);
    }
    const minX = Math.min(aX, bX), maxX = Math.max(aX, bX);
    const minY = Math.min(aY, bY), maxY = Math.max(aY, bY);
    const minZ = Math.min(aZ, bZ), maxZ = Math.max(aZ, bZ);
    const sx = Math.max(0.001, maxX - minX + 1);
    const sy = Math.max(0.001, maxY - minY + 1);
    const sz = Math.max(0.001, maxZ - minZ + 1);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) || sx <= 0 || sy <= 0 || sz <= 0) {
      this.boxSelectionGroup.visible = false;
      return;
    }
    updateTorusSelectionBoxGeometry(this.boxSelectionFill, this.boxSelectionEdges, sx, sy, sz);
    applyFrame(new THREE.Vector3(
      (minX + maxX + 1) / 2,
      (minY + maxY + 1) / 2,
      (minZ + maxZ + 1) / 2
    ));
    this.boxSelectionFill.scale.set(sx, sy, sz);
    this.boxSelectionEdges.scale.set(sx, sy, sz);
    this.boxSelectionGroup.visible = true;
  }

  private buildCulledVoxelHologram(
    cells: Array<{ x: number; y: number; z: number }>,
    cellSize: number
  ): { fillGeo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry } | null {
    if (!cells || cells.length === 0) return null;

    const cellSet = new Set<string>();
    for (const c of cells) {
      cellSet.add(`${c.x},${c.y},${c.z}`);
    }

    const faces = [
      // Top (+Y)
      { dir: [0, 1, 0], norm: [0, 1, 0], quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
      // Bottom (-Y)
      { dir: [0, -1, 0], norm: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
      // North (-Z)
      { dir: [0, 0, -1], norm: [0, 0, -1], quad: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
      // South (+Z)
      { dir: [0, 0, 1], norm: [0, 0, 1], quad: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
      // West (-X)
      { dir: [-1, 0, 0], norm: [-1, 0, 0], quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
      // East (+X)
      { dir: [1, 0, 0], norm: [1, 0, 0], quad: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] }
    ];

    const fillPositions: number[] = [];
    const fillNormals: number[] = [];
    const edgePositions: number[] = [];
    const edgeSet = new Set<string>();

    for (const c of cells) {
      for (const f of faces) {
        const nx = c.x + f.dir[0];
        const ny = c.y + f.dir[1];
        const nz = c.z + f.dir[2];
        if (cellSet.has(`${nx},${ny},${nz}`)) continue; // Internal overlapping face culled!

        const q = f.quad;
        const v0 = [(c.x + q[0][0]) * cellSize, (c.y + q[0][1]) * cellSize, (c.z + q[0][2]) * cellSize];
        const v1 = [(c.x + q[1][0]) * cellSize, (c.y + q[1][1]) * cellSize, (c.z + q[1][2]) * cellSize];
        const v2 = [(c.x + q[2][0]) * cellSize, (c.y + q[2][1]) * cellSize, (c.z + q[2][2]) * cellSize];
        const v3 = [(c.x + q[3][0]) * cellSize, (c.y + q[3][1]) * cellSize, (c.z + q[3][2]) * cellSize];

        fillPositions.push(...v0, ...v1, ...v2);
        fillPositions.push(...v0, ...v2, ...v3);
        fillNormals.push(...f.norm, ...f.norm, ...f.norm);
        fillNormals.push(...f.norm, ...f.norm, ...f.norm);

        const quadEdges = [
          [v0, v1],
          [v1, v2],
          [v2, v3],
          [v3, v0]
        ];
        for (const [p1, p2] of quadEdges) {
          const k1 = `${Math.round(p1[0] * 1000)},${Math.round(p1[1] * 1000)},${Math.round(p1[2] * 1000)}`;
          const k2 = `${Math.round(p2[0] * 1000)},${Math.round(p2[1] * 1000)},${Math.round(p2[2] * 1000)}`;
          const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edgePositions.push(...p1, ...p2);
          }
        }
      }
    }

    if (fillPositions.length === 0) return null;

    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));
    fillGeo.setAttribute('normal', new THREE.Float32BufferAttribute(fillNormals, 3));

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

    return { fillGeo, edgeGeo };
  }

  clearBoxSelectionPreview() {
    if (this.boxSelectionGroup) this.boxSelectionGroup.visible = false;
  }

  updateSelectionHologram(bounds, connectedBlocks = null, microBlocks = null, isMicroShape = false, frame: any = null) {
    const applyFrameToGroup = (grp: THREE.Group, offset: THREE.Vector3 = new THREE.Vector3(0, 0, 0)) => {
      if (frame?.object?.localToWorld) {
        frame.object.updateWorldMatrix?.(true, false);
        const pivot = frame.pivot ? new THREE.Vector3(frame.pivot.x, frame.pivot.y, frame.pivot.z) : new THREE.Vector3();
        grp.position.copy(frame.object.localToWorld(offset.clone().sub(pivot)));
        frame.object.getWorldQuaternion(grp.quaternion);
      } else {
        grp.position.copy(offset);
        grp.quaternion.identity();
      }
    };

    if (isMicroShape && Array.isArray(microBlocks)) {
      this.selectionGroup.visible = false;
      this.selectionCellsGroup.visible = false;

      if (microBlocks.length === 0) {
        this.selectionMicroCellsGroup.visible = false;
        return;
      }

      if (microBlocks.length <= 8192) {
        const signature = microBlocks.length <= 1024
          ? microBlocks.map(b => `${b.x},${b.y},${b.z}`).sort().join('|')
          : `micro-${microBlocks.length}-${microBlocks[0].x},${microBlocks[0].y},${microBlocks[0].z}-${microBlocks[microBlocks.length - 1].x},${microBlocks[microBlocks.length - 1].y},${microBlocks[microBlocks.length - 1].z}`;

        if (signature !== this.selectionMicroCellsSignature) {
          for (const child of this.selectionMicroCellsGroup.children as any[]) {
            child.geometry?.dispose();
          }
          this.selectionMicroCellsGroup.clear();
          const geos = this.buildCulledVoxelHologram(microBlocks, MICRO_SIZE);
          if (geos) {
            const fill = new THREE.Mesh(geos.fillGeo, this.selectionMicroCellFillMaterial);
            const lines = new THREE.LineSegments(geos.edgeGeo, this.selectionMicroCellLineMaterial);
            fill.renderOrder = 20;
            lines.renderOrder = 21;
            this.selectionMicroCellsGroup.add(fill, lines);
          }
          this.selectionMicroCellsSignature = signature;
        }

        applyFrameToGroup(this.selectionMicroCellsGroup);

        const t = performance.now() * 0.004;
        const pulse = (Math.sin(t) + 1) * 0.5;
        this.selectionMicroCellLineMaterial.opacity = 0.5 + pulse * 0.46;
        this.selectionMicroCellFillMaterial.opacity = 0.08 + pulse * 0.2;
        this.selectionMicroCellsGroup.visible = microBlocks.length > 0;

        // Keep the outer bounding box wireframe visible as a guide
        if (bounds) {
          const sx = Math.max(0.001, (bounds.maxX - bounds.minX + 1) * MICRO_SIZE);
          const sy = Math.max(0.001, (bounds.maxY - bounds.minY + 1) * MICRO_SIZE);
          const sz = Math.max(0.001, (bounds.maxZ - bounds.minZ + 1) * MICRO_SIZE);
          const cx = (bounds.minX + bounds.maxX + 1) * MICRO_SIZE * 0.5;
          const cy = (bounds.minY + bounds.maxY + 1) * MICRO_SIZE * 0.5;
          const cz = (bounds.minZ + bounds.maxZ + 1) * MICRO_SIZE * 0.5;
          updateTorusSelectionBoxGeometry(this.selectionFill, this.selectionWireframe, sx, sy, sz);
          this.selectionGroup.scale.set(sx, sy, sz);
          applyFrameToGroup(this.selectionGroup, new THREE.Vector3(cx, cy, cz));
          this.selectionWireframe.material.opacity = 0.35;
          this.selectionFill.material.opacity = 0.03;
          this.selectionGroup.visible = true;
        } else {
          this.selectionGroup.visible = false;
        }
        return;
      }
    }

    if (Array.isArray(microBlocks)) {
      this.selectionCellsGroup.visible = false;
      this.selectionMicroCellsGroup.visible = false;

      if (microBlocks.length === 0) {
        this.selectionGroup.visible = false;
        return;
      }

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of microBlocks) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.z < minZ) minZ = b.z;
        if (b.x > maxX) maxX = b.x;
        if (b.y > maxY) maxY = b.y;
        if (b.z > maxZ) maxZ = b.z;
      }

      const sx = Math.max(0.001, (maxX - minX + 1) * MICRO_SIZE);
      const sy = Math.max(0.001, (maxY - minY + 1) * MICRO_SIZE);
      const sz = Math.max(0.001, (maxZ - minZ + 1) * MICRO_SIZE);

      const cx = (minX + maxX + 1) * MICRO_SIZE * 0.5;
      const cy = (minY + maxY + 1) * MICRO_SIZE * 0.5;
      const cz = (minZ + maxZ + 1) * MICRO_SIZE * 0.5;

      updateTorusSelectionBoxGeometry(this.selectionFill, this.selectionWireframe, sx, sy, sz);
      this.selectionGroup.scale.set(sx, sy, sz);
      applyFrameToGroup(this.selectionGroup, new THREE.Vector3(cx, cy, cz));
      this.selectionGroup.visible = true;

      // Pulse opacity subtly matching standard mode
      const t = performance.now() * 0.003;
      const pulse = 0.75 + Math.sin(t) * 0.2;
      this.selectionWireframe.material.opacity = pulse;
      this.selectionFill.material.opacity = 0.12 + Math.sin(t) * 0.06;
      return;
    }

    if (connectedBlocks !== null) {
      this.selectionMicroCellsGroup.visible = false;
      const signature = connectedBlocks
        .map(block => `${block.x},${block.y},${block.z}`)
        .sort()
        .join('|');
      if (signature !== this.selectionCellsSignature) {
        for (const child of this.selectionCellsGroup.children as any[]) {
          child.geometry?.dispose();
        }
        this.selectionCellsGroup.clear();
        const geos = this.buildCulledVoxelHologram(connectedBlocks, 1.0);
        if (geos) {
          const fill = new THREE.Mesh(geos.fillGeo, this.selectionCellFillMaterial);
          const lines = new THREE.LineSegments(geos.edgeGeo, this.selectionCellLineMaterial);
          fill.renderOrder = 20;
          lines.renderOrder = 21;
          this.selectionCellsGroup.add(fill, lines);
        }
        this.selectionCellsSignature = signature;
      }

      applyFrameToGroup(this.selectionCellsGroup);

      const t = performance.now() * 0.004;
      const pulse = (Math.sin(t) + 1) * 0.5;
      this.selectionCellLineMaterial.opacity = 0.5 + pulse * 0.46;
      this.selectionCellFillMaterial.opacity = 0.08 + pulse * 0.2;
      this.selectionCellsGroup.visible = connectedBlocks.length > 0;

      // Keep the outer bounding box wireframe visible as a guide
      if (bounds) {
        const sx = bounds.maxX - bounds.minX + 1;
        const sy = bounds.maxY - bounds.minY + 1;
        const sz = bounds.maxZ - bounds.minZ + 1;
        const cx = (bounds.minX + bounds.maxX + 1) / 2;
        const cy = (bounds.minY + bounds.maxY + 1) / 2;
        const cz = (bounds.minZ + bounds.maxZ + 1) / 2;
        updateTorusSelectionBoxGeometry(this.selectionFill, this.selectionWireframe, sx, sy, sz);
        this.selectionGroup.scale.set(sx, sy, sz);
        applyFrameToGroup(this.selectionGroup, new THREE.Vector3(cx, cy, cz));
        this.selectionWireframe.material.opacity = 0.35;
        this.selectionFill.material.opacity = 0.03;
        this.selectionGroup.visible = true;
      } else {
        this.selectionGroup.visible = false;
      }
      return;
    }

    this.selectionCellsGroup.visible = false;
    this.selectionMicroCellsGroup.visible = false;
    this.selectionCellsGroup.position.set(0, 0, 0);
    this.selectionCellsGroup.quaternion.identity();
    this.selectionMicroCellsGroup.position.set(0, 0, 0);
    this.selectionMicroCellsGroup.quaternion.identity();

    if (!bounds) {
      this.selectionGroup.visible = false;
      return;
    }

    const isMicro = isMicroShape || (Array.isArray(microBlocks) && microBlocks.length > 0);
    const scale = isMicro ? MICRO_SIZE : 1;
    const sx = Math.max(0.001, (bounds.maxX - bounds.minX + 1) * scale);
    const sy = Math.max(0.001, (bounds.maxY - bounds.minY + 1) * scale);
    const sz = Math.max(0.001, (bounds.maxZ - bounds.minZ + 1) * scale);

    const cx = (bounds.minX + bounds.maxX + 1) * scale * 0.5;
    const cy = (bounds.minY + bounds.maxY + 1) * scale * 0.5;
    const cz = (bounds.minZ + bounds.maxZ + 1) * scale * 0.5;

    updateTorusSelectionBoxGeometry(this.selectionFill, this.selectionWireframe, sx, sy, sz);
    this.selectionGroup.scale.set(sx, sy, sz);
    applyFrameToGroup(this.selectionGroup, new THREE.Vector3(cx, cy, cz));
    this.selectionGroup.visible = true;

    // Pulse opacity subtly
    const t = performance.now() * 0.003;
    const pulse = 0.75 + Math.sin(t) * 0.2;
    this.selectionWireframe.material.opacity = pulse;
    this.selectionFill.material.opacity = 0.12 + Math.sin(t) * 0.06;
  }



  onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyResolutionScale(this.adaptiveResolution.currentScale, true);
    this.renderer.setSize(width, height);
  }

  private cappedDevicePixelRatio() {
    return Math.max(0.5, Math.min(window.devicePixelRatio || 1, 2));
  }

  private notifyResolutionScaleChange() {
    this.onResolutionScaleChange?.(this.getResolutionScaleState());
  }

  private applyResolutionScale(scale: number, notify = false) {
    const nextScale = Math.max(0.5, Math.min(1, Number(scale) || 1));
    const effectivePixelRatio = this.cappedDevicePixelRatio() * nextScale;
    const changed = Math.abs(this.renderer.getPixelRatio() - effectivePixelRatio) > 0.001;
    this.resolutionScale = nextScale;
    if (changed) this.renderer.setPixelRatio(effectivePixelRatio);
    if (notify && changed) this.notifyResolutionScaleChange();
  }

  setResolutionScale(setting: 'auto' | number) {
    const scale = this.adaptiveResolution.setSetting(setting);
    this.applyResolutionScale(scale);
    this.applyAdaptiveEffects(this.adaptiveResolution.getState().effectsQuality);
    this.notifyResolutionScaleChange();
    return this.getResolutionScaleState();
  }

  getResolutionScaleState() {
    const state = this.adaptiveResolution.getState();
    return {
      ...state,
      nativePixelRatio: this.cappedDevicePixelRatio(),
      effectivePixelRatio: this.renderer.getPixelRatio()
    };
  }

  setShadowsEnabled(enabled: boolean) {
    this.shadowsEnabled = Boolean(enabled);
    this.applyShadowState();
    return this.shadowsEnabled;
  }

  getShadowsEnabled() {
    return this.shadowsEnabled;
  }

  setLightingQuality(quality: LightingQuality) {
    this.lightingQuality = normalizeLightingQuality(quality);
    if (this.adaptiveResolution) {
      this.adaptiveResolution.setTargetFps(this.lightingQuality === 'ultra' ? 60 : 120);
      this.adaptiveEffectsQuality = this.adaptiveResolution.getState().effectsQuality;
    }
    this.applyLightingQuality();
    if (this.adaptiveResolution) this.notifyResolutionScaleChange();
    return this.lightingQuality;
  }

  getLightingQuality(): LightingQuality {
    return this.lightingQuality;
  }

  private applyLightingQuality() {
    const preset = LIGHTING_PRESETS[this.lightingQuality];
    const fullEffects = this.adaptiveEffectsQuality === 'full';
    const cinematic = this.lightingQuality === 'ultra';
    this.sunLight.color.setHex(preset.sunColor);
    this.sunLight.intensity = preset.sunIntensity;
    this.hemiLight.color.setHex(preset.hemisphereSkyColor);
    this.hemiLight.groundColor.setHex(preset.hemisphereGroundColor);
    this.hemiLight.intensity = preset.hemisphereIntensity;
    this.fillLight.intensity = preset.fillIntensity;
    this.fillLight.visible = fullEffects && preset.fillIntensity > 0;
    this.renderer.toneMappingExposure = preset.exposure;
    this.renderer.toneMapping = cinematic ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    if (this.previewRenderer) this.previewRenderer.toneMappingExposure = preset.exposure;
    this.skyDomeUniforms.uGradientStrength.value = preset.skyGradient;
    this.skyDomeUniforms.uSunGlow.value = fullEffects ? preset.sunGlow : 0;
    this.skyDomeUniforms.uCinematic.value = cinematic ? 1 : 0;
    // Targets are allocated lazily on the next Ultra frame and released when
    // leaving the preset. Adaptive fallback keeps the sky/grade/haze visible.
    if (!cinematic && this.cinematicEffects) {
      this.cinematicEffects.dispose();
      this.cinematicEffects = null;
    }

    const shadow = this.sunLight.shadow;
    // Low keeps a valid size without allocating a map; the shadow pass is off.
    const mapSize = Math.min(preset.shadowMapSize || 1024, this.renderer.capabilities.maxTextureSize);
    if (shadow.mapSize.x !== mapSize || shadow.mapSize.y !== mapSize) {
      this.releaseSunShadowMap();
      shadow.mapSize.set(mapSize, mapSize);
    }
    const extent = preset.shadowExtent;
    shadow.camera.left = shadow.camera.bottom = -extent;
    shadow.camera.right = shadow.camera.top = extent;
    shadow.camera.far = 80 + extent * 2;
    shadow.camera.updateProjectionMatrix();
    // Keep the receiver offset and filter footprint stable in world units.
    // Reducing the bias with map resolution exposes curved-face self-shadowing.
    shadow.bias = -(cinematic ? 0.12 : 0.075) / (shadow.camera.far - shadow.camera.near);
    shadow.radius = (mapSize / 1024) * (45 / extent);
    shadow.normalBias = cinematic ? 0.05 : (getWorldShapeMode() === 'earth' ? 0.025 : 0);
    shadow.needsUpdate = true;
    this.applyShadowState();
  }

  private releaseSunShadowMap() {
    const shadow = this.sunLight?.shadow;
    if (!shadow) return;
    if (shadow.map?.depthTexture) {
      shadow.map.depthTexture.dispose();
      shadow.map.depthTexture = null;
    }
    shadow.dispose();
    shadow.map = null;
    shadow.mapPass = null;
  }

  private updateAdaptiveResolution() {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const scale = this.adaptiveResolution.sampleFrame(performance.now(), visible);
    if (Math.abs(scale - this.resolutionScale) > 0.001) {
      this.applyResolutionScale(scale, true);
    }
    this.applyAdaptiveEffects(this.adaptiveResolution.getState().effectsQuality);
  }

  private applyAdaptiveEffects(quality: AdaptiveEffectsQuality) {
    if (quality === this.adaptiveEffectsQuality) return;
    this.adaptiveEffectsQuality = quality;
    this.applyLightingQuality();
    this.notifyResolutionScaleChange();
  }

  private applyShadowState() {
    const enabled = this.shadowsEnabled
      && this.lightingQuality !== 'low'
      && this.adaptiveEffectsQuality === 'full';
    // Changing only shadowMap.enabled does not invalidate Three's cached light
    // programs. Change the light's shadow count as well, so no material samples
    // a disposed shadow texture after a user toggle or adaptive fallback.
    if (this.sunLight) this.sunLight.castShadow = enabled;
    if (!enabled) this.releaseSunShadowMap();
    if (this.renderer.shadowMap.enabled === enabled) return;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
  }

  setupPlayerAvatar() {
    this.playerAvatar = new THREE.Group();
    this.playerAvatarCharacter = null;
    this.playerFirstPersonHand = null;
    this.playerAvatar.visible = false;
    this.scene.add(this.playerAvatar);

    void loadCuteCharacter(this.playerAppearance.skinUrl, {
      model: this.playerAppearance.skinModel,
      height: 1.8,
      showOverlay: true,
      castShadow: true
    }).then(character => {
      if (!this.playerAvatar) {
        character.dispose();
        return;
      }
      this.playerAvatarCharacter = character;
      this.playerAvatar.add(character.object3d);
      this.playerFirstPersonHand = character.firstPersonHand;
      this.playerFirstPersonHand.visible = !this.playerAvatar.visible;
      this.camera.add(this.playerFirstPersonHand);
      character.updateFirstPersonProjection(this.camera);
      // The model arrives asynchronously, so hook it immediately instead of
      // waiting for the scene's periodic dynamic-material scan.
      hookSceneMaterials(character.object3d);
    }).catch(error => {
      console.error('Failed to load the EntropyDrop player skin:', error);
    });
  }

  setupRemotePlayers() {
    this.remotePlayersGroup = new THREE.Group();
    this.remotePlayersGroup.name = 'RemotePlayers';
    this.remotePlayers = new Map();
    this.scene.add(this.remotePlayersGroup);
  }

  private prepareRemotePlayerCullCamera() {
    remotePlayerCullCamera.copy(this.camera, false);
    remotePlayerCullCamera.position.copy(this.camera.position);
    remotePlayerCullCamera.quaternion.copy(this.camera.quaternion);
    remotePlayerCullCamera.updateMatrixWorld(true);
    applyCameraBend(remotePlayerCullCamera);
  }

  private isRemotePlayerInView(record, distance: number) {
    // Keep very near players visible even when only part of their body crosses
    // the edge of the screen. Farther players use a torus-bent center point so
    // ordinary flat-world frustum assumptions cannot hide the wrong player.
    if (distance <= 4) return true;
    bendPoint(
      record.group.position.x,
      record.group.position.y + 0.9,
      record.group.position.z,
      remotePlayerProjectedPosition,
    );
    remotePlayerProjectedPosition.project(remotePlayerCullCamera);
    return isProjectedPlayerVisible(remotePlayerProjectedPosition);
  }

  private loadRemotePlayerCharacter(record, id: string, highDetail: boolean) {
    if (record.loadingSkin) return;
    const token = {};
    const requestedSkinUrl = record.skinUrl;
    const requestedSkinModel = record.skinModel;
    record.loadingSkin = token;

    void loadCuteCharacter(requestedSkinUrl, {
      model: requestedSkinModel,
      height: 1.8,
      showOverlay: highDetail,
      castShadow: highDetail,
      createBillboard: true,
      createFirstPersonHand: false,
    }).then(character => {
      if (
        this.remotePlayers?.get(id) !== record
        || record.loadingSkin !== token
        || record.skinUrl !== requestedSkinUrl
        || record.skinModel !== requestedSkinModel
      ) {
        character.dispose();
        if (record.loadingSkin === token) record.loadingSkin = null;
        return;
      }

      const previousCharacter = record.character;
      record.character = character;
      record.highDetail = highDetail;
      record.loadedSkinUrl = requestedSkinUrl;
      record.loadedSkinModel = requestedSkinModel;
      record.loadingSkin = null;
      record.group.add(character.object3d);
      if (character.billboard) record.group.add(character.billboard);
      hookSceneMaterials(character.object3d);
      if (character.billboard) hookSceneMaterials(character.billboard);
      previousCharacter?.dispose();
      disposeRemotePlayerFallback(record.fallback);
      record.fallback = null;
      this.applyRemotePlayerLod(record, record.lod ?? 'hidden', record.inView ?? false);
    }).catch(err => {
      if (record.loadingSkin === token) record.loadingSkin = null;
      console.warn('Failed to load remote player skin:', err);
    });
  }

  private applyRemotePlayerLod(record, lod: RemotePlayerLod, inView: boolean) {
    const shouldRender = lod !== 'hidden' && inView;
    record.group.visible = shouldRender;
    record.lod = lod;
    record.inView = inView;
    if (!shouldRender) return;

    const render3d = lod === 'full' || lod === 'simplified';
    const renderBillboard = lod === 'billboard';
    if (record.fallback) record.fallback.visible = !record.character;
    if (record.nameTag) record.nameTag.visible = true;

    if (!record.character) return;
    record.character.object3d.visible = render3d;
    if (record.character.billboard) {
      record.character.billboard.visible = renderBillboard;
      if (renderBillboard) {
        const cameraDx = wrappedAxisDelta(record.group.position.x, this.camera.position.x, TORUS_SIZE_X);
        const cameraDz = wrappedAxisDelta(record.group.position.z, this.camera.position.z, TORUS_SIZE_Z);
        const worldFacingYaw = Math.atan2(cameraDx, cameraDz);
        record.character.billboard.rotation.y = worldFacingYaw - record.currentYaw;
      }
    }
    record.character.setOverlayVisible(lod === 'full' && record.highDetail);
    record.character.setCastShadow(lod === 'full' && record.highDetail);
  }

  updateRemotePlayers(players: any[], dt = 0.016) {
    if (!this.remotePlayersGroup || !this.remotePlayers) return;

    const seenIds = new Set<string>();
    const now = performance.now();
    this.prepareRemotePlayerCullCamera();

    for (const p of players) {
      if (p.is_self) continue;
      const id = String(p.user_id || p.player_entity_id);
      seenIds.add(id);

      let record = this.remotePlayers.get(id);
      if (!record) {
        const group = new THREE.Group();
        group.name = `RemotePlayer_${id}`;
        group.position.set(p.x, p.y, p.z);
        group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw || 0);

        const nameTag = createPlayerNameTag(p.username || 'Player');
        group.add(nameTag);
        const fallback = createRemotePlayerFallback();
        group.add(fallback);

        record = {
          id,
          group,
          character: null,
          fallback,
          nameTag,
          targetPosition: new THREE.Vector3(p.x, p.y, p.z),
          targetYaw: p.yaw || 0,
          currentYaw: p.yaw || 0,
          targetPitch: p.pitch || 0,
          currentPitch: p.pitch || 0,
          lastSeen: now,
          lastMotionSample: {
            x: p.x,
            y: p.y,
            z: p.z,
            updatedAt: p.updated_at || null,
          },
          lastMotionSampleAt: now,
          sampleVelocity: new THREE.Vector3(),
          skinUrl: p.skin_url,
          skinModel: p.skin_type || 'strong',
          loadedSkinUrl: null,
          loadedSkinModel: null,
          highDetail: false,
          lod: null,
          inView: false,
          speed: 0,
          loadingSkin: null
        };

        this.remotePlayers.set(id, record);
        this.remotePlayersGroup.add(group);
      } else {
        const nextSample = {
          x: p.x,
          y: p.y,
          z: p.z,
          updatedAt: p.updated_at || null,
        };
        const timestampChanged = nextSample.updatedAt !== record.lastMotionSample.updatedAt;
        const positionChanged = nextSample.x !== record.lastMotionSample.x
          || nextSample.y !== record.lastMotionSample.y
          || nextSample.z !== record.lastMotionSample.z;
        if (timestampChanged || positionChanged) {
          const estimate = estimateRemotePlayerMotion(
            record.lastMotionSample,
            nextSample,
            TORUS_SIZE_X,
            TORUS_SIZE_Z,
            (now - record.lastMotionSampleAt) / 1000,
          );
          if (estimate) {
            record.sampleVelocity.set(estimate.vx, estimate.vy, estimate.vz);
          } else {
            record.sampleVelocity.set(0, 0, 0);
          }
          record.lastMotionSample = nextSample;
          record.lastMotionSampleAt = now;
          record.targetPosition.set(p.x, p.y, p.z);
        }
        record.targetYaw = p.yaw || 0;
        record.targetPitch = p.pitch || 0;
        record.lastSeen = now;
      }
      if (p.skin_url && record.skinUrl !== p.skin_url) {
        record.skinUrl = p.skin_url;
        record.skinModel = p.skin_type || 'strong';
      }

      // Smoothly interpolate position with toroidal wrap
      let dx = wrapX(record.targetPosition.x) - wrapX(record.group.position.x);
      if (dx > TORUS_SIZE_X / 2) dx -= TORUS_SIZE_X;
      else if (dx < -TORUS_SIZE_X / 2) dx += TORUS_SIZE_X;

      let dz = wrapZ(record.targetPosition.z) - wrapZ(record.group.position.z);
      if (dz > TORUS_SIZE_Z / 2) dz -= TORUS_SIZE_Z;
      else if (dz < -TORUS_SIZE_Z / 2) dz += TORUS_SIZE_Z;

      const dy = record.targetPosition.y - record.group.position.y;
      const sampleAgeSeconds = (now - record.lastMotionSampleAt) / 1000;
      const motionFreshness = remoteMotionFreshness(sampleAgeSeconds);
      const motionVx = record.sampleVelocity.x * motionFreshness;
      const motionVy = record.sampleVelocity.y * motionFreshness;
      const motionVz = record.sampleVelocity.z * motionFreshness;
      const sampledSpeed = Math.hypot(motionVx, motionVz);
      record.speed = THREE.MathUtils.damp(record.speed, sampledSpeed, 8, dt);

      const lerpFactor = Math.min(1, dt * 12);
      record.group.position.x = wrapX(record.group.position.x + dx * lerpFactor);
      record.group.position.y = record.group.position.y + dy * lerpFactor;
      record.group.position.z = wrapZ(record.group.position.z + dz * lerpFactor);

      let dyaw = record.targetYaw - record.currentYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      record.currentYaw += dyaw * lerpFactor;
      record.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), record.currentYaw);

      record.currentPitch = THREE.MathUtils.lerp(record.currentPitch ?? 0, record.targetPitch ?? 0, lerpFactor);

      const cameraDx = wrappedAxisDelta(this.camera.position.x, record.group.position.x, TORUS_SIZE_X);
      const cameraDz = wrappedAxisDelta(this.camera.position.z, record.group.position.z, TORUS_SIZE_Z);
      const cameraDy = record.group.position.y + 0.9 - this.camera.position.y;
      const cameraDistance = Math.hypot(cameraDx, cameraDy, cameraDz);
      const lod = resolveRemotePlayerLod(cameraDistance, record.lod);
      const inView = lod !== 'hidden' && this.isRemotePlayerInView(record, cameraDistance);

      const skinChanged = record.loadedSkinUrl !== record.skinUrl
        || record.loadedSkinModel !== record.skinModel;
      const needsHighDetail = lod === 'full' && !record.highDetail;
      if (inView && (!record.character || skinChanged || needsHighDetail)) {
        this.loadRemotePlayerCharacter(record, id, lod === 'full');
      }
      this.applyRemotePlayerLod(record, lod, inView);

      if (record.character && inView && (lod === 'full' || lod === 'simplified')) {
        const forwardX = -Math.sin(record.currentYaw);
        const forwardZ = -Math.cos(record.currentYaw);
        const rightX = Math.cos(record.currentYaw);
        const rightZ = -Math.sin(record.currentYaw);
        const forwardSpeed = motionVx * forwardX + motionVz * forwardZ;
        const sideSpeed = motionVx * rightX + motionVz * rightZ;

        record.character.update(dt, {
          speed: record.speed,
          forwardSpeed,
          sideSpeed,
          verticalSpeed: motionVy,
          lookPitch: record.currentPitch,
          grounded: true,
          flying: false
        });
      }
      if (record.group.visible) record.group.updateMatrixWorld(true);
    }

    // Clean up offline/inactive players (> 15 seconds)
    for (const [id, record] of this.remotePlayers.entries()) {
      if (!seenIds.has(id) && now - record.lastSeen > 15000) {
        if (record.character) record.character.dispose();
        disposeRemotePlayerFallback(record.fallback);
        if (record.nameTag?.material?.map) record.nameTag.material.map.dispose();
        if (record.nameTag?.material) record.nameTag.material.dispose();
        record.group.removeFromParent();
        this.remotePlayers.delete(id);
      }
    }
  }

  setPlayerAvatarVisible(visible: boolean) {
    if (this.playerAvatar) {
      this.playerAvatar.visible = !!visible;
    }
    if (this.playerFirstPersonHand) {
      this.playerFirstPersonHand.visible = !visible;
    }
  }

  updatePlayerAvatar(playerPos: THREE.Vector3, playerYaw = 0, dt = 0, playerMotion: any = null) {
    if (!this.playerAvatar) return;
    if (this.playerAvatar.visible) {
      // Keep the avatar in logical flat-world coordinates. The same torus shader
      // that bends terrain bends every character vertex and its normals at render time.
      this.playerAvatar.position.copy(playerPos);
      this.playerAvatar.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), playerYaw);
    }
    if (this.playerAvatarCharacter) {
      if (this.playerAvatarCharacter.setHeldTool(playerMotion?.activeTool)) {
        // Newly selected world meshes must receive the torus shader immediately.
        hookSceneMaterials(this.playerAvatarCharacter.object3d);
      }
      const velocity = playerMotion?.velocity;
      const speed = velocity ? Math.hypot(velocity.x, velocity.z) : 0;
      const forwardX = -Math.sin(playerYaw);
      const forwardZ = -Math.cos(playerYaw);
      const rightX = Math.cos(playerYaw);
      const rightZ = -Math.sin(playerYaw);
      this.playerAvatarCharacter.update(dt, {
        speed,
        forwardSpeed: velocity ? velocity.x * forwardX + velocity.z * forwardZ : 0,
        sideSpeed: velocity ? velocity.x * rightX + velocity.z * rightZ : 0,
        verticalSpeed: velocity?.y ?? 0,
        maxSpeed: playerMotion?.maxSpeed,
        grounded: playerMotion?.grounded,
        flying: playerMotion?.flying,
        lookPitch: playerMotion?.lookPitch,
        toolUseSequence: playerMotion?.toolUseSequence
      });
      this.playerAvatarCharacter.updateFirstPersonProjection(this.camera);
    }
    if (this.playerAvatar.visible) this.playerAvatar.updateMatrixWorld(true);
  }

  update(dt, playerPos, playerYaw = 0, playerMotion: any = null) {
    setWorldProjectionAnchor(playerPos.x, playerPos.z);
    // Update player avatar when in third-person view
    this.updatePlayerAvatar(playerPos, playerYaw, dt, playerMotion);

    // Ultra's lower morning sun creates long shadows and warm grazing light.
    const sunHour = this.lightingQuality === 'ultra' ? 8.2 : 10;
    const sunAngle = ((sunHour - 6) / 24) * Math.PI * 2;
    const sunDist = 80;
    bendPoint(playerPos.x, playerPos.y, playerPos.z, this.bentLightTarget);
    const flatSunDirection = this.bentLightDirection.set(
      Math.cos(sunAngle),
      Math.max(0.1, Math.sin(sunAngle)),
      0.25
    ).normalize();
    bendDirection(playerPos.x, playerPos.y, playerPos.z, flatSunDirection, this.bentLightDirection);

    // Lights are not vertices and therefore are not affected by the torus shader.
    // Put the directional light directly in bent space so lighting and shadows
    // follow the local surface instead of pointing at a stale flat-world target.
    this.sunLight.target.position.copy(this.bentLightTarget);
    this.sunLight.position.copy(this.bentLightTarget).addScaledVector(this.bentLightDirection, sunDist);
    this.sunLight.target.updateMatrixWorld();

    // Hemisphere and bounce lighting must follow the same local surface as
    // the sun; global +Y points sideways on parts of the sphere/ring.
    this.bentSurfaceUp.set(0, 1, 0);
    bendDirection(playerPos.x, playerPos.y, playerPos.z, this.bentSurfaceUp, this.bentSurfaceUp);
    this.hemiLight.position.copy(this.bentSurfaceUp);
    this.skyDomeUniforms.uSurfaceUp.value.copy(this.bentSurfaceUp);
    const east = this.skyDomeUniforms.uEast.value.set(1, 0, 0);
    const north = this.skyDomeUniforms.uNorth.value.set(0, 0, 1);
    bendDirection(playerPos.x, playerPos.y, playerPos.z, east, east);
    bendDirection(playerPos.x, playerPos.y, playerPos.z, north, north);
    this.skyDomeUniforms.uTime.value += Math.min(Math.max(dt, 0), 0.1);
    this.sunLight.shadow.camera.up.copy(this.bentSurfaceUp);
    this.bentFillDirection.set(-0.6, 0.5, -0.65).normalize();
    bendDirection(playerPos.x, playerPos.y, playerPos.z, this.bentFillDirection, this.bentFillDirection);
    this.fillLight.target.position.copy(this.bentLightTarget);
    this.fillLight.position.copy(this.bentLightTarget).addScaledVector(this.bentFillDirection, sunDist);
    this.fillLight.target.updateMatrixWorld();

    // Fixed daylight fog. The sky dome renders the background gradient; keep
    // its base and the fog color identical so far terrain fades into the sky.
    this.scene.fog.color.copy(this.skyColorDay);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.skyColorDay);
    }
    this.skyDomeUniforms.uSkyColor.value.copy(this.skyColorDay);

  }

  setWorld(world) {
    this.impostorLod?.dispose();
    this.impostorSources?.dispose();
    this.world = world;
  }

  setContraptions(manager) {
    this.contraptionManager = manager;
  }

  getEntityImpostorSettings(): EntityImpostorSettings {
    return normalizeEntityImpostorSettings(this.entityImpostorSettings);
  }

  setEntityImpostorRetention(retain: (publicId: string) => boolean): void {
    this.retainRemoteEntityImpostor = retain;
  }

  setEntityImpostorSettings(settings: Partial<EntityImpostorSettings>): EntityImpostorSettings {
    this.entityImpostorSettings = normalizeEntityImpostorSettings({ ...this.entityImpostorSettings, ...settings });
    this.impostorLod?.setEntitySettings(this.entityImpostorSettings);
    return this.getEntityImpostorSettings();
  }

  setWorldShapeMode(mode: WorldShapeMode) {
    this.materialScanCountdown = 0;
    const value = setGlobalWorldShapeMode(mode);
    this.world?.setDistantSurfaceEnabled?.(value !== 'earth');
    // Curved interpolated normals need a small receiver offset to avoid
    // self-shadow striping. Donut mode keeps its established bias unchanged.
    this.sunLight.shadow.normalBias = this.lightingQuality === 'ultra' ? 0.05 : (value === 'earth' ? 0.025 : 0);
    this.sunLight.shadow.needsUpdate = true;
    return value;
  }

  getWorldShapeMode(): WorldShapeMode {
    return getWorldShapeMode();
  }

  private renderWorld() {
    const cinematic = this.lightingQuality === 'ultra'
      && this.renderer.extensions.has('EXT_color_buffer_float');
    if (cinematic) {
      this.cinematicEffects ??= new CinematicEffects();
      // The HDR atmosphere pass owns distance haze, including adaptive fallback.
      // Stacking material fog on top bleaches the kilometre-scale opposite ring.
      // Keep the fog object/program intact and restore it for non-HDR rendering.
      const fog = this.scene.fog instanceof THREE.FogExp2 ? this.scene.fog : null;
      const density = fog?.density ?? 0;
      try {
        if (fog) fog.density = 0;
        this.cinematicEffects.render(this.renderer, this.scene, this.camera,
          this.bentLightDirection, this.bentSurfaceUp, this.adaptiveEffectsQuality === 'full');
      } finally {
        if (fog) fog.density = density;
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  render(protectedEntities: any[] = []) {
    this.updateAdaptiveResolution();
    if (!this.world) {
      this.renderWorld();
      this.renderEntityPreviewIfDue();
      return;
    }

    // Dynamic entities and editor helpers can introduce materials at runtime.
    // Scan every 16 frames rather than traversing the entire scene graph every frame;
    // WeakSet de-duplication still keeps shader setup one-time per material.
    if (this.materialScanCountdown <= 0) {
      hookSceneMaterials(this.scene);
      this.materialScanCountdown = 15;
    } else {
      this.materialScanCountdown--;
    }

    // Rendering must never mutate the logical FPS camera. Previously the bent
    // quaternion survived into the next frame and was bent again, producing a
    // three-state terrain/sky flicker and incorrect raycasts.
    this.flatCameraPosition.copy(this.camera.position);
    this.flatCameraQuaternion.copy(this.camera.quaternion);
    try {
      applyCameraBend(this.camera);
      cullChunks(this.camera, this.world);
      if (!this.impostorLod) {
        this.impostorLod = new CrossPlaneImpostorLod(this.scene);
        this.impostorLod.setEntitySettings(this.entityImpostorSettings);
      }
      this.impostorSources ??= new VoxelImpostorSources();
      const protectedSet = new Set([...protectedEntities, this.previewTarget]);
      this.impostorLod.beginRender(this.impostorSources.sources(
        this.world, this.contraptionManager?.contraptions || [], this.flatCameraPosition, protectedSet, this.contraptionManager,
        this.retainRemoteEntityImpostor,
      ), this.flatCameraPosition);
      this.updateSkyDome(this.camera.position);
      this.renderWorld();
    } finally {
      this.impostorLod?.endRender();
      this.camera.position.copy(this.flatCameraPosition);
      this.camera.quaternion.copy(this.flatCameraQuaternion);
      this.camera.updateMatrixWorld(true);
    }
    this.renderEntityPreviewIfDue();
  }
}
