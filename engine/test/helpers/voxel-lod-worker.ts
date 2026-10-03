import { Worker } from 'node:worker_threads';
import type { VoxelLodPort, VoxelLodCommand, VoxelLodResponse } from '../../src/render/VoxelLodService.ts';

/** Executes the actual browser worker module with a small Node message bridge. */
export class NodeVoxelLodWorker implements VoxelLodPort {
  onmessage: VoxelLodPort['onmessage'] = null;
  onerror: VoxelLodPort['onerror'] = null;
  readonly worker: Worker;
  constructor() {
    const url = new URL('../../src/render/VoxelLodWorker.ts', import.meta.url).href;
    this.worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
      import(${JSON.stringify(url)}).then(() => {
        parentPort.on('message', data => self.onmessage({ data }));
      });
    `, { eval: true, execArgv: [] });
    this.worker.on('message', (data: VoxelLodResponse) => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message }));
  }
  postMessage(command: VoxelLodCommand, transfer: ArrayBuffer[] = []) { this.worker.postMessage(command, transfer); }
  terminate() { return this.worker.terminate(); }
}
