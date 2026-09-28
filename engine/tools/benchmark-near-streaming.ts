/** node --import ./engine/test/setup.ts engine/tools/benchmark-near-streaming.ts
 * Same Copper cells and 1.25 ms/60 Hz slices, local vs actual worker meshing.
 * Measures CPU/publication latency; excludes GPU rendering and network IO. */
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import type { MicroMeshSnapshot } from '../src/voxel/MicroMeshSnapshot.ts';

class MeshWorker {
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  worker: Worker;
  ready: Promise<void>;
  constructor() {
    const url = new URL('../src/voxel/MicroMeshWorker.ts', import.meta.url).href;
    this.worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
      import(${JSON.stringify(url)}).then(() => {
        parentPort.on('message', data => self.onmessage({ data }));
        parentPort.postMessage({ ready: true });
      });
    `, { eval: true, execArgv: [] });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', data => data.ready ? resolve() : this.onmessage?.({ data }));
      this.worker.on('error', error => { reject(error); this.onerror?.({ message: error.message }); });
    });
  }
  postMessage(request: MicroMeshSnapshot, transfer: ArrayBuffer[]) { this.worker.postMessage(request, transfer); }
  terminate() { return this.worker.terminate(); }
}

const generator = new TerrainGenerator(20260922, 2);
const chunks: Chunk[] = [];
for (let x = 511; x <= 513; x++) for (let z = 63; z <= 65; z++) {
  const chunk = new Chunk(x, z, null);
  generator.generateChunk(chunk);
  chunks.push(chunk);
}
const active = new Set(chunks.map(chunk => `${chunk.cx},${chunk.cz}`));
let expected: string | undefined;
for (const mode of ['local', 'worker'] as const) {
  const layer = new MicroVoxelLayer();
  layer.setMeshFocus(8200, 1032);
  for (const chunk of chunks) {
    layer.setPackedTerrainCells(chunk.cx * 128, chunk.cz * 128, chunk.terrainDetails,
      (mx, my, mz) => chunk.blocks[Chunk.getIndex(mx >> 3, my >> 3, mz >> 3)] === 0);
  }
  const worker = mode === 'worker' ? new MeshWorker() : null;
  if (worker) { await worker.ready; (layer as any).attachMeshWorker(worker); }
  try {
    const started = performance.now(), times: number[] = [];
    while (layer.hasPendingMeshWork(active)) {
      assert.ok(times.length < 1000, 'meshing must make progress');
      const frame = performance.now();
      layer.updateMesh(64, active, null, 1.25);
      times.push(performance.now() - frame);
      layer.takeRecentlyRebuiltMeshes();
      if (layer.hasPendingMeshWork(active)) await delay(Math.max(0, 1000 / 60 - (performance.now() - frame)));
    }
    const elapsedMs = performance.now() - started;
    const hash = createHash('sha256');
    for (const [key, mesh] of [...layer.meshChunks].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(key);
      for (const attribute of ['position', 'normal', 'color']) {
        const a = mesh.geometry.getAttribute(attribute).array;
        hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      }
      const a = mesh.geometry.index!.array;
      hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      hash.update(JSON.stringify(mesh.geometry.groups));
    }
    const digest = hash.digest('hex');
    expected ??= digest;
    assert.equal(digest, expected, 'off-thread output must exactly match the local mesher');
    const ordered = [...times].sort((a, b) => a - b);
    console.log(JSON.stringify({ mode, chunks: chunks.length, cells: layer.cells.size,
      partitions: layer.meshChunks.size, frames: times.length,
      elapsedMs: +elapsedMs.toFixed(2), mainThreadMs: +times.reduce((a,b) => a+b,0).toFixed(2),
      mainThreadP95Ms: +ordered[Math.floor(ordered.length * .95)].toFixed(2), digest }));
  } finally { if (worker) await worker.terminate(); }
}
