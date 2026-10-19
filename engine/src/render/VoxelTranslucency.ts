import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';

/** RGBA8 alpha is an opacity percentage, shared by all 100 glass IDs. */
export const voxelOpacityNode = () => attribute<'vec4'>('color', 'vec4').w.mul(255 / 100);

/** Cheap tinted glass: no transmission render target, refraction, or extra pass. */
export function createVoxelTranslucentMaterial(vertexColors = true, opacity = 1) {
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: false, flatShading: true, roughness: 0.65, metalness: 0.15,
    transparent: true, opacity, depthWrite: false,
    side: THREE.FrontSide, forceSinglePass: true,
  });
  if (vertexColors) {
    // Explicit RGB avoids Three multiplying diffuse alpha by color.a a second time.
    // AttributeNode caches by name: RGB and opacity must share the vec4 type.
    material.colorNode = attribute<'vec4'>('color', 'vec4').xyz;
    material.opacityNode = voxelOpacityNode();
  }
  material.userData.voxelTranslucent = true;
  return material;
}

/** Cached entity proxies own their materials and switch once on AOI exit. */
export function makeVoxelMaterialOpaque(material: THREE.Material) {
  if (!material.userData.voxelTranslucent) return;
  material.transparent = false;
  material.opacity = 1;
  (material as THREE.NodeMaterial).opacityNode = null;
  material.depthWrite = true;
  material.side = THREE.FrontSide;
  material.needsUpdate = true;
}

/** NodeMaterial.copy omits some subclass fields and callbacks in Three r183. */
export function cloneVoxelMaterial(source: THREE.NodeMaterial) {
  const clone = source.clone();
  for (const key of Object.keys(source)) {
    if (['id', 'uuid', 'type', 'version', '_listeners'].includes(key)) continue;
    (clone as any)[key] = (source as any)[key];
  }
  return clone;
}
