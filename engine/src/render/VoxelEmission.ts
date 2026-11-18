import * as THREE from 'three/webgpu';
import { attribute, uniform, renderGroup, vec3, vec4, output, dot, max, sRGBTransferEOTF } from 'three/tsl';
import { VOXEL_EMISSIVE_SURFACE_LUMINANCE } from '../voxel/VoxelMaterials.ts';

export function voxelEmissionColor(tint: any) {
  const linear = vec3(sRGBTransferEOTF(tint));
  return linear.mul(VOXEL_EMISSIVE_SURFACE_LUMINANCE).div(max(dot(linear, vec3(.2126, .7152, .0722)), .000001));
}

// HDR alpha > 1 carries emission coverage. WebGPURenderer updates TSL nodes
// during draws, while Material.onBeforeRender is specific to WebGLRenderer.
export const voxelEmissionMask = uniform(0).setGroup(renderGroup).onRenderUpdate(({ renderer }) =>
  renderer?.getRenderTarget()?.texture.userData.voxelEmissionMask === true ? 1 : 0);

export function createVoxelEmissiveMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ toneMapped: true, fog: false });
  material.colorNode = voxelEmissionColor(attribute<'vec3'>('color', 'vec3'));
  material.outputNode = vec4(output.rgb, output.a.add(voxelEmissionMask));
  return material;
}
