import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Universal 3D Model to Block Set Voxelizer.
 *
 * Supports:
 * - GLTF / GLB full-color models with vertex colors, material colors, and texture maps.
 * - FBX meshes with transforms, vertex colors, material colors, and embedded textures.
 * - STL files (binary & ASCII), including VisCAM/SolidView embedded 15-bit colors.
 * - Quantization into standard blocks (1×1×1) or micro voxels (8×8×8 / 0.125).
 * - Automatic hollow optimization to preserve surface shells and save resource budget.
 */

export interface VoxelTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  normal?: [number, number, number];
  /** Flat 24-bit RGB color (0xRRGGBB) or material base color */
  color?: number | null;
  /** Per-vertex RGB colors in 0..255 integer format */
  vertexColors?: [[number, number, number], [number, number, number], [number, number, number]] | null;
  /** Per-vertex UV coordinates [[u0, v0], [u1, v1], [u2, v2]] */
  uvs?: [[number, number], [number, number], [number, number]] | null;
  /** Whether texture Y should be flipped */
  flipY?: boolean;
  /** Texture sampler with RGBA image buffer */
  texture?: {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
    /** Pixel stride: gray, gray-alpha, RGB, or RGBA. Defaults from byte length. */
    channels?: 1 | 2 | 3 | 4;
  } | null;
}

export interface ModelImportResource {
  /** Original relative path or filename referenced by the glTF JSON. */
  name: string;
  buffer: ArrayBuffer;
  mimeType?: string;
}

export type STLTriangle = VoxelTriangle;

export interface ModelVoxelResult {
  /** Block-set entries normalized to a zero minimum corner. */
  blocks: { dx: number; dy: number; dz: number; size: number; block: number; color: number }[];
  /** Grid dimensions in voxels, including padding. */
  size: { sx: number; sy: number; sz: number };
  /** Grid world bounds, including one cell of padding. */
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

export type STLVoxelResult = ModelVoxelResult;

export const MAX_MODEL_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_STL_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_MODEL_TRIANGLES = 3000000;
export const MAX_STL_TRIANGLES = 3000000;
export const MAX_MODEL_RESOURCE_FILES = 64;
export const MAX_MODEL_RESOURCE_BYTES = 128 * 1024 * 1024;
export const MODEL_TEXTURE_ERROR_CODE = 'MODEL_TEXTURE_UNAVAILABLE';
export const DEFAULT_MODEL_IMPORT_SIZE_BLOCKS = 12;

export function isSupportedModelFilename(filename: string): boolean {
  return /\.(?:fbx|glb|gltf|stl)$/i.test(String(filename || '').trim());
}

const MAX_GRID_CELLS = 16 * 1024 * 1024; // 256^3 limit.
const MAX_OUTPUT_BLOCKS = 200000;
const INWARD_OFFSET_RATIO = 1e-3;

// ---------------------------------------------------------------------------
// Texture and Color Helpers
// ---------------------------------------------------------------------------

function wrapCoord(coord: number, size: number): number {
  if (coord >= 0 && coord <= 1) {
    return Math.min(size - 1, Math.max(0, Math.floor(coord * size)));
  }
  const wrapped = ((coord % 1) + 1) % 1;
  return Math.min(size - 1, Math.max(0, Math.floor(wrapped * size)));
}

type TexturePixels = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
};

function directTexturePixels(candidate: any): TexturePixels | null {
  const width = Number(candidate?.width);
  const height = Number(candidate?.height);
  const data = candidate?.data;
  if (!(width > 0) || !(height > 0)
    || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
  const pixelCount = width * height;
  const channels = data.length / pixelCount;
  if (![1, 2, 3, 4].includes(channels) || !Number.isInteger(channels)) return null;
  return { data, width, height, channels: channels as 1 | 2 | 3 | 4 };
}

function extractTextureData(texture: THREE.Texture | null | undefined): TexturePixels | null {
  if (!texture) return null;
  const img: any = texture.image || (texture.source && (texture.source as any).data);

  // DataTexture and loader extensions may expose RGB rather than RGBA data.
  // Treating byte 4 as alpha made every RGB texel look transparent and caused
  // the importer to silently fall back to a white material.
  for (const candidate of [img, img?.image, (texture as any).mipmaps?.[0]]) {
    const pixels = directTexturePixels(candidate);
    if (pixels) return pixels;
  }
  if (!img) return null;

  const w = img.naturalWidth || img.videoWidth || img.width;
  const h = img.naturalHeight || img.videoHeight || img.height;
  if (!w || !h) return null;

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        return { data: imgData.data, width: w, height: h, channels: 4 };
      }
    } catch (e) {
      console.warn('[ModelVoxelizer] OffscreenCanvas texture extraction failed:', e);
    }
  }

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        return { data: imgData.data, width: w, height: h, channels: 4 };
      }
    } catch (e) {
      console.warn('[ModelVoxelizer] Canvas texture extraction failed:', e);
    }
  }

  return null;
}

export function sampleTriangleColor(
  t: VoxelTriangle,
  u: number,
  v: number,
  w: number,
  defaultColor = 0xf2a93b
): number {
  // 1. Sample texture if present
  if (t.texture && t.uvs && t.texture.width > 0 && t.texture.height > 0) {
    const rawU = u * t.uvs[0][0] + v * t.uvs[1][0] + w * t.uvs[2][0];
    const rawV = u * t.uvs[0][1] + v * t.uvs[1][1] + w * t.uvs[2][1];
    const tx = wrapCoord(rawU, t.texture.width);
    const vCoord = t.flipY === false ? rawV : (1.0 - rawV);
    const ty = wrapCoord(vCoord, t.texture.height);
    const pixelCount = t.texture.width * t.texture.height;
    const inferredChannels = t.texture.data.length / pixelCount;
    const channels = t.texture.channels || (
      Number.isInteger(inferredChannels) && inferredChannels >= 1 && inferredChannels <= 4
        ? inferredChannels as 1 | 2 | 3 | 4
        : 4
    );
    const pIdx = (ty * t.texture.width + tx) * channels;
    const alpha = channels === 2
      ? t.texture.data[pIdx + 1]
      : channels === 4
        ? t.texture.data[pIdx + 3]
        : 255;
    if (alpha > 10) {
      let r = t.texture.data[pIdx];
      let g = channels <= 2 ? r : t.texture.data[pIdx + 1];
      let b = channels <= 2 ? r : t.texture.data[pIdx + 2];
      if (t.color != null && t.color !== 0xffffff && t.color !== 0x000000) {
        const tr = (t.color >> 16) & 0xff;
        const tg = (t.color >> 8) & 0xff;
        const tb = t.color & 0xff;
        r = Math.round((r * tr) / 255);
        g = Math.round((g * tg) / 255);
        b = Math.round((b * tb) / 255);
      }
      return (r << 16) | (g << 8) | b;
    }
  }

  // 2. Vertex colors interpolation
  if (t.vertexColors) {
    const c0 = t.vertexColors[0];
    const c1 = t.vertexColors[1];
    const c2 = t.vertexColors[2];
    let r = Math.round(u * c0[0] + v * c1[0] + w * c2[0]);
    let g = Math.round(u * c0[1] + v * c1[1] + w * c2[1]);
    let b = Math.round(u * c0[2] + v * c1[2] + w * c2[2]);
    r = Math.min(255, Math.max(0, r));
    g = Math.min(255, Math.max(0, g));
    b = Math.min(255, Math.max(0, b));
    if (t.color != null && t.color !== 0xffffff && t.color !== 0x000000) {
      const tr = (t.color >> 16) & 0xff;
      const tg = (t.color >> 8) & 0xff;
      const tb = t.color & 0xff;
      r = Math.round((r * tr) / 255);
      g = Math.round((g * tg) / 255);
      b = Math.round((b * tb) / 255);
    }
    return (r << 16) | (g << 8) | b;
  }

  // 3. Triangle flat / material color
  if (t.color != null) {
    return t.color;
  }

  // 4. Default fallback
  return defaultColor;
}

// ---------------------------------------------------------------------------
// GLTF / GLB Parsing
// ---------------------------------------------------------------------------

function modelTextureError(message: string) {
  const error: Error & { code?: string } = new Error(message);
  error.code = MODEL_TEXTURE_ERROR_CODE;
  return error;
}

function readGLTFJson(buffer: ArrayBuffer): any | null {
  try {
    if (isGlbBuffer(buffer)) {
      const view = new DataView(buffer);
      if (buffer.byteLength < 20 || view.getUint32(16, true) !== 0x4e4f534a) return null;
      const length = view.getUint32(12, true);
      if (length <= 0 || 20 + length > buffer.byteLength) return null;
      const text = new TextDecoder().decode(new Uint8Array(buffer, 20, length)).replace(/\0+$/g, '').trim();
      return JSON.parse(text);
    }
    const text = new TextDecoder().decode(new Uint8Array(buffer)).replace(/^\uFEFF/, '').trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const LEGACY_SPEC_GLOSS_EXTENSION = 'KHR_materials_pbrSpecularGlossiness';

/**
 * Three.js no longer translates the legacy specular-glossiness material
 * extension used by older Sketchfab exports. Preserve its visible diffuse
 * color and texture by converting that subset to core glTF metallic-roughness
 * fields before GLTFLoader sees the document.
 */
function convertLegacySpecGlossMaterials(json: any): boolean {
  let converted = false;
  for (const material of json?.materials || []) {
    const legacy = material?.extensions?.[LEGACY_SPEC_GLOSS_EXTENSION];
    if (!legacy) continue;

    const pbr = { ...(material.pbrMetallicRoughness || {}) };
    if (pbr.baseColorFactor === undefined && Array.isArray(legacy.diffuseFactor)) {
      pbr.baseColorFactor = legacy.diffuseFactor.slice(0, 4);
    }
    if (pbr.baseColorTexture === undefined && legacy.diffuseTexture) {
      pbr.baseColorTexture = { ...legacy.diffuseTexture };
    }
    if (pbr.metallicFactor === undefined) pbr.metallicFactor = 0;
    if (pbr.roughnessFactor === undefined && Number.isFinite(Number(legacy.glossinessFactor))) {
      pbr.roughnessFactor = 1 - Math.min(1, Math.max(0, Number(legacy.glossinessFactor)));
    }
    material.pbrMetallicRoughness = pbr;

    delete material.extensions[LEGACY_SPEC_GLOSS_EXTENSION];
    if (Object.keys(material.extensions).length === 0) delete material.extensions;
    converted = true;
  }
  if (!converted) return false;

  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (!Array.isArray(json[key])) continue;
    json[key] = json[key].filter((name: unknown) => name !== LEGACY_SPEC_GLOSS_EXTENSION);
    if (json[key].length === 0) delete json[key];
  }
  return true;
}

function rewriteGLTFJsonBuffer(buffer: ArrayBuffer, json: any): ArrayBuffer {
  const encodedJson = new TextEncoder().encode(JSON.stringify(json));
  const paddedJsonLength = Math.ceil(encodedJson.byteLength / 4) * 4;

  if (!isGlbBuffer(buffer)) {
    return encodedJson.buffer.slice(
      encodedJson.byteOffset,
      encodedJson.byteOffset + encodedJson.byteLength
    ) as ArrayBuffer;
  }

  const source = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const declaredLength = view.getUint32(8, true);
  const oldJsonLength = view.getUint32(12, true);
  const oldJsonType = view.getUint32(16, true);
  const remainingOffset = 20 + oldJsonLength;
  if (oldJsonType !== 0x4e4f534a
    || declaredLength > buffer.byteLength
    || remainingOffset > declaredLength) {
    throw new Error('GLB has an invalid JSON chunk');
  }

  const remainingLength = declaredLength - remainingOffset;
  const outputLength = 12 + 8 + paddedJsonLength + remainingLength;
  const output = new Uint8Array(outputLength);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, 0x46546c67, true);
  outputView.setUint32(4, view.getUint32(4, true), true);
  outputView.setUint32(8, outputLength, true);
  outputView.setUint32(12, paddedJsonLength, true);
  outputView.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + paddedJsonLength);
  output.set(encodedJson, 20);
  output.set(source.subarray(remainingOffset, declaredLength), 20 + paddedJsonLength);
  return output.buffer;
}

function prepareGLTFForLoader(buffer: ArrayBuffer) {
  const json = readGLTFJson(buffer);
  if (!json || !convertLegacySpecGlossMaterials(json)) return { buffer, json };
  return { buffer: rewriteGLTFJsonBuffer(buffer, json), json };
}

function usedColorTextureMaterialIndices(json: any): Set<number> {
  const textured = new Set<number>();
  for (let index = 0; index < (json?.materials || []).length; index++) {
    const material = json.materials[index];
    if (material?.pbrMetallicRoughness?.baseColorTexture
      || material?.emissiveTexture
      || material?.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture) {
      textured.add(index);
    }
  }
  if (textured.size === 0) return textured;

  const used = new Set<number>();
  const visitedNodes = new Set<number>();
  const visitNode = (nodeIndex: number) => {
    if (visitedNodes.has(nodeIndex)) return;
    visitedNodes.add(nodeIndex);
    const node = json?.nodes?.[nodeIndex];
    if (!node) return;
    if (Number.isInteger(node.mesh)) {
      for (const primitive of json?.meshes?.[node.mesh]?.primitives || []) {
        if (Number.isInteger(primitive.material) && textured.has(primitive.material)) {
          used.add(primitive.material);
        }
      }
    }
    for (const child of node.children || []) visitNode(child);
  };
  const scene = json?.scenes?.[Number.isInteger(json?.scene) ? json.scene : 0];
  for (const nodeIndex of scene?.nodes || []) visitNode(nodeIndex);
  return used;
}

function assertGLTFColorTexturesLoaded(gltf: any, json: any) {
  const missing = usedColorTextureMaterialIndices(json);
  if (missing.size === 0) return;
  let sawAssociatedMaterial = false;
  gltf.scene?.traverse?.(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const association = gltf.parser?.associations?.get?.(material);
      const materialIndex = association?.materials;
      if (!Number.isInteger(materialIndex) || !missing.has(materialIndex)) continue;
      sawAssociatedMaterial = true;
      if ((material as any)?.map || (material as any)?.emissiveMap) missing.delete(materialIndex);
    }
  });
  // GLTFLoader normally retains material associations. If a future loader
  // omits them, only fail when no color texture survived anywhere in the scene.
  if (!sawAssociatedMaterial) {
    let anyColorMap = false;
    gltf.scene?.traverse?.(child => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      anyColorMap ||= materials.some(material => !!((material as any)?.map || (material as any)?.emissiveMap));
    });
    if (anyColorMap) return;
  }
  if (missing.size > 0) {
    throw modelTextureError(
      'Could not load the glTF base-color texture. For .gltf files, select the referenced .bin and image files together with the model.'
    );
  }
}

function normalizeResourceName(value: string) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the original URL */ }
  const raw = decoded.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function modelBasePath(filename: string): string {
  const normalized = normalizeResourceName(filename);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? `${normalized.slice(0, slash + 1)}` : '';
}

function resourceMimeType(resource: ModelImportResource) {
  if (resource.mimeType) return resource.mimeType;
  const name = resource.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.avif')) return 'image/avif';
  if (name.endsWith('.bmp')) return 'image/bmp';
  return 'application/octet-stream';
}

function createGLTFResourceManager(resources: ModelImportResource[]) {
  if (resources.length > MAX_MODEL_RESOURCE_FILES) {
    throw new Error(`Too many model resource files (maximum ${MAX_MODEL_RESOURCE_FILES})`);
  }
  const totalBytes = resources.reduce((total, resource) => total + (resource?.buffer?.byteLength || 0), 0);
  if (totalBytes > MAX_MODEL_RESOURCE_BYTES) {
    throw new Error(`Model resources exceed the ${MAX_MODEL_RESOURCE_BYTES / (1024 * 1024)} MiB import limit`);
  }

  const exact = new Map<string, ModelImportResource>();
  const basename = new Map<string, ModelImportResource>();
  for (const resource of resources) {
    if (!resource?.name || !(resource.buffer instanceof ArrayBuffer)) continue;
    const name = normalizeResourceName(resource.name);
    exact.set(name, resource);
    const leaf = name.split('/').pop() || name;
    if (!basename.has(leaf)) basename.set(leaf, resource);
  }
  const objectUrls = new Map<ModelImportResource, string>();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (/^(?:data:|blob:)/i.test(url)) return url;
    const normalized = normalizeResourceName(url);
    const leaf = normalized.split('/').pop() || normalized;
    const resource = exact.get(normalized) || basename.get(leaf);
    if (!resource) return url;
    let objectUrl = objectUrls.get(resource);
    if (!objectUrl) {
      objectUrl = URL.createObjectURL(new Blob([resource.buffer], { type: resourceMimeType(resource) }));
      objectUrls.set(resource, objectUrl);
    }
    return objectUrl;
  });
  return {
    manager,
    dispose() {
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    }
  };
}

export function extractTrianglesFromObject3D(
  root: THREE.Object3D,
  options: { requireTexturePixels?: boolean } = {}
): VoxelTriangle[] {
  root.updateMatrixWorld(true);

  const textureCache = new Map<any, TexturePixels | null>();
  const triangles: VoxelTriangle[] = [];

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const normA = new THREE.Vector3();
  const transformedUv = new THREE.Vector2();

  root.traverse(child => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    const geom = child.geometry;
    const posAttr = geom.getAttribute('position');
    if (!posAttr || posAttr.count < 3) return;

    const normalAttr = geom.getAttribute('normal');
    const colorAttr = geom.getAttribute('color');
    const indexAttr = geom.getIndex();

    const worldMatrix = child.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);

    const getMaterialForTriangle = (triIndex: number): THREE.Material | null => {
      if (Array.isArray(child.material)) {
        if (geom.groups && geom.groups.length > 0) {
          const vertIndex = triIndex * 3;
          for (const group of geom.groups) {
            if (vertIndex >= group.start && vertIndex < group.start + group.count) {
              return child.material[group.materialIndex ?? 0] || child.material[0];
            }
          }
        }
        return child.material[0] || null;
      }
      return child.material || null;
    };

    const count = indexAttr ? indexAttr.count : posAttr.count;
    const triCount = Math.floor(count / 3);

    for (let t = 0; t < triCount; t++) {
      if (triangles.length >= MAX_MODEL_TRIANGLES) {
        throw new Error(`Model has too many triangles (maximum ${MAX_MODEL_TRIANGLES.toLocaleString('en-US')})`);
      }

      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      vA.fromBufferAttribute(posAttr, i0).applyMatrix4(worldMatrix);
      vB.fromBufferAttribute(posAttr, i1).applyMatrix4(worldMatrix);
      vC.fromBufferAttribute(posAttr, i2).applyMatrix4(worldMatrix);

      let triNormal: [number, number, number] | undefined = undefined;
      if (normalAttr) {
        normA.fromBufferAttribute(normalAttr, i0).applyMatrix3(normalMatrix).normalize();
        triNormal = [normA.x, normA.y, normA.z];
      }

      const mat: any = getMaterialForTriangle(t);
      let matColor: number | null = null;
      let textureData: any = null;
      let texMap: THREE.Texture | null = null;
      if (mat) {
        if (mat.color && typeof mat.color.getHex === 'function') {
          matColor = mat.color.getHex();
          if (matColor === 0 && mat.emissive && typeof mat.emissive.getHex === 'function' && mat.emissive.getHex() > 0) {
            matColor = mat.emissive.getHex();
          }
        } else if (mat.emissive && typeof mat.emissive.getHex === 'function') {
          matColor = mat.emissive.getHex();
        }

        texMap = mat.map || mat.emissiveMap || null;
        if (texMap) {
          if (!textureCache.has(texMap)) {
            textureCache.set(texMap, extractTextureData(texMap));
          }
          textureData = textureCache.get(texMap);
          if (!textureData && options.requireTexturePixels) {
            const materialName = mat.name ? ` for material "${mat.name}"` : '';
            throw modelTextureError(
              `Could not read the glTF base-color texture${materialName}; use a browser-supported PNG, JPEG, WebP, or uncompressed RGB/RGBA texture`
            );
          }
        }
      }

      let uvs: [[number, number], [number, number], [number, number]] | null = null;
      const textureChannel = Number.isInteger(texMap?.channel) ? Math.max(0, texMap!.channel) : 0;
      const uvAttr = geom.getAttribute(textureChannel === 0 ? 'uv' : `uv${textureChannel}`)
        || geom.getAttribute('uv')
        || geom.getAttribute('uv1')
        || geom.getAttribute('uv_0')
        || geom.getAttribute('TEXCOORD_0');
      if (uvAttr) {
        if (texMap?.matrixAutoUpdate) texMap.updateMatrix();
        const readUv = (index: number): [number, number] => {
          transformedUv.set(uvAttr.getX(index), uvAttr.getY(index));
          if (texMap?.transformUv) texMap.transformUv(transformedUv);
          return [transformedUv.x, transformedUv.y];
        };
        uvs = [
          readUv(i0),
          readUv(i1),
          readUv(i2)
        ];
      }

      let vertexColors: [[number, number, number], [number, number, number], [number, number, number]] | null = null;
      if (colorAttr) {
        const parseCol = (idx: number): [number, number, number] => {
          const rVal = colorAttr.getX(idx);
          const gVal = colorAttr.getY(idx);
          const bVal = colorAttr.getZ(idx);
          if (rVal > 1.0 || gVal > 1.0 || bVal > 1.0) {
            return [
              Math.min(255, Math.max(0, Math.round(rVal))),
              Math.min(255, Math.max(0, Math.round(gVal))),
              Math.min(255, Math.max(0, Math.round(bVal)))
            ];
          }
          return [
            Math.min(255, Math.max(0, Math.round(rVal * 255))),
            Math.min(255, Math.max(0, Math.round(gVal * 255))),
            Math.min(255, Math.max(0, Math.round(bVal * 255)))
          ];
        };
        vertexColors = [parseCol(i0), parseCol(i1), parseCol(i2)];
      }

      triangles.push({
        a: [vA.x, vA.y, vA.z],
        b: [vB.x, vB.y, vB.z],
        c: [vC.x, vC.y, vC.z],
        normal: triNormal,
        color: matColor,
        vertexColors,
        uvs,
        flipY: Boolean(texMap?.flipY),
        texture: textureData
      });
    }
  });

  if (triangles.length === 0) {
    throw new Error('No mesh triangles found in 3D model');
  }

  return triangles;
}

export async function parseGLTFData(
  buffer: ArrayBuffer,
  resources: ModelImportResource[] = [],
  basePath = ''
): Promise<VoxelTriangle[]> {
  if (typeof globalThis.ProgressEvent === 'undefined') {
    (globalThis as any).ProgressEvent = class ProgressEvent extends Event {};
  }

  const prepared = prepareGLTFForLoader(buffer);
  const json = prepared.json;
  const usedColorTextures = usedColorTextureMaterialIndices(json);
  const resourceManager = createGLTFResourceManager(resources);
  try {
    const loader = new GLTFLoader(resourceManager.manager);
    let gltf: any;
    try {
      gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(
          prepared.buffer,
          basePath,
          res => resolve(res),
          err => reject(err instanceof Error ? err : new Error(String(err)))
        );
      });
    } catch (error) {
      if (usedColorTextures.size > 0) {
        const detail = error instanceof Error ? ` (${error.message})` : '';
        throw modelTextureError(
          `Could not load the glTF base-color texture${detail}. For .gltf files, select the referenced .bin and image files together with the model.`
        );
      }
      throw error;
    }

    const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!scene) throw new Error('GLTF/GLB has no valid scenes');
    assertGLTFColorTexturesLoaded(gltf, json);
    return extractTrianglesFromObject3D(scene, { requireTexturePixels: true });
  } finally {
    resourceManager.dispose();
  }
}

// ---------------------------------------------------------------------------
// FBX Parsing
// ---------------------------------------------------------------------------

export async function parseFBXData(
  buffer: ArrayBuffer,
  resources: ModelImportResource[] = [],
  basePath = ''
): Promise<VoxelTriangle[]> {
  if (!buffer || buffer.byteLength === 0) throw new Error('FBX file is empty');

  const resourceManager = createGLTFResourceManager(resources);
  let resourceLoadStarted = false;
  let resolveResources: (() => void) | null = null;
  let rejectResources: ((error: Error) => void) | null = null;
  const resourcesLoaded = new Promise<void>((resolve, reject) => {
    resolveResources = resolve;
    rejectResources = reject;
  });
  resourceManager.manager.onStart = () => { resourceLoadStarted = true; };
  resourceManager.manager.onLoad = () => resolveResources?.();
  resourceManager.manager.onError = url => {
    rejectResources?.(modelTextureError(
      `Could not load the FBX texture "${normalizeResourceName(url)}"; use an FBX with embedded textures`
    ));
  };

  try {
    const scene = new FBXLoader(resourceManager.manager).parse(buffer, basePath);
    if (resourceLoadStarted) await resourcesLoaded;
    return extractTrianglesFromObject3D(scene, { requireTexturePixels: true });
  } catch (error) {
    if ((error as any)?.code === MODEL_TEXTURE_ERROR_CODE) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/texture|image|document|window|createObjectURL/i.test(message)) {
      throw modelTextureError(`Could not load the FBX texture (${message}); use an FBX with embedded textures`);
    }
    throw error;
  } finally {
    resourceManager.dispose();
  }
}

// ---------------------------------------------------------------------------
// STL Parsing
// ---------------------------------------------------------------------------

function parseAttributeColor(attr: number): number | null {
  if (attr === 0 || (attr & 0x8000) === 0) return null;
  const r = (attr >> 10) & 0x1f;
  const g = (attr >> 5) & 0x1f;
  const b = attr & 0x1f;
  return (((r << 3) | (r >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((b << 3) | (b >> 2));
}

function parseBinarySTL(view: DataView, triCount: number): VoxelTriangle[] {
  if (triCount > MAX_STL_TRIANGLES) {
    throw new Error(`STL has too many triangles (maximum ${MAX_STL_TRIANGLES.toLocaleString('en-US')})`);
  }
  const triangles: VoxelTriangle[] = [];
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    if (off + 50 > view.byteLength) break;
    const normal: [number, number, number] = [
      view.getFloat32(off, true),
      view.getFloat32(off + 4, true),
      view.getFloat32(off + 8, true)
    ];
    const verts: [number, number, number][] = [];
    for (let j = 0; j < 3; j++) {
      const base = off + 12 + j * 12;
      verts.push([
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true)
      ]);
    }
    const color = parseAttributeColor(view.getUint16(off + 48, true));
    triangles.push({ a: verts[0], b: verts[1], c: verts[2], normal, color });
    off += 50;
  }
  return triangles;
}

function parseAsciiSTL(text: string): VoxelTriangle[] {
  const triangles: VoxelTriangle[] = [];
  const chunks = text.split(/\bfacet\b/i).slice(1);
  if (chunks.length > MAX_STL_TRIANGLES) {
    throw new Error(`STL has too many triangles (maximum ${MAX_STL_TRIANGLES.toLocaleString('en-US')})`);
  }
  for (const chunk of chunks) {
    const normalMatch = chunk.match(/\bnormal\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/i);
    const verts = [...chunk.matchAll(/\bvertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/gi)];
    if (verts.length < 3) continue;
    const v = verts.slice(0, 3).map(m => [
      parseFloat(m[1]),
      parseFloat(m[2]),
      parseFloat(m[3])
    ]) as [number, number, number][];
    triangles.push({
      a: v[0],
      b: v[1],
      c: v[2],
      normal: normalMatch
        ? [parseFloat(normalMatch[1]), parseFloat(normalMatch[2]), parseFloat(normalMatch[3])]
        : undefined
    });
  }
  return triangles;
}

export function parseSTLData(buffer: ArrayBuffer): VoxelTriangle[] {
  if (!buffer || buffer.byteLength < 84) throw new Error('STL file is too small (need at least 84 bytes)');
  if (buffer.byteLength > MAX_STL_FILE_BYTES) {
    throw new Error(`STL file exceeds the ${MAX_STL_FILE_BYTES / (1024 * 1024)} MiB import limit`);
  }
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  if (84 + triCount * 50 === buffer.byteLength && triCount > 0) {
    const triangles = parseBinarySTL(view, triCount);
    if (triangles.length > 0) return triangles;
  }
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const triangles = parseAsciiSTL(text);
  if (triangles.length === 0) throw new Error('No triangles found in STL (unsupported or corrupt file)');
  return triangles;
}

// ---------------------------------------------------------------------------
// Universal 3D Format Detector and Parser
// ---------------------------------------------------------------------------

function isGlbBuffer(buffer: ArrayBuffer): boolean {
  if (!buffer || buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  return view.getUint32(0, true) === 0x46546C67; // 'glTF'
}

export async function parse3DModelData(
  buffer: ArrayBuffer,
  filename = '',
  resources: ModelImportResource[] = []
): Promise<VoxelTriangle[]> {
  if (!buffer || buffer.byteLength === 0) throw new Error('Model file is empty');
  if (buffer.byteLength > MAX_MODEL_FILE_BYTES) {
    throw new Error(`Model file exceeds the ${MAX_MODEL_FILE_BYTES / (1024 * 1024)} MiB import limit`);
  }

  const name = (filename || '').toLowerCase();
  if (name.endsWith('.glb')) {
    return parseGLTFData(buffer, resources, modelBasePath(filename));
  }
  if (name.endsWith('.gltf')) {
    return parseGLTFData(buffer, resources, modelBasePath(filename));
  }
  if (name.endsWith('.fbx')) {
    return parseFBXData(buffer, resources, modelBasePath(filename));
  }
  if (name.endsWith('.stl')) {
    return parseSTLData(buffer);
  }
  throw new Error('Unsupported model file extension. Choose an .fbx, .glb, .gltf, or .stl file; .bin files are not supported.');
}

// ---------------------------------------------------------------------------
// Model Size Planning
// ---------------------------------------------------------------------------

export function meshExtent(triangles: VoxelTriangle[]): number {
  if (!triangles || triangles.length === 0) throw new Error('Model has no triangles');
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) throw new Error('Model contains no valid vertices');
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

export interface ModelSizePlan {
  scale: number;
  cellSize: number;
  micro: boolean;
  cells: number;
}

export type STLSizePlan = ModelSizePlan;

export function planModelSize(triangles: VoxelTriangle[], sizeBlocks: number, precision: number): ModelSizePlan {
  const extent = meshExtent(triangles);
  const N = Math.max(1, Math.floor(sizeBlocks) || 1);
  const scale = extent > 0 ? N / extent : 1;
  if (precision > 0 && precision < 0.5) {
    return { micro: true, cells: N * MICRO_DIVISIONS, cellSize: MICRO_SIZE, scale };
  }
  return { micro: false, cells: N, cellSize: 1, scale };
}

export const planSTLSize = planModelSize;

// ---------------------------------------------------------------------------
// Voxelization
// ---------------------------------------------------------------------------

function triangleNormal(t: VoxelTriangle): [number, number, number] | null {
  const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2];
  const vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  return [nx / len, ny / len, nz / len];
}

/**
 * Find the point on a triangle closest to a voxel center. The returned
 * barycentric coordinates use the same a/b/c order as sampleTriangleColor.
 */
function closestTriangleBarycentrics(
  t: VoxelTriangle,
  px: number,
  py: number,
  pz: number,
  out: [number, number, number]
): number {
  const ax = t.a[0], ay = t.a[1], az = t.a[2];
  const bx = t.b[0], by = t.b[1], bz = t.b[2];
  const cx = t.c[0], cy = t.c[1], cz = t.c[2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;

  const writeResult = (u: number, v: number, w: number): number => {
    out[0] = u; out[1] = v; out[2] = w;
    const qx = ax * u + bx * v + cx * w;
    const qy = ay * u + by * v + cy * w;
    const qz = az * u + bz * v + cz * w;
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  };

  if (d1 <= 0 && d2 <= 0) return writeResult(1, 0, 0);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return writeResult(0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return writeResult(1 - v, v, 0);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return writeResult(0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return writeResult(1 - w, 0, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return writeResult(0, 1 - w, w);
  }

  const denominator = va + vb + vc;
  if (Math.abs(denominator) < 1e-20) {
    const da = (px - ax) ** 2 + (py - ay) ** 2 + (pz - az) ** 2;
    const db = (px - bx) ** 2 + (py - by) ** 2 + (pz - bz) ** 2;
    const dc = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
    if (da <= db && da <= dc) return writeResult(1, 0, 0);
    if (db <= dc) return writeResult(0, 1, 0);
    return writeResult(0, 0, 1);
  }
  const invDenominator = 1 / denominator;
  const v = vb * invDenominator;
  const w = vc * invDenominator;
  return writeResult(1 - v - w, v, w);
}

function rayXIntersectsTriangle(t: VoxelTriangle, ox: number, oy: number, oz: number): number {
  const ax = t.a[0] - ox, ay = t.a[1] - oy, az = t.a[2] - oz;
  const bx = t.b[0] - ox, by = t.b[1] - oy, bz = t.b[2] - oz;
  const cx = t.c[0] - ox, cy = t.c[1] - oy, cz = t.c[2] - oz;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const det = e1y * (-e2z) + e1z * e2y;
  if (Math.abs(det) < 1e-12) return 0;
  const invDet = 1 / det;
  const tx = -ax, ty = -ay, tz = -az;
  const u = (ty * (-e2z) + tz * e2y) * invDet;
  if (u < 0 || u > 1) return 0;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = qx * invDet;
  if (v < 0 || u + v > 1) return 0;
  const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return tHit > 1e-9 ? 1 : 0;
}

export function voxelizeModel(
  triangles: VoxelTriangle[],
  blockSize = 1,
  defaultColor = 0xf2a93b,
  opts: { micro?: boolean; scale?: number; hollow?: boolean } = {}
): ModelVoxelResult {
  if (!triangles || triangles.length === 0) throw new Error('Model has no triangles');
  const s = blockSize > 0 ? blockSize : 1;
  const eps = s * INWARD_OFFSET_RATIO;

  let processedTriangles = triangles;
  if (opts.scale && opts.scale !== 1) {
    const k = opts.scale;
    processedTriangles = triangles.map(t => ({
      a: [t.a[0] * k, t.a[1] * k, t.a[2] * k] as [number, number, number],
      b: [t.b[0] * k, t.b[1] * k, t.b[2] * k] as [number, number, number],
      c: [t.c[0] * k, t.c[1] * k, t.c[2] * k] as [number, number, number],
      normal: t.normal,
      color: t.color,
      vertexColors: t.vertexColors,
      uvs: t.uvs,
      flipY: t.flipY,
      texture: t.texture
    }));
  }

  // Bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let firstColor: number | null = null;
  for (const t of processedTriangles) {
    for (const v of [t.a, t.b, t.c]) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] > maxZ) maxZ = v[2];
    }
    if (firstColor === null) {
      if (t.color != null) firstColor = t.color;
      else if (t.vertexColors) {
        const [r, g, b] = t.vertexColors[0];
        firstColor = (r << 16) | (g << 8) | b;
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) throw new Error('Model contains no valid vertices');

  const fallbackColor = firstColor ?? defaultColor;

  // Grid bounds
  const gminX = Math.floor(minX / s) - 1;
  const gminY = Math.floor(minY / s) - 1;
  const gminZ = Math.floor(minZ / s) - 1;
  const gsx = Math.ceil(maxX / s) - gminX + 1;
  const gsy = Math.ceil(maxY / s) - gminY + 1;
  const gsz = Math.ceil(maxZ / s) - gminZ + 1;

  if (gsx * gsy * gsz > MAX_GRID_CELLS) {
    throw new Error(`Voxel grid too large (${gsx}×${gsy}×${gsz}); lower the target size`);
  }

  const grid = new Uint8Array(gsx * gsy * gsz);
  const colorGrid = new Int32Array(gsx * gsy * gsz);
  colorGrid.fill(-1);

  const idx = (x: number, y: number, z: number) => (x * gsy + y) * gsz + z;
  const cellOf = (wx: number, wy: number, wz: number) => [
    Math.floor(wx / s) - gminX,
    Math.floor(wy / s) - gminY,
    Math.floor(wz / s) - gminZ
  ];

  // Preindex triangles in (y,z) buckets for pointInsideMesh
  const bucketSize = Math.max(s * 2, 1e-3);
  const bucket = new Map<string, number[]>();
  const bucketKey = (by: number, bz: number) => `${by},${bz}`;
  for (let ti = 0; ti < processedTriangles.length; ti++) {
    const t = processedTriangles[ti];
    const minBy = Math.floor(Math.min(t.a[1], t.b[1], t.c[1]) / bucketSize);
    const maxBy = Math.floor(Math.max(t.a[1], t.b[1], t.c[1]) / bucketSize);
    const minBz = Math.floor(Math.min(t.a[2], t.b[2], t.c[2]) / bucketSize);
    const maxBz = Math.floor(Math.max(t.a[2], t.b[2], t.c[2]) / bucketSize);
    for (let by = minBy; by <= maxBy; by++) {
      for (let bz = minBz; bz <= maxBz; bz++) {
        const key = bucketKey(by, bz);
        let list = bucket.get(key);
        if (!list) { list = []; bucket.set(key, list); }
        list.push(ti);
      }
    }
  }

  const pointInsideMesh = (px: number, py: number, pz: number): boolean => {
    const list = bucket.get(bucketKey(Math.floor(py / bucketSize), Math.floor(pz / bucketSize))) || [];
    let crossings = 0;
    for (const ti of list) {
      const t = processedTriangles[ti];
      if (Math.max(t.a[0], t.b[0], t.c[0]) <= px) continue;
      crossings += rayXIntersectsTriangle(t, px, py, pz);
    }
    return crossings % 2 === 1;
  };

  // Surface samples alone are intentionally sparse for voxel occupancy speed.
  // Resolve the color of each exposed voxel from the actual nearest triangle
  // afterward, so large textured triangles do not leave most shell cells with
  // the material's usually-white fallback color.
  const visitedTriangles = new Uint32Array(processedTriangles.length);
  const candidateBarycentrics: [number, number, number] = [0, 0, 0];
  let visitStamp = 0;
  const nearestSurfaceColor = (px: number, py: number, pz: number): number | null => {
    visitStamp++;
    if (visitStamp >= 0xffffffff) {
      visitedTriangles.fill(0);
      visitStamp = 1;
    }

    const centerBy = Math.floor(py / bucketSize);
    const centerBz = Math.floor(pz / bucketSize);
    let bestDistanceSq = Infinity;
    let bestTriangle: VoxelTriangle | null = null;
    let bestU = 0, bestV = 0, bestW = 0;

    // A surface voxel center is at most half a cell away from the triangle in
    // Y/Z. Since buckets are 2 cells wide, the surrounding 3x3 buckets cover
    // every triangle capable of touching that voxel.
    for (let by = centerBy - 1; by <= centerBy + 1; by++) {
      for (let bz = centerBz - 1; bz <= centerBz + 1; bz++) {
        const candidates = bucket.get(bucketKey(by, bz));
        if (!candidates) continue;
        for (const ti of candidates) {
          if (visitedTriangles[ti] === visitStamp) continue;
          visitedTriangles[ti] = visitStamp;
          const triangle = processedTriangles[ti];
          const distanceSq = closestTriangleBarycentrics(triangle, px, py, pz, candidateBarycentrics);
          if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestTriangle = triangle;
            bestU = candidateBarycentrics[0];
            bestV = candidateBarycentrics[1];
            bestW = candidateBarycentrics[2];
          }
        }
      }
    }

    return bestTriangle
      ? sampleTriangleColor(bestTriangle, bestU, bestV, bestW, fallbackColor)
      : null;
  };

  // 1) Surface pass: sample surface and assign exact full-color samples
  for (const t of processedTriangles) {
    const edgeAB = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]);
    const edgeBC = Math.hypot(t.c[0] - t.b[0], t.c[1] - t.b[1], t.c[2] - t.b[2]);
    const edgeCA = Math.hypot(t.a[0] - t.c[0], t.a[1] - t.c[1], t.a[2] - t.c[2]);
    const maxEdge = Math.max(edgeAB, edgeBC, edgeCA);
    const n = Math.max(1, Math.min(8, Math.ceil(maxEdge / s) * 2));
    const normal = triangleNormal(t);
    const cx = (t.a[0] + t.b[0] + t.c[0]) / 3;
    const cy = (t.a[1] + t.b[1] + t.c[1]) / 3;
    const cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
    let nx = 0, ny = 0, nz = 0;
    if (normal) {
      const inward = pointInsideMesh(cx - normal[0] * eps, cy - normal[1] * eps, cz - normal[2] * eps);
      const dir = inward ? -1 : 1;
      nx = normal[0] * eps * dir;
      ny = normal[1] * eps * dir;
      nz = normal[2] * eps * dir;
    }
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const k = n - i - j;
        const u = i / n, v = j / n, w = k / n;
        const px = t.a[0] * u + t.b[0] * v + t.c[0] * w;
        const py = t.a[1] * u + t.b[1] * v + t.c[1] * w;
        const pz = t.a[2] * u + t.b[2] * v + t.c[2] * w;

        const gx = cx - px, gy = cy - py, gz = cz - pz;
        const gd = Math.hypot(gx, gy, gz);
        const pull = gd > 0 ? Math.min(1, eps / gd) : 0;
        const fx = px + gx * pull + nx;
        const fy = py + gy * pull + ny;
        const fz = pz + gz * pull + nz;
        const [ccx, ccy, ccz] = cellOf(fx, fy, fz);
        if (ccx >= 0 && ccx < gsx && ccy >= 0 && ccy < gsy && ccz >= 0 && ccz < gsz) {
          const cell = idx(ccx, ccy, ccz);
          grid[cell] = 1;
          const sampled = sampleTriangleColor(t, u, v, w, fallbackColor);
          colorGrid[cell] = sampled;
        }
      }
    }
  }

  // 2) Interior pass: ray parity
  const hash01 = (n: number, salt: number): number => {
    let v = (n * 73856093) ^ (salt * 19349663);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    v = (v ^ (v >>> 16)) >>> 0;
    return 0.1 + 0.8 * (v / 4294967296);
  };
  const jitterScale = s * 1e-3;
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const cell = idx(x, y, z);
        if (grid[cell] === 1) continue;
        const wx = (x + gminX) * s + s * 0.5;
        const wy = (y + gminY) * s + s * 0.5 + hash01(x, 1) * jitterScale;
        const wz = (z + gminZ) * s + s * 0.5 + hash01(z, 2) * jitterScale;
        if (pointInsideMesh(wx, wy, wz)) {
          grid[cell] = 1;
          if (colorGrid[cell] < 0) colorGrid[cell] = fallbackColor;
        }
      }
    }
  }

  // 2.5) Hollow pass: preserve surface shell, eliminate enclosed interior voxels
  const hollow = opts.hollow !== false;
  const hollowGrid = new Uint8Array(gsx * gsy * gsz);
  if (hollow) {
    for (let x = 1; x < gsx - 1; x++) {
      for (let y = 1; y < gsy - 1; y++) {
        for (let z = 1; z < gsz - 1; z++) {
          const cell = idx(x, y, z);
          if (grid[cell] !== 1) continue;
          const isInterior =
            grid[idx(x + 1, y, z)] === 1 &&
            grid[idx(x - 1, y, z)] === 1 &&
            grid[idx(x, y + 1, z)] === 1 &&
            grid[idx(x, y - 1, z)] === 1 &&
            grid[idx(x, y, z + 1)] === 1 &&
            grid[idx(x, y, z - 1)] === 1;
          if (!isInterior) {
            hollowGrid[cell] = 1;
          }
        }
      }
    }
  }
  const effectiveGrid = hollow ? hollowGrid : grid;

  // Re-sample every visible shell voxel at the closest point on the source
  // mesh. This is the important color-preservation pass: the parity fill only
  // determines occupancy and must not decide a textured voxel's color.
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const cell = idx(x, y, z);
        if (effectiveGrid[cell] !== 1) continue;
        const exposed =
          x === 0 || x === gsx - 1 ||
          y === 0 || y === gsy - 1 ||
          z === 0 || z === gsz - 1 ||
          grid[idx(x + 1, y, z)] === 0 ||
          grid[idx(x - 1, y, z)] === 0 ||
          grid[idx(x, y + 1, z)] === 0 ||
          grid[idx(x, y - 1, z)] === 0 ||
          grid[idx(x, y, z + 1)] === 0 ||
          grid[idx(x, y, z - 1)] === 0;
        if (!exposed) continue;

        const wx = (x + gminX) * s + s * 0.5;
        const wy = (y + gminY) * s + s * 0.5;
        const wz = (z + gminZ) * s + s * 0.5;
        const sampled = nearestSurfaceColor(wx, wy, wz);
        if (sampled !== null) colorGrid[cell] = sampled;
      }
    }
  }

  // 3) Collect occupied cells
  let minBx = Infinity, minBy = Infinity, minBz = Infinity;
  const filled: number[][] = [];
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        if (effectiveGrid[idx(x, y, z)] === 1) {
          filled.push([x, y, z]);
          if (x < minBx) minBx = x;
          if (y < minBy) minBy = y;
          if (z < minBz) minBz = z;
        }
      }
    }
  }
  if (filled.length === 0) throw new Error('Voxelization produced no voxels; try a finer quantization size');

  const micro = !!opts.micro;
  let blocks: ModelVoxelResult['blocks'] = [];

  if (micro) {
    // Merge solid 8x8x8 microblock regions that share the same color into 1x1x1 standard blocks
    const merged = new Uint8Array(gsx * gsy * gsz);
    let maxBx = -Infinity, maxBy = -Infinity, maxBz = -Infinity;
    for (const [x, y, z] of filled) {
      if (x > maxBx) maxBx = x;
      if (y > maxBy) maxBy = y;
      if (z > maxBz) maxBz = z;
    }

    for (let x = minBx; x + MICRO_DIVISIONS - 1 <= maxBx; x += MICRO_DIVISIONS) {
      for (let y = minBy; y + MICRO_DIVISIONS - 1 <= maxBy; y += MICRO_DIVISIONS) {
        for (let z = minBz; z + MICRO_DIVISIONS - 1 <= maxBz; z += MICRO_DIVISIONS) {
          let isSolid = true;
          let firstMergedColor: number | null = null;
          let colorUniform = true;

          for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
            for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
              for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
                const cIndex = idx(x + dx, y + dy, z + dz);
                if (effectiveGrid[cIndex] !== 1) {
                  isSolid = false;
                  break;
                }
                const cellCol = colorGrid[cIndex] >= 0 ? colorGrid[cIndex] : fallbackColor;
                if (firstMergedColor === null) firstMergedColor = cellCol;
                else if (firstMergedColor !== cellCol) {
                  colorUniform = false;
                }
              }
              if (!isSolid) break;
            }
            if (!isSolid) break;
          }

          // Only merge if region is fully solid and has uniform color to preserve color details
          if (isSolid && colorUniform && firstMergedColor !== null) {
            for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
              for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
                for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
                  merged[idx(x + dx, y + dy, z + dz)] = 1;
                }
              }
            }

            const bx = x - minBx;
            const by = y - minBy;
            const bz = z - minBz;
            blocks.push({
              dx: Math.round(bx * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
              dy: Math.round(by * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
              dz: Math.round(bz * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
              size: 1,
              block: BlockTypes.COLOR_BLOCK,
              color: firstMergedColor
            });
          }
        }
      }
    }

    // Emit remaining unmerged cells as 0.125 microblocks with exact full-color
    for (const [x, y, z] of filled) {
      if (merged[idx(x, y, z)] === 1) continue;
      const cell = idx(x, y, z);
      const cellCol = colorGrid[cell] >= 0 ? colorGrid[cell] : fallbackColor;
      const bx = x - minBx;
      const by = y - minBy;
      const bz = z - minBz;
      blocks.push({
        dx: Math.round(bx * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dy: Math.round(by * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dz: Math.round(bz * s * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        size: MICRO_SIZE,
        block: BlockTypes.COLOR_BLOCK,
        color: cellCol
      });
    }
  } else {
    blocks = filled.map(([x, y, z]) => {
      const cell = idx(x, y, z);
      const cellCol = colorGrid[cell] >= 0 ? colorGrid[cell] : fallbackColor;
      const bx = x - minBx;
      const by = y - minBy;
      const bz = z - minBz;
      return {
        dx: bx,
        dy: by,
        dz: bz,
        size: 1,
        block: BlockTypes.COLOR_BLOCK,
        color: cellCol
      };
    });
  }

  if (blocks.length > MAX_OUTPUT_BLOCKS) {
    throw new Error(`Too many voxels (${blocks.length}); lower the target size or use standard blocks`);
  }

  return {
    blocks,
    size: { sx: gsx, sy: gsy, sz: gsz },
    bounds: { minX: gminX * s, minY: gminY * s, minZ: gminZ * s, maxX: (gminX + gsx) * s, maxY: (gminY + gsy) * s, maxZ: (gminZ + gsz) * s }
  };
}

export const voxelizeSTL = voxelizeModel;
