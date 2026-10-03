import * as THREE from 'three/webgpu';
import { floor, fract, dot, vec2, screenCoordinate, texture, varying, bool } from 'three/tsl';

// Three's helpers still construct classic materials. Convert those once, keeping
// their Color/Texture objects shared so helper.setColor() continues to work.
const converted = new WeakMap<THREE.Material, THREE.NodeMaterial>();
export function asNodeMaterial(material: THREE.Material): THREE.NodeMaterial {
  if ((material as THREE.NodeMaterial).isNodeMaterial) return material as THREE.NodeMaterial;
  const cached = converted.get(material);
  if (cached) return cached;
  const types = {
    MeshBasicMaterial: THREE.MeshBasicNodeMaterial, MeshStandardMaterial: THREE.MeshStandardNodeMaterial,
    MeshPhysicalMaterial: THREE.MeshPhysicalNodeMaterial, LineBasicMaterial: THREE.LineBasicNodeMaterial,
    LineDashedMaterial: THREE.LineDashedNodeMaterial, PointsMaterial: THREE.PointsNodeMaterial,
    SpriteMaterial: THREE.SpriteNodeMaterial,
  };
  const Type = types[material.type];
  if (!Type) throw new Error(`Unsupported world material: ${material.type}`);
  const node = new Type();
  for (const key of Object.keys(material)) if (!['id', 'uuid', 'type', 'version', '_listeners'].includes(key)) node[key] = material[key];
  material.addEventListener('dispose', () => node.dispose());
  converted.set(material, node);
  return node;
}

export const terrainDither = (pixel = screenCoordinate.xy) =>
  fract(fract(dot(floor(pixel), vec2(.06711056, .00583715))).mul(52.9829189));

export function terrainCoverage(mask: THREE.DataTexture, flat: any) {
  const chunk = varying(floor(flat.mod(vec2(16384, 2048)).add(vec2(16384, 2048)).mod(vec2(16384, 2048)).div(16)));
  return texture(mask, chunk.add(.5).div(vec2(1024, 128))).rg;
}

/** Mask nodes compose with lit/emissive color and execute in shadow passes too. */
export function discardWhen(material: THREE.NodeMaterial, rejected: any) {
  const previous = material.maskNode;
  material.maskNode = previous ? bool(previous).and(rejected.not()) : rejected.not();
}

/** Keep source RGB8 and RGB16 data compact on disk/worker; GPU strides are 4-byte aligned. */
export function alignedInstanceAttribute(array: THREE.TypedArray, itemSize: number, normalized = false) {
  if (normalized && array.BYTES_PER_ELEMENT === 1 && itemSize === 3) {
    const signed = array instanceof Int8Array;
    const padded = signed ? new Int8Array(array.length / 3 * 4) : new Uint8Array(array.length / 3 * 4);
    for (let i = 0; i < array.length / 3; i++) {
      padded.set(array.subarray(i * 3, i * 3 + 3), i * 4); padded[i * 4 + 3] = signed ? 0 : 255;
    }
    return new THREE.InstancedBufferAttribute(padded, 4, true);
  }
  // r183 expands non-normalized integer attributes itself. Make the uploaded
  // format explicit so CPU capacity/accounting and updates agree with the GPU.
  if (!normalized && array.BYTES_PER_ELEMENT < 4) array = Float32Array.from(array);
  if (normalized && array.BYTES_PER_ELEMENT * itemSize % 4 !== 0) {
    const signed = array instanceof Int8Array || array instanceof Int16Array;
    const limit = 2 ** (array.BYTES_PER_ELEMENT * 8 - (signed ? 1 : 0)) - 1;
    array = Float32Array.from(array, value => Math.max(-1, value / limit));
    normalized = false;
  }
  return new THREE.InstancedBufferAttribute(array, itemSize, normalized);
}

export function alignedVertexAttribute(array: THREE.TypedArray, itemSize: number, normalized = false) {
  const aligned = alignedInstanceAttribute(array, itemSize, normalized);
  return new THREE.BufferAttribute(aligned.array, aligned.itemSize, aligned.normalized);
}
