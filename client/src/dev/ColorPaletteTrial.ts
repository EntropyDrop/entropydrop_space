/** Offline-only color entropy / storage experiment. Production geometry stays intact. */
import * as THREE from 'three/webgpu';
import { storage, vertexIndex, instanceIndex, uint, float, vec2, vec3, varying, min, uniform, wgslFn } from 'three/tsl';
import { makePalette } from './ColorPaletteMath.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { VOXEL_FACE_BLOCK } from '@entropydrop/space-engine/render/VoxelFaceVisibility.ts';

if (import.meta.hot) import.meta.hot.accept();
export const COLOR_MODES = ['original', 'palette256', 'packed256', 'mono'] as const;
export type ColorMode = typeof COLOR_MODES[number];
const unpack = wgslFn('fn trialPaletteColor(value: u32) -> vec3<f32> { return unpack4x8unorm(value).xyz; }');

function compactMesh(arena: any, data: any, map: any, palette: any) {
  if (!arena.blockInstancing || arena.compactMaps) throw new Error('Expected production block instancing and original maps.');
  const records = storage(data, 'uint', data.count).toReadOnly();
  const colors = storage(palette, 'uint', 256).toReadOnly();
  const remap = storage(map, 'vec4', map.count).toReadOnly();
  const base = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaBase ?? 0);
  const runFaces = uniform(uint(0)).onObjectUpdate(({ object }) => object?.userData.voxelArenaFaces ?? 0);
  const faceIndex = vertexIndex.div(uint(4)).add(instanceIndex.mul(uint(arena.instanceFaces)));
  const bounded = uint(min(float(faceIndex), float(runFaces).sub(1))), corner = vertexIndex.mod(uint(4));
  const blockIndex = bounded.div(uint(VOXEL_FACE_BLOCK)).add(base).mul(2), block = remap.element(blockIndex);
  const local = bounded.mod(uint(VOXEL_FACE_BLOCK));
  const valid = local.lessThan(uint(block.y)).and(faceIndex.lessThan(runFaces));
  const face = uint(block.x).add(uint(min(float(local), block.y.sub(1)))).mul(3);
  const x = records.element(face), y = records.element(face.add(1)), z = records.element(face.add(2));
  return arena.make({ origin: vec3(block.z, block.w, remap.element(blockIndex.add(1)).x),
    offset: vec3(float(x.bitAnd(65535)), float(x.shiftRight(16)), float(y.bitAnd(65535))),
    span: vec2(float(y.shiftRight(16)), float(z.bitAnd(65535))),
    direction: float(z.shiftRight(16).bitAnd(7)), emission: float(z.shiftRight(19).bitAnd(1)),
    color: varying(unpack(colors.element(z.shiftRight(20).bitAnd(255)))), valid,
    quad: vec2(float(corner.equal(1).or(corner.equal(2))), float(corner.greaterThanEqual(2))) });
}

export function createColorPaletteTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels, arena = layer.arena;
  if (!game.world.distantSurface.isEnabled() || !arena?.stats.residentFaces || layer.hasPendingWork || layer.hasPendingTransitions)
    throw new Error('Wait for settled original far terrain.');
  const histogram = new Map<number, number>();
  for (const page of arena.pages) for (const entry of page.entries) {
    if (entry.attributes || entry.invalid) throw new Error('Unmigrated face source.');
    for (let i = entry.start; i < entry.start + entry.count; i++) {
      const word = page.data.array[i * 4 + 3] >>> 0;
      histogram.set(word, (histogram.get(word) ?? 0) + 1);
    }
  }
  const palette = makePalette(histogram), paletteAttribute = new THREE.StorageBufferAttribute(palette.words, 1);
  const buffers: any[] = [paletteAttribute], materials: any[] = [], pages: any[] = [];
  const variants = new Map<any, Record<ColorMode, any>>();
  for (const page of arena.pages) {
    const source = page.data.array as Uint32Array, quantized = source.slice(), mono = source.slice();
    const compact = new Uint32Array(source.length / 4 * 3);
    for (let i = 0; i < source.length / 4; i++) {
      const offset = i * 4, index = palette.indices.get(source[offset + 3] >>> 0) ?? 0;
      const direction = source[offset + 2] >>> 16 & 255, emission = source[offset + 2] >>> 24;
      if (direction > 5 || emission > 1) throw new Error('Unsupported direction/emission packing.');
      quantized[offset + 3] = palette.words[index]; mono[offset + 3] = 0xff808080;
      compact[i * 3] = source[offset]; compact[i * 3 + 1] = source[offset + 1];
      compact[i * 3 + 2] = source[offset + 2] & 65535 | direction << 16 | emission << 19 | index << 20;
    }
    const q = new THREE.StorageBufferAttribute(quantized, 4), m = new THREE.StorageBufferAttribute(mono, 4);
    const c = new THREE.StorageBufferAttribute(compact, 1); buffers.push(q, m, c);
    const meshes = { palette256: arena.createDrawingMesh(q, page.map), packed256: compactMesh(arena, c, page.map, paletteAttribute), mono: arena.createDrawingMesh(m, page.map) };
    for (const name of ['opaqueMaterial', 'maskedMaterial']) {
      const original = page.mesh.userData[name];
      const entry: any = { original };
      for (const mode of ['palette256', 'packed256', 'mono'] as const) {
        entry[mode] = meshes[mode].userData[name]; materials.push(entry[mode]);
      }
      variants.set(original, entry);
    }
    for (const mesh of Object.values(meshes) as any[]) mesh.geometry.dispose();
    pages.push({ page, data: page.data, version: page.data.version, map: page.map });
  }
  let mode: ColorMode = 'original', closed = false;
  const allocatedFaces = pages.reduce((sum, entry) => sum + entry.data.count, 0);
  const stats = { materials: materials.length, draws: 0, farTriangles: 0, switches: 0 };
  const metadata = { uniqueColors: palette.unique, paletteColors: palette.count, rmsByteChannel: palette.rmsByteChannel,
    residentFaces: arena.stats.residentFaces, allocatedFaces, originalRecordBytes: allocatedFaces * 16,
    packedRecordBytes: allocatedFaces * 12 + palette.words.byteLength, paletteBytes: palette.words.byteLength };
  const undo = interceptMethod(renderer, 'render', (original, args) => {
    if (args[0] !== scene.scene) return original(...args);
    if (arena.pages.length !== pages.length || pages.some(e => e.page.data !== e.data || e.data.version !== e.version || e.page.map !== e.map))
      throw new Error('Immutable color experiment source changed; rebuild the trial.');
    const restore: [any, any][] = []; stats.draws = stats.farTriangles = 0;
    try {
      for (const mesh of layer.group.children) {
        if (!mesh.visible || !mesh.isMesh) continue;
        const entry = variants.get(mesh.material);
        if (!entry) throw new Error('Non-arena far draw appeared during color experiment.');
        restore.push([mesh, mesh.material]); mesh.material = entry[mode]; stats.draws++;
        stats.farTriangles += Math.min(mesh.geometry.index.count, mesh.geometry.drawRange.count) / 3 * mesh.geometry.instanceCount;
      }
      return original(...args);
    } finally { for (const [mesh, material] of restore) mesh.material = material; }
  });
  return { metadata, stats, get mode() { return mode; },
    set(next: ColorMode) { if (closed || !COLOR_MODES.includes(next)) throw new Error('Invalid color mode.');
      if (next !== mode) layer.group.needsUpdate = true; mode = next; stats.switches++; },
    dispose() { if (closed) return; closed = true; undo(); layer.group.needsUpdate = true;
      for (const material of materials) material.dispose();
      for (const buffer of buffers) renderer._attributes.delete(buffer);
    },
  };
}
export type ColorPaletteTrial = ReturnType<typeof createColorPaletteTrial>;
