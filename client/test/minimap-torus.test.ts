import test from 'node:test';
import assert from 'node:assert/strict';
import { Minimap } from '../src/ui/Minimap.ts';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { MicroVoxelLayer, MICRO_DIVISIONS } from '@entropydrop/space-engine/voxel/MicroVoxelLayer.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function createMockElement(tag = 'div'): any {
  const children: any[] = [];
  const el: any = {
    tagName: tag.toUpperCase(),
    style: {},
    clientWidth: 192,
    children,
    childNodes: children,
    appendChild(child: any) { children.push(child); return child; },
    querySelector(sel: string) {
      if (sel === 'canvas') return createMockCanvas();
      return null;
    }
  };
  return el;
}

function createMockCanvas() {
  const el: any = {
    width: 192,
    height: 192,
    style: {},
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fillText: () => {},
      setTransform: () => {},
    })
  };
  return el;
}

function setupMockDOM() {
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return createMockCanvas();
      return createMockElement(tag);
    }
  };
  (globalThis as any).window = {
    devicePixelRatio: 1,
    addEventListener: () => {}
  };
  return {
    cleanup() {
      (globalThis as any).document = undefined;
      (globalThis as any).window = undefined;
    }
  };
}

function makeMockChunk(cx: number, cz: number, blockHeight = 10, color = 0x3c8527) {
  return {
    cx,
    cz,
    getLocalBlock: (lx: number, y: number, lz: number) => (y <= blockHeight ? 1 : 0),
    getLocalColor: (lx: number, y: number, lz: number) => color
  };
}

test('Minimap bounds and caches column scans without changing array-backed samples', () => {
  const dom = setupMockDOM();
  let blockProbes = 0;
  let highestProbedY = -1;
  let rangeReads = 0;
  const topAt = (lx: number, lz: number) => (lx * 3 + lz * 5) % 13;
  const colorAt = (lx: number, lz: number) => 0x110000 | (lx << 8) | lz;
  const referenceChunk = {
    dataVersion: 1,
    getOccupiedYRange: () => ({ min: 0, max: 12 }),
    getLocalBlock: (lx: number, y: number, lz: number) => {
      blockProbes++;
      highestProbedY = Math.max(highestProbedY, y);
      return y <= topAt(lx, lz) ? 1 : 0;
    },
    getLocalColor: (lx: number, _y: number, lz: number) => colorAt(lx, lz),
  };
  referenceChunk.getOccupiedYRange = () => {
    rangeReads++;
    return { min: 0, max: 12 };
  };

  const blocks = new Uint8Array(CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z);
  const colors = new Uint32Array(blocks.length);
  let expectedProbes = 0;
  for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
      const topY = topAt(lx, lz);
      const index = Chunk.getIndex(lx, topY, lz);
      blocks[index] = 1;
      colors[index] = colorAt(lx, lz);
      expectedProbes += 12 - topY + 1;
    }
  }
  const arrayChunk = {
    dataVersion: 1,
    blocks,
    colors,
    getOccupiedYRange: () => ({ min: 0, max: 12 }),
    getLocalBlock: () => { throw new Error('array-backed chunks should use direct storage'); },
    getLocalColor: () => { throw new Error('array-backed chunks should use direct storage'); },
  };
  const makeWorld = (chunk: any) => {
    const chunks = new Map([['0,0', chunk]]);
    return {
      chunks,
      getChunk: (cx: number, cz: number) => chunks.get(`${cx},${cz}`) || null,
      microVoxels: { cells: new Map() },
    };
  };

  const reference = new Minimap(makeWorld(referenceChunk), null);
  const optimized = new Minimap(makeWorld(arrayChunk), null);
  reference.recomputeTerrain(0, 0);
  optimized.recomputeTerrain(0, 0);

  assert.equal(highestProbedY, 12, 'the minimap must not probe known-empty upper layers');
  assert.equal(blockProbes, expectedProbes);
  assert.equal(rangeReads, 1, 'occupied bounds should be read once per chunk version');
  assert.deepEqual(optimized.heights, reference.heights);
  assert.deepEqual(optimized.colors, reference.colors);
  assert.deepEqual(optimized.imageData?.data, reference.imageData?.data);

  reference.recomputeTerrain(1, 0);
  assert.equal(blockProbes, expectedProbes, 'player movement should reuse unchanged chunk surfaces');
  assert.equal(rangeReads, 1);

  referenceChunk.dataVersion++;
  reference.recomputeTerrain(2, 0);
  assert.equal(blockProbes, expectedProbes * 2, 'voxel revisions must invalidate the cached surface');
  assert.equal(rangeReads, 2);
  dom.cleanup();
});

test('Minimap skips standard scans for an empty chunk', () => {
  const dom = setupMockDOM();
  let blockProbes = 0;
  const chunk = {
    getOccupiedYRange: () => null,
    getLocalBlock: () => { blockProbes++; return 0; },
    getLocalColor: () => 0,
  };
  const chunks = new Map([['0,0', chunk]]);
  const minimap = new Minimap({
    chunks,
    getChunk: (cx: number, cz: number) => chunks.get(`${cx},${cz}`) || null,
    microVoxels: { cells: new Map() },
  }, null);

  minimap.recomputeTerrain(0, 0);

  assert.equal(blockProbes, 0);
  dom.cleanup();
});

test('disabled Minimap skips all terrain work', () => {
  const dom = setupMockDOM();
  const minimap = new Minimap({
    get chunks() {
      throw new Error('disabled minimap should not inspect terrain');
    },
  }, null);
  minimap.attachCanvas(createMockCanvas());
  minimap.setEnabled(false);

  assert.equal(minimap.isEnabled(), false);
  assert.doesNotThrow(() => minimap.update({ x: 0, z: 0 }, 0, false, null));
  dom.cleanup();
});

test('Minimap seamlessly renders across toroidal boundary at (1, 1, 1)', () => {
  const dom = setupMockDOM();
  const chunks = new Map<string, any>();
  // Chunk at (0, 0)
  chunks.set('0,0', makeMockChunk(0, 0, 15, 0x112233));
  // Chunk wrapped on negative X side: (1023, 0)
  chunks.set('1023,0', makeMockChunk(1023, 0, 18, 0x445566));
  // Chunk wrapped on negative Z side: (0, 127)
  chunks.set('0,127', makeMockChunk(0, 127, 20, 0x778899));
  // Chunk wrapped on both negative X and Z: (1023, 127)
  chunks.set('1023,127', makeMockChunk(1023, 127, 22, 0xaabbcc));

  const world = {
    chunks,
    getChunk: (cx: number, cz: number) => chunks.get(`${cx},${cz}`) || null,
    terrainVersion: 1,
    microVoxels: { cells: new Map() }
  };

  const minimap = new Minimap(world, null);
  // Recompute at player position (1, 1)
  minimap.recomputeTerrain(1, 1);

  // Center pixel is at index gz = 96, gx = 96 (where player is at 1,1)
  const centerIdx = 96 * Minimap.CELLS + 96;
  assert.equal(minimap.heights[centerIdx], 16); // 15 + 1
  assert.equal(minimap.colors[centerIdx], 0x112233);

  // 3 pixels to the left across the wrapped X boundary (x = 16382)
  // dx = 16382 - 1 = -3, gx = 96 - 3 = 93
  const leftWrappedIdx = 96 * Minimap.CELLS + 93;
  assert.equal(minimap.heights[leftWrappedIdx], 19); // 18 + 1
  assert.equal(minimap.colors[leftWrappedIdx], 0x445566);

  // 3 pixels up across the wrapped Z boundary (z = 2046)
  // dz = 2046 - 1 = -3, gz = 96 - 3 = 93
  const topWrappedIdx = 93 * Minimap.CELLS + 96;
  assert.equal(minimap.heights[topWrappedIdx], 21); // 20 + 1
  assert.equal(minimap.colors[topWrappedIdx], 0x778899);

  dom.cleanup();
});

test('Minimap correctly wraps entity positions near toroidal boundaries', () => {
  const dom = setupMockDOM();
  const world = { chunks: new Map(), getChunk: () => null, terrainVersion: 1 };

  // Contraption at x = 16380 (4 meters to the left of player at x = 0)
  const contraption = {
    position: { x: 16380, y: 20, z: 0 }
  };
  const contraptionManager = {
    contraptions: [contraption]
  };

  const minimap = new Minimap(world, contraptionManager);
  minimap.attachCanvas(createMockCanvas());

  // When player is at (0, 0), the update call should not throw and correctly process entity
  assert.doesNotThrow(() => {
    minimap.update({ x: 0, z: 0 }, 0, false, null);
  });

  dom.cleanup();
});

test('Minimap micro heights use metres and preserve eighth-metre surfaces', () => {
  const dom = setupMockDOM();
  const microVoxels = new MicroVoxelLayer();
  const chunk = makeMockChunk(0, 0, 10, 0x112233);
  const chunks = new Map([['0,0', chunk]]);
  const world = { chunks, microVoxels };
  const minimap = new Minimap(world, null);
  const center = Minimap.RANGE * Minimap.CELLS + Minimap.RANGE;
  const cell = center + Minimap.CELLS + 1;

  microVoxels.set(MICRO_DIVISIONS, 16, MICRO_DIVISIONS, 0xff0000);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[cell], 11);
  assert.equal(minimap.colors[cell], 0x112233, 'underground microcells must not cover standard terrain');

  microVoxels.set(MICRO_DIVISIONS, 88, MICRO_DIVISIONS, 0x00ff00);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[cell], 11.125);
  assert.equal(minimap.colors[cell], 0x00ff00);

  microVoxels.set(MICRO_DIVISIONS, 88, MICRO_DIVISIONS, 0x0000ff);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.colors[cell], 0x0000ff, 'recoloring must invalidate the local micro surface');

  microVoxels.delete(MICRO_DIVISIONS, 88, MICRO_DIVISIONS);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[cell], 11);
  assert.equal(minimap.colors[cell], 0x112233);
  dom.cleanup();
});

test('Minimap wraps indexed microcells and invalidates surfaces after chunk clearing', () => {
  const dom = setupMockDOM();
  const microVoxels = new MicroVoxelLayer();
  const world = { chunks: new Map(), microVoxels };
  const minimap = new Minimap(world, null);
  const wrappedCell = (Minimap.RANGE - 1) * Minimap.CELLS + Minimap.RANGE - 1;

  microVoxels.set(-MICRO_DIVISIONS, 0, -MICRO_DIVISIONS, 0xabcdef);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[wrappedCell], 0.125);
  assert.equal(minimap.colors[wrappedCell], 0xabcdef);

  microVoxels.clearChunk(TORUS_SIZE_X / CHUNK_SIZE_X - 1, TORUS_SIZE_Z / CHUNK_SIZE_Z - 1);
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[wrappedCell], 0);
  assert.equal(minimap.colors[wrappedCell], 0);

  const replacement = new MicroVoxelLayer();
  replacement.set(-MICRO_DIVISIONS, 1, -MICRO_DIVISIONS, 0x123456);
  world.microVoxels = replacement;
  minimap.recomputeTerrain(0, 0);
  assert.equal(minimap.heights[wrappedCell], 0.25);
  assert.equal(minimap.colors[wrappedCell], 0x123456);
  dom.cleanup();
});

test('Minimap repeated local digs never scan far microcells or unchanged visible chunks', () => {
  const dom = setupMockDOM();
  const microVoxels = new MicroVoxelLayer();
  microVoxels.set(0, 80, 0, 0x112233);
  microVoxels.set(8, 80, 8, 0x112233);
  microVoxels.set(CHUNK_SIZE_X * MICRO_DIVISIONS, 80, 0, 0x445566);
  for (let x = 0; x < 32; x++) {
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) microVoxels.set(8000 + x, y, 8000 + z, 0x778899);
    }
  }
  const minimap = new Minimap({ chunks: new Map(), microVoxels }, null);
  const visitedChunks: string[] = [];
  let visitedCells = 0;
  const forEachCellInChunk = microVoxels.forEachCellInChunk.bind(microVoxels);
  microVoxels.forEachCellInChunk = (cx, cz, visit) => {
    visitedChunks.push(`${cx},${cz}`);
    forEachCellInChunk(cx, cz, (mx, my, mz, color) => {
      visitedCells++;
      visit(mx, my, mz, color);
    });
  };
  microVoxels.cells[Symbol.iterator] = () => {
    throw new Error('minimap must never iterate the global microcell map');
  };

  minimap.recomputeTerrain(0, 0);
  assert.equal(visitedCells, 3, 'the 32,768 far microcells are outside the queried region');
  visitedChunks.length = 0;
  visitedCells = 0;

  microVoxels.delete(0, 80, 0);
  minimap.recomputeTerrain(0, 0);
  assert.deepEqual(visitedChunks, ['0,0']);
  assert.equal(visitedCells, 1);
  visitedChunks.length = 0;
  visitedCells = 0;

  microVoxels.delete(8, 80, 8);
  minimap.recomputeTerrain(0, 0);
  assert.deepEqual(visitedChunks, ['0,0']);
  assert.equal(visitedCells, 0);
  visitedChunks.length = 0;

  microVoxels.delete(8000, 0, 8000);
  minimap.recomputeTerrain(1, 0);
  assert.deepEqual(visitedChunks, [], 'far edits and movement within cached chunks require no cell scan');
  dom.cleanup();
});
