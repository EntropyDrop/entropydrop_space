import * as THREE from 'three';
import { VOXEL_EMISSIVE_SURFACE_LUMINANCE } from '../voxel/VoxelMaterials.ts';

// Emissive vertex colors retain sRGB precision, including very dark tints.
// Lift the surface into linear emission radiance, then let the scene's tone
// mapping soften the highlights together with bloom. Dark tints must not leave
// an unlit-looking hole inside a bright halo. Black remains non-emitting.
export const VOXEL_EMISSION_GLSL = /* glsl */ `
uniform float uVoxelEmissionMask;
vec3 voxelEmissionColor(vec3 tint) {
  vec3 linear = sRGBTransferEOTF(vec4(tint, 1.0)).rgb;
  float brightness = dot(linear, vec3(0.2126, 0.7152, 0.0722));
  return linear * (${VOXEL_EMISSIVE_SURFACE_LUMINANCE.toFixed(2)} / max(brightness, 0.000001));
}
`;

/** Opt-in HDR targets reserve alpha > 1 for emission coverage. Other renders
 * keep opaque alpha, including previews and quality modes without bloom. */
export function createVoxelEmissionMaskUniform(material: THREE.Material): THREE.IUniform<number> {
  const uniform = { value: 0 };
  const previous = material.onBeforeRender;
  material.onBeforeRender = (...args) => {
    previous.apply(material, args);
    uniform.value = args[0].getRenderTarget()?.texture.userData.voxelEmissionMask === true ? 1 : 0;
  };
  return uniform;
}

export function createVoxelEmissiveMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true, fog: false });
  const mask = createVoxelEmissionMaskUniform(material);
  material.onBeforeCompile = shader => {
    shader.uniforms.uVoxelEmissionMask = mask;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VOXEL_EMISSION_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = voxelEmissionColor(diffuseColor.rgb);`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        gl_FragColor.a += uVoxelEmissionMask;`);
  };
  material.customProgramCacheKey = () => 'voxel-emission-radiance-v3';
  return material;
}
