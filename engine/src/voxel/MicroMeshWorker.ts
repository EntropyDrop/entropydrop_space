/// <reference lib="webworker" />

import { buildMicroMeshSnapshot, type MicroMeshSnapshot, type MicroMeshResult } from './MicroMeshSnapshot.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<MicroMeshSnapshot>) => {
  const request = event.data;
  try {
    const mesh = buildMicroMeshSnapshot(request);
    const result: MicroMeshResult = { requestId: request.requestId, mesh };
    scope.postMessage(result, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer]);
  } catch (error) {
    const result: MicroMeshResult = { requestId: request.requestId, error: String(error) };
    scope.postMessage(result);
  }
};
