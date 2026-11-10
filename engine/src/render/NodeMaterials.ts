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
  const Type = Object.hasOwn(types, material.type) ? types[material.type as keyof typeof types] : undefined;
  if (!Type) throw new Error(`Unsupported world material: ${material.type}`);
  const node = new Type();
  Object.assign(node, Object.fromEntries(Object.entries(material).filter(([key]) => !['id', 'uuid', 'type', 'version', '_listeners'].includes(key))));
  material.addEventListener('dispose', () => node.dispose());
  converted.set(material, node);
  return node;
}

export const terrainDither = (pixel = screenCoordinate.xy) =>
  fract(fract(dot(floor(pixel), vec2(.06711056, .00583715))).mul(52.9829189));

export function terrainCoverage(mask: THREE.DataTexture, flat: ReturnType<typeof vec2>) {
  // Interpolate continuous coordinates. Quantizing at vertices shifts ownership
  // into the adjacent chunk halfway across a face, and wrapping at vertices
  // interpolates through the whole world when a face crosses a periodic seam.
  const chunk = floor(varying(flat).mod(vec2(16384, 2048)).add(vec2(16384, 2048)).mod(vec2(16384, 2048)).div(16));
  return texture(mask, chunk.add(.5).div(vec2(1024, 128))).rg;
}

/** Mask nodes compose with lit/emissive color and execute in shadow passes too. */
export function discardWhen(material: THREE.NodeMaterial, rejected: ReturnType<typeof bool>) {
  const previous = material.maskNode;
  material.maskNode = previous ? bool(previous).and(rejected.not()) : rejected.not();
}

/** Keep source RGB8 and RGB16 data compact on disk/worker; GPU strides are 4-byte aligned. */
export function alignedInstanceAttribute(array: THREE.TypedArray, itemSize: number, normalized = false) {
  // Every published terrain mesh passes through here on the main thread, so
  // the conversions are plain loops and typed-array constructors: a subarray
  // per element or TypedArray.from costs many times more.
  if (normalized && array.BYTES_PER_ELEMENT === 1 && itemSize === 3) {
    const signed = array instanceof Int8Array, count = Math.floor(array.length / 3), fill = signed ? 0 : 255;
    const padded = signed ? new Int8Array(count * 4) : new Uint8Array(count * 4);
    for (let i = 0, from = 0, to = 0; i < count; i++, from += 3, to += 4) {
      padded[to] = array[from]; padded[to + 1] = array[from + 1]; padded[to + 2] = array[from + 2]; padded[to + 3] = fill;
    }
    return new THREE.InstancedBufferAttribute(padded, 4, true);
  }
  // r183 expands non-normalized integer attributes itself. Make the uploaded
  // format explicit so CPU capacity/accounting and updates agree with the GPU.
  if (!normalized && array.BYTES_PER_ELEMENT < 4) array = new Float32Array(array);
  if (normalized && array.BYTES_PER_ELEMENT * itemSize % 4 !== 0) {
    const signed = array instanceof Int8Array || array instanceof Int16Array;
    const limit = 2 ** (array.BYTES_PER_ELEMENT * 8 - (signed ? 1 : 0)) - 1;
    const scaled = new Float32Array(array.length);
    for (let i = 0; i < array.length; i++) scaled[i] = Math.max(-1, array[i] / limit);
    array = scaled;
    normalized = false;
  }
  return new THREE.InstancedBufferAttribute(array, itemSize, normalized);
}

export function alignedVertexAttribute(array: THREE.TypedArray, itemSize: number, normalized = false) {
  const aligned = alignedInstanceAttribute(array, itemSize, normalized);
  return new THREE.BufferAttribute(aligned.array, aligned.itemSize, aligned.normalized);
}
