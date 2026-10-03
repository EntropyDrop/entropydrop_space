import * as THREE from 'three/webgpu';
import { attribute, reference, vec3, vec4, output, dot, max, sRGBTransferEOTF } from 'three/tsl';
import { VOXEL_EMISSIVE_SURFACE_LUMINANCE } from '../voxel/VoxelMaterials.ts';

export function voxelEmissionColor(tint: any) {
  const linear = vec3(sRGBTransferEOTF(tint));
  return linear.mul(VOXEL_EMISSIVE_SURFACE_LUMINANCE).div(max(dot(linear, vec3(.2126, .7152, .0722)), .000001));
}

/** HDR alpha > 1 carries emission coverage to the atmosphere and bloom passes. */
export function createVoxelEmissionMaskUniform(material: THREE.Material): { value: number } {
  const mask = { value: 0 }, previous = material.onBeforeRender;
  material.onBeforeRender = (...args) => {
    previous.apply(material, args);
    mask.value = args[0].getRenderTarget()?.texture.userData.voxelEmissionMask === true ? 1 : 0;
  };
  return mask;
}

export function createVoxelEmissiveMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ toneMapped: true, fog: false });
  const mask = createVoxelEmissionMaskUniform(material);
  material.colorNode = voxelEmissionColor(attribute<'vec3'>('color', 'vec3'));
  material.outputNode = vec4(output.rgb, output.a.add(reference('value', 'float', mask)));
  return material;
}
