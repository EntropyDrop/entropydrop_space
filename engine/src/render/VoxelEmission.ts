import * as THREE from 'three/webgpu';
import { attribute, float, uniform, renderGroup, vec3, vec4, output, dot, max, sRGBTransferEOTF } from 'three/tsl';
import { VOXEL_EMISSIVE_SURFACE_LUMINANCE } from '../voxel/VoxelMaterials.ts';

export function voxelEmissionColor(tint: any, strength: any = float(1)) {
  const linear = vec3(sRGBTransferEOTF(tint));
  return linear
    .mul(VOXEL_EMISSIVE_SURFACE_LUMINANCE)
    .mul(strength)
    .div(max(dot(linear, vec3(.2126, .7152, .0722)), .000001));
}

/** RGBA8 alpha stores glow level 1..100; 50 maps to 1.0 (legacy strength) and 100 maps to 2.0. */
export const voxelEmissionStrengthNode = () => attribute<'vec4'>('color', 'vec4').w.mul(255 / 50);

// HDR alpha > 1 carries emission strength (1 + strength). WebGPURenderer updates TSL nodes
// during draws, while Material.onBeforeRender is specific to WebGLRenderer.
export const voxelEmissionMask = uniform(0).setGroup(renderGroup).onRenderUpdate(({ renderer }) =>
  renderer?.getRenderTarget()?.texture.userData.voxelEmissionMask === true ? 1 : 0);

export function createVoxelEmissiveMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ toneMapped: true, fog: false });
  const color = attribute<'vec4'>('color', 'vec4');
  const strength = color.w.mul(255 / 50);
  material.colorNode = voxelEmissionColor(color.xyz, strength);
  material.outputNode = vec4(output.rgb, output.a.add(voxelEmissionMask.mul(strength)));
  return material;
}
