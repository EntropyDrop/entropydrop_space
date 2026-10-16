import * as THREE from 'three/webgpu';
import { attribute, mat3, mat4, vec3, vec4, dot } from 'three/tsl';
import { bendPointForView, hookSceneMaterials } from '../torus/TorusWorld.ts';
import { createVoxelEmissiveMaterial, voxelEmissionColor } from '../render/VoxelEmission.ts';
import type { DecorationDefinition } from './Decorations.ts';

// Keep individual transform handles for picking, editor gizmos and camera bounds.
// Large components render those handles through at most two material batches.
const BATCH_THRESHOLD = 8;
/** Explicit instance attributes keep transforms ahead of the torus deformation.
 * The r183 automatic InstancedMesh transform can be emitted after positionNode. */
export class DecorationBatchMesh extends THREE.Mesh<THREE.InstancedBufferGeometry> {
  readonly instanceMatrix: THREE.InstancedInterleavedBuffer;
  readonly tintAttribute: THREE.InstancedBufferAttribute;

  constructor(material: THREE.NodeMaterial, capacity: number) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(box.getIndex());
    for (const name of Object.keys(box.attributes)) geometry.setAttribute(name, box.getAttribute(name));
    super(geometry, material);
    this.instanceMatrix = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 16), 16)
      .setUsage(THREE.DynamicDrawUsage);
    this.tintAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
      .setUsage(THREE.DynamicDrawUsage);
    for (let column = 0; column < 4; column++) {
      geometry.setAttribute(`decorationMatrix${column}`, new THREE.InterleavedBufferAttribute(this.instanceMatrix, 4, column * 4));
    }
    geometry.setAttribute('decorationTint', this.tintAttribute);
    geometry.instanceCount = 0;
  }

  get instanceCount() { return this.geometry.instanceCount; }
  set instanceCount(value: number) { this.geometry.instanceCount = value; }
  setMatrixAt(index: number, matrix: THREE.Matrix4) { matrix.toArray(this.instanceMatrix.array, index * 16); }
  getMatrixAt(index: number, matrix: THREE.Matrix4) { matrix.fromArray(this.instanceMatrix.array, index * 16); }
}

type Batch = { mesh: DecorationBatchMesh; handles: THREE.Mesh[]; colors: THREE.InstancedBufferAttribute };
type GroupState = {
  handles: Map<string, THREE.Mesh>;
  batches: Map<number, Batch>;
  geometry?: THREE.BoxGeometry;
  material?: THREE.MeshBasicNodeMaterial;
};
const groups = new WeakMap<THREE.Group, GroupState>();
const instances = new WeakMap<THREE.Mesh, { batch: Batch; index: number }>();
const tint = new THREE.Color();

function dirtyRange(attribute: THREE.BufferAttribute | THREE.InterleavedBuffer, start: number, count: number) {
  // Bound the pending range even when simulation runs without rendering.
  const range = attribute.updateRanges[0];
  if (range) {
    const end = Math.max(range.start + range.count, start + count);
    range.start = Math.min(range.start, start);
    range.count = end - range.start;
  } else attribute.addUpdateRange(start, count);
  attribute.needsUpdate = true;
}

/** Also used for temporary editor poses, which must not enter simulation history. */
export function syncDecorationMeshTransform(mesh: THREE.Mesh) {
  const instance = instances.get(mesh);
  if (!instance) return;
  mesh.updateMatrix();
  const { batch, index } = instance;
  const offset = index * 16, buffer = batch.mesh.instanceMatrix;
  if (mesh.matrix.elements.every((value, axis) => Math.fround(value) === buffer.array[offset + axis])) return;
  batch.mesh.setMatrixAt(index, mesh.matrix);
  dirtyRange(buffer, offset, 16);
}

function syncInstanceColor(handle: THREE.Mesh) {
  const { batch, index } = instances.get(handle)!;
  const color = handle.userData.decorationColor;
  if (handle.userData.decorationMaterialId === 1) {
    batch.colors.setXYZ(index, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255);
  } else {
    tint.setHex(color);
    batch.colors.setXYZ(index, tint.r, tint.g, tint.b);
  }
  dirtyRange(batch.colors, index * 3, 3);
}

function createBatch(materialId: number, capacity: number): Batch {
  const material = materialId === 1 ? createVoxelEmissiveMaterial()
    : new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const columns = [0, 1, 2, 3].map(column => attribute<'vec4'>(`decorationMatrix${column}`, 'vec4'));
  const matrix = mat4(columns[0], columns[1], columns[2], columns[3]);
  material.positionNode = matrix.mul(vec4(attribute<'vec3'>('position', 'vec3'), 1)).xyz;
  // Inverse-transpose normal transform for rotation plus nonuniform positive scale.
  const normalMatrix = mat3(columns[0].xyz, columns[1].xyz, columns[2].xyz);
  const scaleSq = vec3(dot(columns[0].xyz, columns[0].xyz), dot(columns[1].xyz, columns[1].xyz), dot(columns[2].xyz, columns[2].xyz));
  material.userData.flatNormalNode = normalMatrix.mul(attribute<'vec3'>('normal', 'vec3').div(scaleSq));
  const color = attribute<'vec3'>('decorationTint', 'vec3');
  // Emission takes raw sRGB tint and retains the HDR mask; ordinary tint is linear.
  material.colorNode = materialId === 1 ? voxelEmissionColor(color) : color;
  const mesh = new DecorationBatchMesh(material, capacity);
  const colors = mesh.tintAttribute;
  mesh.name = `DecorationBatch:${materialId}`;
  mesh.castShadow = mesh.receiveShadow = true;
  hookSceneMaterials(mesh);
  return { mesh, handles: [], colors };
}

function disposeMesh(mesh: THREE.Mesh) {
  if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}

function appendInstance(batch: Batch, handle: THREE.Mesh) {
  instances.set(handle, { batch, index: batch.handles.length });
  batch.handles.push(handle);
  batch.mesh.instanceCount = batch.handles.length;
  syncDecorationMeshTransform(handle);
  syncInstanceColor(handle);
}

function addInstance(group: THREE.Group, state: GroupState, handle: THREE.Mesh) {
  const materialId = handle.userData.decorationMaterialId;
  let batch = state.batches.get(materialId);
  if (!batch || batch.handles.length === batch.mesh.instanceMatrix.count) {
    const capacity = batch ? batch.mesh.instanceMatrix.count * 2 : 8;
    const replacement = createBatch(materialId, capacity);
    if (batch) {
      for (const previous of batch.handles) appendInstance(replacement, previous);
      group.remove(batch.mesh);
      disposeMesh(batch.mesh);
    }
    batch = replacement;
    state.batches.set(materialId, batch);
    group.add(batch.mesh);
  }
  appendInstance(batch, handle);
}

function removeInstance(group: THREE.Group, state: GroupState, handle: THREE.Mesh) {
  const { batch, index } = instances.get(handle)!;
  const last = batch.handles.pop()!;
  instances.delete(handle);
  batch.mesh.instanceCount = batch.handles.length;
  if (last !== handle) {
    batch.handles[index] = last;
    instances.set(last, { batch, index });
    syncDecorationMeshTransform(last);
    syncInstanceColor(last);
  }
  if (batch.mesh.instanceCount === 0) {
    state.batches.delete(handle.userData.decorationMaterialId);
    group.remove(batch.mesh);
    disposeMesh(batch.mesh);
  }
}

function enableBatching(group: THREE.Group, state: GroupState) {
  state.geometry = new THREE.BoxGeometry(1, 1, 1);
  state.material = new THREE.MeshBasicNodeMaterial();
  for (const handle of state.handles.values()) {
    disposeMesh(handle);
    handle.geometry = state.geometry;
    handle.material = state.material;
    handle.visible = false;
    addInstance(group, state, handle);
  }
}

type DecorationPose = { position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3 };
const poses = new WeakMap<THREE.Object3D, { previous: DecorationPose; current: DecorationPose }>();
const poseOf = (mesh: THREE.Object3D): DecorationPose => ({
  position: mesh.position.clone(), rotation: mesh.quaternion.clone(), scale: mesh.scale.clone()
});

/** Use the same fixed-step history as the owning body and suspended wheels. */
export function captureDecorationTransforms(group: THREE.Group) {
  for (const mesh of group.children) {
    const state = poses.get(mesh);
    if (!state) continue;
    state.previous.position.copy(state.current.position);
    state.previous.rotation.copy(state.current.rotation);
    state.previous.scale.copy(state.current.scale);
  }
}

export function interpolateDecorationTransforms(group: THREE.Group, amount: number) {
  for (const mesh of group.children) {
    const state = poses.get(mesh);
    if (!state) continue;
    mesh.position.lerpVectors(state.previous.position, state.current.position, amount);
    mesh.quaternion.slerpQuaternions(state.previous.rotation, state.current.rotation, amount);
    mesh.scale.lerpVectors(state.previous.scale, state.current.scale, amount);
    syncDecorationMeshTransform(mesh as THREE.Mesh);
  }
}

export function restoreDecorationTransforms(group: THREE.Group) {
  for (const mesh of group.children) {
    const state = poses.get(mesh);
    if (!state) continue;
    mesh.position.copy(state.current.position);
    mesh.quaternion.copy(state.current.rotation);
    mesh.scale.copy(state.current.scale);
    syncDecorationMeshTransform(mesh as THREE.Mesh);
  }
}

/** Transform/color animation reuses geometry and materials. */
export function updateDecorationMesh(mesh: THREE.Mesh, value: DecorationDefinition, pivot: THREE.Vector3) {
  mesh.position.fromArray(value.position || [0, 0, 0]).sub(pivot);
  mesh.quaternion.fromArray(value.rotation || [0, 0, 0, 1]);
  mesh.scale.fromArray(value.scale || [1, 1, 1]);
  const state = poses.get(mesh);
  if (state) {
    state.current.position.copy(mesh.position);
    state.current.rotation.copy(mesh.quaternion);
    state.current.scale.copy(mesh.scale);
  } else poses.set(mesh, { previous: poseOf(mesh), current: poseOf(mesh) });
  if (mesh.userData.decorationColor !== value.color) {
    mesh.userData.decorationColor = value.color;
    if (instances.has(mesh)) syncInstanceColor(mesh);
    else {
      (mesh.material as THREE.MeshStandardNodeMaterial).color.setHex(value.color);
      const colors = mesh.geometry.getAttribute('color');
      if (value.materialId === 1 && colors) {
        for (let i = 0; i < colors.count; i++) colors.setXYZ(i,
          ((value.color >> 16) & 255) / 255, ((value.color >> 8) & 255) / 255, (value.color & 255) / 255);
        colors.needsUpdate = true;
      }
    }
  }
  syncDecorationMeshTransform(mesh);
}

function createDecorationMesh(value: DecorationDefinition, pivot: THREE.Vector3, state: GroupState) {
  let geometry = state.geometry;
  let material: THREE.Material | undefined = state.material;
  if (!geometry) {
    geometry = new THREE.BoxGeometry(1, 1, 1);
    material = value.materialId === 1
      ? createVoxelEmissiveMaterial()
      : new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    if (value.materialId === 1) {
      // Emission reads an sRGB vertex tint, matching the voxel shader contract.
      const color = [((value.color >> 16) & 255) / 255, ((value.color >> 8) & 255) / 255, (value.color & 255) / 255];
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(
        Array.from({ length: geometry.getAttribute('position').count }, () => color).flat(), 3));
    }
  }
  const mesh = new THREE.Mesh(geometry, material!);
  mesh.name = `Decoration:${value.id}`;
  mesh.userData.decorationId = value.id;
  mesh.userData.decorationMaterialId = value.materialId || 0;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.visible = !state.geometry;
  // A batched handle uses shared, unrendered geometry/material; only its pose is public.
  if (state.geometry) mesh.userData.decorationColor = value.color;
  updateDecorationMesh(mesh, value, pivot);
  if (!state.geometry) hookSceneMaterials(mesh);
  return mesh;
}

/** Incremental topology/material edits keep unrelated instances and animation history. */
export function editDecorationGroup(group: THREE.Group, id: string, value: DecorationDefinition | undefined, pivot: THREE.Vector3) {
  const state = groups.get(group)!;
  let mesh = state.handles.get(id);
  if (mesh && (!value || mesh.userData.decorationMaterialId !== (value.materialId || 0))) {
    if (instances.has(mesh)) {
      removeInstance(group, state, mesh);
      if (value) {
        mesh.userData.decorationMaterialId = value.materialId || 0;
        mesh.userData.decorationColor = value.color;
        updateDecorationMesh(mesh, value, pivot);
        addInstance(group, state, mesh);
        return;
      }
    } else disposeMesh(mesh);
    group.remove(mesh);
    state.handles.delete(id);
    mesh = undefined;
  }
  if (!value) return;
  if (mesh) updateDecorationMesh(mesh, value, pivot);
  else {
    mesh = createDecorationMesh(value, pivot, state);
    state.handles.set(id, mesh);
    group.add(mesh);
    if (state.geometry) addInstance(group, state, mesh);
    else if (state.handles.size >= BATCH_THRESHOLD) enableBatching(group, state);
  }
}

export function createDecorationGroup(values: DecorationDefinition[], pivot: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Decorations';
  const state: GroupState = { handles: new Map(), batches: new Map() };
  groups.set(group, state);
  if (values.length >= BATCH_THRESHOLD) {
    enableBatching(group, state);
    for (const materialId of [0, 1]) {
      const count = values.filter(value => (value.materialId || 0) === materialId).length;
      if (count) state.batches.set(materialId, createBatch(materialId, 2 ** Math.ceil(Math.log2(Math.max(8, count)))));
    }
  }
  for (const value of values) editDecorationGroup(group, value.id, value, pivot);
  for (const batch of state.batches.values()) group.add(batch.mesh);
  return group;
}

/** Intersect exactly the triangles rendered by the bent-world vertex shader. */
export function raycastDecorationGroup(group: THREE.Group, origin: THREE.Vector3, direction: THREE.Vector3,
  maxDistance: number, bent: boolean) {
  group.updateWorldMatrix(true, true);
  const ray = new THREE.Ray(origin.clone(), direction.clone().normalize());
  let closest: any = null;
  for (const object of group.children) {
    const mesh = object as THREE.Mesh;
    if (!mesh.userData.decorationId) continue;
    const positions = mesh.geometry.getAttribute('position');
    const indices = mesh.geometry.getIndex()!;
    const flat = Array.from({ length: positions.count }, (_, index) =>
      new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
    const corners = bent ? flat.map(point => bendPointForView(point.x, point.y, point.z)) : flat;
    for (let index = 0; index < indices.count; index += 3) {
      const a = indices.getX(index), b = indices.getX(index + 1), c = indices.getX(index + 2);
      const point = ray.intersectTriangle(corners[a], corners[b], corners[c], false, new THREE.Vector3());
      if (!point) continue;
      const distance = origin.distanceTo(point);
      if (distance > maxDistance || (closest && distance >= closest.distance)) continue;
      const barycentric = THREE.Triangle.getBarycoord(point, corners[a], corners[b], corners[c], new THREE.Vector3());
      if (!barycentric) continue;
      const worldPoint = flat[a].clone().multiplyScalar(barycentric.x)
        .addScaledVector(flat[b], barycentric.y).addScaledVector(flat[c], barycentric.z);
      closest = {
        decorationId: mesh.userData.decorationId, distance, point: worldPoint,
        worldNormal: THREE.Triangle.getNormal(flat[a], flat[b], flat[c], new THREE.Vector3()),
      };
    }
  }
  return closest;
}
