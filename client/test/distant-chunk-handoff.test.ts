import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { captureDistantChunk } from '@entropydrop/space-engine/render/DistantChunkLayer.ts';
import { setWorldShapeMode } from '@entropydrop/space-engine/torus/TorusWorld.ts';

test('real terrain edits keep air gaps, micro footprints and colors when the near AOI leaves', () => {
  setWorldShapeMode('torus');
  const world = new World(new THREE.Scene(), 20260827);
  world.setRenderDistance(4);
  world.updateChunksAround(8, 8, false);
  world.setBlock(3, 40, 3, 1, false, 0xff0000);
  world.setBlock(3, 41, 3, 1, false, 0xff0000);
  for (let y = 12; y < 24; y++) world.setBlock(3, y, 3, 0, false);
  world.setMicroBlock(24, 200, 24, 0x0000ff);
  const chunk = world.getChunk(0, 0)!;
  const snapshot = captureDistantChunk(chunk, world.microVoxels, Infinity);
  const colorsAt = (x: number, y: number, z: number) => {
    const colors: number[] = [];
    for (let i = 0; i < snapshot.boxes.length / 6; i++) {
      const [bx, by, bz, w, h, d] = snapshot.boxes.subarray(i * 6, i * 6 + 6);
      if (x >= bx && x < bx + w && y >= by && y < by + h && z >= bz && z < bz + d) {
        colors.push(snapshot.colors[i * 3] << 16 | snapshot.colors[i * 3 + 1] << 8 | snapshot.colors[i * 3 + 2]);
      }
    }
    return colors;
  };
  assert.deepEqual(colorsAt(24, 128, 24), []);
  assert.deepEqual(colorsAt(24, 240, 24), []);
  assert.deepEqual(colorsAt(24, 320, 24), [0xff0000]);
  assert.deepEqual(colorsAt(24, 200, 24), [0x0000ff]);
  assert.deepEqual(colorsAt(25, 200, 24), []);
  world.updateChunksAround(300, 8, false);
  assert.equal(world.distantSurface.authoredChunks.has(0, 0), true);
  assert.equal((world.distantSurface.detailMaskTexture.image.data as Uint8Array)[0], 128);
  assert.ok(world.distantSurface.mesh.visible, 'the local proxy works without a server snapshot');
  world.distantSurface.setEnabled(false);
  setWorldShapeMode('earth');
});

test('ACK after near eviction still prevents an older server proxy from replacing local edits', async () => {
  const world = new World(new THREE.Scene(), 20260827) as any;
  world.updateChunksAround(8, 8, false);
  world.setBlock(3, 40, 3, 1, false, 0xff0000);
  world.updateChunksAround(400, 8, false);
  const chunk = world.getChunk(0, 0);
  world.editPersistence = { hasPendingEditsForChunk: () => false, getSyncStatus: () => ({}) };
  world.acknowledgeLocalTerrainBatch([{kind:'set_standard',x:3,y:40,z:3,block:1,color:0xff0000}],
    { chunks: [{chunk_x:0,chunk_z:0,revision:10}] });
  await new Promise(resolve => setTimeout(resolve, 0));
  // Capturing again after ACK must use revision 10 even without a live near mesh.
  world.captureDistantChunk(chunk);
  const local = world.distantSurface.authoredChunks.group.children[0];
  world.distantSurface.authoredChunks.install(captureDistantChunk(chunk, world.microVoxels, 9));
  assert.equal(world.distantSurface.authoredChunks.group.children[0], local);
  world.distantSurface.authoredChunks.acknowledge(0, 0, 8);
  world.distantSurface.authoredChunks.install(captureDistantChunk(chunk, world.microVoxels, 9));
  assert.equal(world.distantSurface.authoredChunks.group.children[0], local);
  world.distantSurface.authoredChunks.install(captureDistantChunk(chunk, world.microVoxels, 10));
  assert.notEqual(world.distantSurface.authoredChunks.group.children[0], local);
  world.distantSurface.setEnabled(false);
});
