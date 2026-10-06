import * as THREE from 'three/webgpu';
import { bendPointForView, hookSceneMaterials } from '../torus/TorusWorld.ts';
import { createVoxelEmissiveMaterial } from '../render/VoxelEmission.ts';
import type { DecorationDefinition } from './Decorations.ts';

/** Transform/color animation reuses geometry and materials. */
export function updateDecorationMesh(mesh: THREE.Mesh, value: DecorationDefinition, pivot: THREE.Vector3) {
  mesh.position.fromArray(value.position || [0, 0, 0]).sub(pivot);
  mesh.quaternion.fromArray(value.rotation || [0, 0, 0, 1]);
  mesh.scale.fromArray(value.scale || [1, 1, 1]);
  if (mesh.userData.decorationColor !== value.color) {
    (mesh.material as THREE.MeshStandardNodeMaterial).color.setHex(value.color);
    const colors = mesh.geometry.getAttribute('color');
    if (value.materialId === 1 && colors) {
      for (let i = 0; i < colors.count; i++) colors.setXYZ(i,
        ((value.color >> 16) & 255) / 255, ((value.color >> 8) & 255) / 255, (value.color & 255) / 255);
      colors.needsUpdate = true;
    }
    mesh.userData.decorationColor = value.color;
  }
}

export function createDecorationGroup(values: DecorationDefinition[], pivot: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Decorations';
  for (const value of values) {
    const material = value.materialId === 1
      ? createVoxelEmissiveMaterial()
      : new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    material.color.setHex(value.color);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    if (value.materialId === 1) {
      // Emission reads an sRGB vertex tint, matching the voxel shader contract.
      const color = [((value.color >> 16) & 255) / 255, ((value.color >> 8) & 255) / 255, (value.color & 255) / 255];
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(
        Array.from({ length: geometry.getAttribute('position').count }, () => color).flat(), 3));
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Decoration:${value.id}`;
    mesh.userData.decorationId = value.id;
    mesh.userData.decorationMaterialId = value.materialId || 0;
    updateDecorationMesh(mesh, value, pivot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  hookSceneMaterials(group);
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
