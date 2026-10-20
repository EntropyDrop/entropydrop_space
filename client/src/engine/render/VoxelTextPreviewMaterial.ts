import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { createVoxelEmissiveMaterial, voxelEmissionColor } from '@entropydrop/space-engine/render/VoxelEmission.ts';
import { createVoxelTranslucentMaterial } from '@entropydrop/space-engine/render/VoxelTranslucency.ts';
import { normalizeVoxelMaterialId, VoxelMaterialIds, isTranslucentVoxelMaterial, voxelMaterialOpacity } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

/** Match the authored material while retaining the placement ghost's opacity. */
export function createVoxelTextPreviewMaterial(materialId: number, color: number) {
  const id = normalizeVoxelMaterialId(materialId);
  if (id === VoxelMaterialIds.EMISSIVE) {
    const material = createVoxelEmissiveMaterial();
    // The text mesh stores linear RGB; the shared emission shader expects sRGB.
    material.colorNode = voxelEmissionColor(vec3(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255));
    material.transparent = true;
    material.opacity = 0.38;
    material.depthWrite = false;
    return material;
  }
  if (isTranslucentVoxelMaterial(id)) {
    const material = createVoxelTranslucentMaterial(false, 0.38 * voxelMaterialOpacity(id));
    material.vertexColors = true;
    return material;
  }
  return new THREE.MeshStandardNodeMaterial({
    vertexColors: true, flatShading: true, roughness: 0.65, metalness: 0.15,
    transparent: true, opacity: 0.38, depthTest: true, depthWrite: true,
    side: THREE.FrontSide,
  });
}
