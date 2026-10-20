import { MAX_ENTITY_BOUNDS, MAX_INVENTORY_BLOCKS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import type { InventoryBlockSet } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

export interface TextVoxelOptions { text: string; fontSize: number; color: number; micro: boolean; materialId: number }
export interface TextVoxelResult { slot: InventoryBlockSet; width: number; height: number; cellSize: number }
export const TEXT_MAX_LENGTH = 256;
export const TEXT_FONT_FAMILY = '"FusionPixel", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Convert a glyph alpha mask into an upright, one-cell-thick voxel stencil. */
export function textMaskToVoxels(alpha: ArrayLike<number>, width: number, height: number, options: TextVoxelOptions): TextVoxelResult {
  const cellSize = options.micro ? MICRO_SIZE : 1;
  const materialId = normalizeVoxelMaterialId(options.materialId);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha[y * width + x] < 128) continue;
    if (++count > MAX_INVENTORY_BLOCKS) throw new Error('Text exceeds 65,536 voxels. Reduce its size or length.');
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!count) throw new Error('Enter visible text to create.');
  const worldWidth = (maxX - minX + 1) * cellSize;
  const worldHeight = (maxY - minY + 1) * cellSize;
  if (worldWidth > MAX_ENTITY_BOUNDS || worldHeight > MAX_ENTITY_BOUNDS) throw new Error('Text exceeds 256 m. Reduce its size or length.');
  const blocks: InventoryBlockSet['blocks'] = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (alpha[y * width + x] >= 128) blocks.push({
      dx: (x - minX) * cellSize, dy: (maxY - y) * cellSize, dz: 0,
      size: cellSize, block: BlockTypes.COLOR_BLOCK, color: options.color,
      materialId,
    });
  }
  return { slot: { kind: 'blockset', name: 'Text', blocks, blockCount: blocks.length }, width: worldWidth, height: worldHeight, cellSize };
}

/** Browser text shaping supports CJK, punctuation and multiline input. */
export async function voxelizeText(options: TextVoxelOptions): Promise<TextVoxelResult> {
  if (!options.text.trim()) throw new Error('Enter text to preview.');
  if (Array.from(options.text).length > TEXT_MAX_LENGTH) throw new Error('Text is limited to 256 characters.');
  if (!Number.isInteger(options.fontSize) || options.fontSize < 8 || options.fontSize > 128) throw new Error('Font size must be between 8 and 128 cells.');
  if (typeof document === 'undefined') throw new Error('Text creation requires a browser.');
  await document.fonts?.load(`${options.fontSize}px "FusionPixel"`, options.text);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Text rendering is unavailable.');
  const font = `${options.fontSize}px ${TEXT_FONT_FAMILY}`;
  context.font = font;
  const lines = options.text.replace(/\r\n?/g, '\n').split('\n');
  const lineHeight = Math.ceil(options.fontSize * 1.25);
  const width = Math.max(1, Math.ceil(Math.max(...lines.map(line => context.measureText(line).width))) + 2);
  const height = lineHeight * lines.length + 2;
  const maxCells = MAX_ENTITY_BOUNDS / (options.micro ? MICRO_SIZE : 1);
  if (width > maxCells + 2 || height > maxCells + lineHeight) throw new Error('Text exceeds 256 m. Reduce its size or length.');
  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.textBaseline = 'top';
  context.fillStyle = '#fff';
  lines.forEach((line, index) => context.fillText(line, 1, index * lineHeight + 1));
  const rgba = context.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index++) alpha[index] = rgba[index * 4 + 3];
  return textMaskToVoxels(alpha, width, height, options);
}
