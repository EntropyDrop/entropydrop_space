/// <reference lib="webworker" />
import { createVoxelLodService, type VoxelLodCommand } from './VoxelLodService.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const service = createVoxelLodService((response, transfer) => scope.postMessage(response, transfer));
scope.onmessage = (event: MessageEvent<VoxelLodCommand>) => service.handle(event.data);
