import * as THREE from 'three/webgpu';
import { float, output, vec3, vec4 } from 'three/tsl';
import { createVoxelEmissiveMaterial, voxelEmissionColor, voxelEmissionMask } from '@entropydrop/space-engine/render/VoxelEmission.ts';
import { createVoxelTranslucentMaterial } from '@entropydrop/space-engine/render/VoxelTranslucency.ts';
import {
  normalizeVoxelMaterialId,
  isEmissiveVoxelMaterial,
  isTranslucentVoxelMaterial,
  voxelMaterialEmissionStrength,
  voxelMaterialOpacity,
} from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

/** Match the authored material while retaining the placement ghost's opacity. */
export function createVoxelTextPreviewMaterial(materialId: number, color: number) {
  const id = normalizeVoxelMaterialId(materialId);
  if (isEmissiveVoxelMaterial(id)) {
    const material = createVoxelEmissiveMaterial();
    const strength = float(voxelMaterialEmissionStrength(id));
    // The text mesh stores linear RGB; the shared emission shader expects sRGB.
    material.colorNode = voxelEmissionColor(vec3(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255), strength);
    material.outputNode = vec4(output.rgb, output.a.add(voxelEmissionMask.mul(strength)));
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
