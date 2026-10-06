import type { ChunkMeshData } from '../mesher/LowPolyMesher.ts';

export type PackedStandardEdit =
  | [number, number, number, number, number]
  | [number, number, number, number, number, number];

export type GenerateRequest = {
  type: 'generate';
  requestId: number;
  seed: number;
  terrainGeneratorVersion: number;
  cx: number;
  cz: number;
  standardEdits: PackedStandardEdit[];
  blocksBuffer?: ArrayBuffer;
  colorsBuffer?: ArrayBuffer;
  materialsBuffer?: ArrayBuffer;
};

export type RemeshRequest = {
  type: 'remesh';
  requestId: number;
  seed: number;
  terrainGeneratorVersion: number;
  cx: number;
  cz: number;
  dataVersion: number;
  minOccupiedY: number;
  maxOccupiedY: number;
  blocksBuffer: ArrayBuffer;
  colorsBuffer: ArrayBuffer;
  materialsBuffer: ArrayBuffer;
};

export type TerrainWorkerRequest = GenerateRequest | RemeshRequest;

type ResultIdentity = { requestId: number; cx: number; cz: number };

/** Both backends use this protocol; pre-material workers may omit material/detail buffers. */
export type TerrainWorkerSuccess = ResultIdentity & (
  | { ok: true; type: 'generate'; hasUserEdits: boolean; blocks: Uint8Array;
      terrainColors: Uint32Array; terrainMaterials?: Uint8Array;
      terrainDetails?: Uint32Array; mesh: ChunkMeshData; dataVersion?: never }
  | { ok: true; type: 'remesh'; dataVersion: number; mesh: ChunkMeshData;
      hasUserEdits?: never; blocks?: never; terrainColors?: never;
      terrainMaterials?: never; terrainDetails?: never }
);
export type TerrainWorkerResult = TerrainWorkerSuccess | {
  ok: false; type: TerrainWorkerRequest['type']; requestId: number; error: string;
};
