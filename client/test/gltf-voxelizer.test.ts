import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { strToU8, zipSync } from 'fflate';
import {
  parseGLTFData,
  parseFBXData,
  parse3DModelData,
  voxelizeModel,
  planModelSize,
  sampleTriangleColor,
  extractTrianglesFromObject3D,
  MODEL_TEXTURE_ERROR_CODE,
  DEFAULT_MODEL_IMPORT_SIZE_BLOCKS,
  isSupportedModelFilename,
  type VoxelTriangle
} from '../src/engine/voxel/ModelVoxelizer.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { extractModelArchive } from '../src/engine/voxel/ModelImportArchive.ts';

function makeController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.contraptions = overrides.manager || null;
  controller.world = overrides.world || null;
  controller.keys = {};
  const toasts: string[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {}
  };
  Object.assign(controller, overrides);
  controller.inventoryCategory();
  controller.__toasts = toasts;
  return controller;
}

/** Build a valid binary GLB from JSON and binary chunks */
function createGlb(json: any, bin: Buffer): ArrayBuffer {
  const jsonText = JSON.stringify(json);
  const jsonPad = (4 - (jsonText.length % 4)) % 4;
  const jsonBytes = Buffer.from(jsonText + ' '.repeat(jsonPad));

  const binPad = (4 - (bin.length % 4)) % 4;
  const binBytes = binPad > 0 ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

  const totalLength = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const glb = Buffer.alloc(totalLength);
  let offset = 0;

  // Header
  glb.writeUInt32LE(0x46546C67, offset); offset += 4; // 'glTF'
  glb.writeUInt32LE(2, offset); offset += 4; // version 2
  glb.writeUInt32LE(totalLength, offset); offset += 4;

  // Chunk 0: JSON
  glb.writeUInt32LE(jsonBytes.length, offset); offset += 4;
  glb.writeUInt32LE(0x4E4F534A, offset); offset += 4; // 'JSON'
  jsonBytes.copy(glb, offset); offset += jsonBytes.length;

  // Chunk 1: BIN
  glb.writeUInt32LE(binBytes.length, offset); offset += 4;
  glb.writeUInt32LE(0x004E4942, offset); offset += 4; // 'BIN\0'
  binBytes.copy(glb, offset); offset += binBytes.length;

  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function zippedArrayBuffer(entries: Record<string, Uint8Array>): ArrayBuffer {
  const zipped = zipSync(entries);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

function createAsciiTriangleFbx(): ArrayBuffer {
  const source = `; FBX 7.3.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7300
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",2,0
}`;
  return new TextEncoder().encode(source).buffer;
}

function createExternalTexturedGltf() {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    images: [{ uri: 'albedo.png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1 },
        indices: 2,
        material: 0
      }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 6 }
    ],
    buffers: [{ uri: 'mesh.bin', byteLength: 66 }]
  };
  const bin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer),
    Buffer.from(new Uint16Array([0, 1, 2]).buffer)
  ]);
  return {
    jsonBuffer: new TextEncoder().encode(JSON.stringify(json)).buffer,
    binBuffer: toArrayBuffer(bin)
  };
}

function createLegacySpecGlossTexturedGlb() {
  const json = {
    asset: { version: '2.0', generator: 'Sketchfab legacy export' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
    extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{
      name: 'Legacy diffuse material',
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseFactor: [1, 1, 1, 1],
          diffuseTexture: { index: 0 },
          glossinessFactor: 0.8
        }
      }
    }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1 },
        indices: 2,
        material: 0
      }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 6 },
      { buffer: 0, byteOffset: 68, byteLength: 3 }
    ],
    buffers: [{ byteLength: 71 }]
  };
  const bin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer),
    Buffer.from(new Uint16Array([0, 1, 2]).buffer),
    Buffer.alloc(2),
    Buffer.from([1, 2, 3])
  ]);
  return createGlb(json, bin);
}

async function withFakeImageBitmapDecoder<T>(run: () => Promise<T>): Promise<T> {
  const createImageBitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const offscreenCanvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255
  ]);

  class FakeOffscreenCanvas {
    private image: any;
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        drawImage: (image: any) => { this.image = image; },
        getImageData: () => ({ data: this.image.pixels })
      };
    }
  }

  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value: async () => ({ width: 2, height: 2, pixels })
  });
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    writable: true,
    value: FakeOffscreenCanvas
  });
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    writable: true,
    value: globalThis
  });
  try {
    return await run();
  } finally {
    if (createImageBitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', createImageBitmapDescriptor);
    else delete (globalThis as any).createImageBitmap;
    if (offscreenCanvasDescriptor) Object.defineProperty(globalThis, 'OffscreenCanvas', offscreenCanvasDescriptor);
    else delete (globalThis as any).OffscreenCanvas;
    if (selfDescriptor) Object.defineProperty(globalThis, 'self', selfDescriptor);
    else delete (globalThis as any).self;
  }
}

test('sampleTriangleColor correctly prioritizes textures, vertex colors, and material colors', () => {
  // 1. Texture sampler
  const textureData = new Uint8Array([
    255, 0, 0, 255,   // top-left (0, 1 in UV): Red
    0, 255, 0, 255,   // top-right (1, 1 in UV): Green
    0, 0, 255, 255,   // bottom-left (0, 0 in UV): Blue
    255, 255, 0, 255  // bottom-right (1, 0 in UV): Yellow
  ]);
  const triWithTex: VoxelTriangle = {
    a: [0, 0, 0],
    b: [1, 0, 0],
    c: [0, 1, 0],
    uvs: [[0, 1], [1, 1], [0, 0]], // top-left, top-right, bottom-left
    texture: { data: textureData, width: 2, height: 2 }
  };
  // Sample near vertex A (top-left) -> red 0xff0000
  const colorA = sampleTriangleColor(triWithTex, 1, 0, 0);
  assert.equal(colorA, 0xff0000);
  // Sample near vertex B (top-right) -> green 0x00ff00
  const colorB = sampleTriangleColor(triWithTex, 0, 1, 0);
  assert.equal(colorB, 0x00ff00);

  // 2. Vertex colors
  const triWithVertCol: VoxelTriangle = {
    a: [0, 0, 0],
    b: [1, 0, 0],
    c: [0, 1, 0],
    vertexColors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]]
  };
  assert.equal(sampleTriangleColor(triWithVertCol, 1, 0, 0), 0xff0000);
  assert.equal(sampleTriangleColor(triWithVertCol, 0, 1, 0), 0x00ff00);
  assert.equal(sampleTriangleColor(triWithVertCol, 0, 0, 1), 0x0000ff);

  // 3. Flat material color
  const triWithMatCol: VoxelTriangle = {
    a: [0, 0, 0],
    b: [1, 0, 0],
    c: [0, 1, 0],
    color: 0x336699
  };
  assert.equal(sampleTriangleColor(triWithMatCol, 0.33, 0.33, 0.34), 0x336699);

  // 4. Default fallback
  const plainTri: VoxelTriangle = {
    a: [0, 0, 0],
    b: [1, 0, 0],
    c: [0, 1, 0]
  };
  assert.equal(sampleTriangleColor(plainTri, 0.33, 0.33, 0.34, 0x123456), 0x123456);
});

test('extractTrianglesFromObject3D extracts geometry, vertex colors, material colors, and transforms from Three.js scene', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0
  ]);
  const colors = new Float32Array([
    1, 0, 0, // Red
    0, 1, 0, // Green
    0, 0, 1  // Blue
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(10, 5, 0); // Translate
  scene.add(mesh);

  const triangles = extractTrianglesFromObject3D(scene);
  assert.equal(triangles.length, 1);
  assert.deepEqual(triangles[0].a, [10, 5, 0]);
  assert.deepEqual(triangles[0].b, [12, 5, 0]);
  assert.deepEqual(triangles[0].c, [10, 7, 0]);
  assert.deepEqual(triangles[0].vertexColors, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
});

test('extractTrianglesFromObject3D honors the base-color texture UV channel and transform', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ], 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    0, 0,
    0, 0
  ], 2));
  geom.setAttribute('uv1', new THREE.Float32BufferAttribute([
    0, 1,
    1, 1,
    0, 0
  ], 2));

  const texture = new THREE.DataTexture(
    new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255
    ]),
    2,
    2,
    THREE.RGBAFormat
  );
  texture.channel = 1;
  texture.flipY = false;
  texture.offset.set(0.25, 0);
  texture.repeat.set(0.5, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, map: texture });
  scene.add(new THREE.Mesh(geom, material));

  const [triangle] = extractTrianglesFromObject3D(scene);
  assert.ok(triangle.uvs);
  assert.deepEqual(triangle.uvs, [[0.25, 1], [0.75, 1], [0.25, 0]]);

  material.dispose();
  texture.dispose();
  geom.dispose();
});

test('extractTrianglesFromObject3D preserves RGB texture colors without treating byte 4 as alpha', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ], 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 0
  ], 2));
  const texture = new THREE.Texture();
  texture.image = {
    data: new Uint8Array([255, 0, 0, 0, 255, 0]),
    width: 2,
    height: 1
  };
  texture.flipY = false;
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, map: texture });
  scene.add(new THREE.Mesh(geom, material));

  const [triangle] = extractTrianglesFromObject3D(scene);
  assert.equal(triangle.texture?.channels, 3);
  assert.equal(sampleTriangleColor(triangle, 1, 0, 0), 0xff0000);
  assert.equal(sampleTriangleColor(triangle, 0, 1, 0), 0x00ff00);

  material.dispose();
  texture.dispose();
  geom.dispose();
});

test('parseGLTFData loads external .bin and base-color image resources with their colors', async () => {
  const { jsonBuffer, binBuffer } = createExternalTexturedGltf();
  const triangles = await withFakeImageBitmapDecoder(() => parseGLTFData(jsonBuffer, [
    { name: 'mesh.bin', buffer: binBuffer },
    { name: 'albedo.png', buffer: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/png' }
  ]));

  assert.equal(triangles.length, 1);
  assert.ok(triangles[0].texture);
  assert.equal(triangles[0].flipY, false);
  assert.equal(sampleTriangleColor(triangles[0], 1, 0, 0), 0xff0000);
  assert.equal(sampleTriangleColor(triangles[0], 0, 1, 0), 0x00ff00);
  assert.equal(sampleTriangleColor(triangles[0], 0, 0, 1), 0x0000ff);
});

test('parseGLTFData converts legacy Sketchfab specular-glossiness diffuse textures', async () => {
  const triangles = await withFakeImageBitmapDecoder(() => (
    parseGLTFData(createLegacySpecGlossTexturedGlb())
  ));

  assert.equal(triangles.length, 1);
  assert.ok(triangles[0].texture, 'legacy diffuseTexture should become a readable base-color map');
  assert.equal(sampleTriangleColor(triangles[0], 1, 0, 0), 0xff0000);
  assert.equal(sampleTriangleColor(triangles[0], 0, 1, 0), 0x00ff00);
  assert.equal(sampleTriangleColor(triangles[0], 0, 0, 1), 0x0000ff);
});

test('parseGLTFData reports a texture-specific error instead of importing a white model', async () => {
  const { jsonBuffer, binBuffer } = createExternalTexturedGltf();
  await assert.rejects(
    parseGLTFData(jsonBuffer, [{ name: 'mesh.bin', buffer: binBuffer }]),
    (error: any) => error?.code === MODEL_TEXTURE_ERROR_CODE && /base-color texture/i.test(error.message)
  );
});

test('parseGLTFData parses full-color GLB model with vertex colors', async () => {
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, COLOR_0: 1 },
        indices: 2
      }]
    }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 }
    ],
    buffers: [{ byteLength: 78 }]
  };

  const bin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    Buffer.from(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer), // Red, Green, Blue
    Buffer.from(new Uint16Array([0, 1, 2]).buffer)
  ]);

  const glbBuffer = createGlb(json, bin);
  const triangles = await parseGLTFData(glbBuffer);

  assert.equal(triangles.length, 1);
  assert.deepEqual(triangles[0].vertexColors, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
});

test('voxelizeModel quantizes a full-color model into color-preserving blocks', () => {
  // A unit triangle with red vertex color
  const triangles: VoxelTriangle[] = [
    {
      a: [0, 0, 0],
      b: [1, 0, 0],
      c: [0, 1, 0],
      color: 0xff2233
    },
    {
      a: [0, 0, 1],
      b: [1, 0, 1],
      c: [0, 1, 1],
      color: 0x3344ff
    }
  ];

  const plan = planModelSize(triangles, 4, 1);
  const result = voxelizeModel(triangles, plan.cellSize, 0xffffff, { scale: plan.scale });

  assert.ok(result.blocks.length > 0);
  assert.equal(result.blocks[0].block, BlockTypes.COLOR_BLOCK);
  // Blocks preserve the quantized full-color values
  const colors = new Set(result.blocks.map(b => b.color));
  assert.ok(colors.has(0xff2233) || colors.has(0x3344ff));
});

test('voxelizeModel colors every shell block from large textured triangles', () => {
  const side = 16;
  const texture = {
    data: new Uint8Array([255, 0, 0, 255]),
    width: 1,
    height: 1
  };
  const triangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number]
  ): VoxelTriangle => ({
    a, b, c,
    color: 0xffffff,
    uvs: [[0, 0], [1, 0], [1, 1]],
    texture
  });
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number]
  ): VoxelTriangle[] => [triangle(a, b, c), triangle(a, c, d)];

  const triangles = [
    ...quad([0, 0, 0], [0, side, 0], [0, side, side], [0, 0, side]),
    ...quad([side, 0, 0], [side, 0, side], [side, side, side], [side, side, 0]),
    ...quad([0, 0, 0], [0, 0, side], [side, 0, side], [side, 0, 0]),
    ...quad([0, side, 0], [side, side, 0], [side, side, side], [0, side, side]),
    ...quad([0, 0, 0], [side, 0, 0], [side, side, 0], [0, side, 0]),
    ...quad([0, 0, side], [0, side, side], [side, side, side], [side, 0, side])
  ];

  const result = voxelizeModel(triangles, 1, 0xffffff, { hollow: true });
  assert.ok(result.blocks.length > 500);
  assert.deepEqual(new Set(result.blocks.map(block => block.color)), new Set([0xff0000]));
});

test('parse3DModelData accepts FBX, GLB, GLTF, and STL filename extensions', async () => {
  // 1. GLB
  const glbJson = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1
      }]
    }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: 42 }]
  };
  const glbBin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    Buffer.from(new Uint16Array([0, 1, 2]).buffer)
  ]);
  const glbBuffer = createGlb(glbJson, glbBin);
  const glbTris = await parse3DModelData(glbBuffer, 'test_model.glb');
  assert.equal(glbTris.length, 1);
  await assert.rejects(
    parse3DModelData(glbBuffer, 'test_model.bin'),
    /\.bin files are not supported/i
  );

  // 2. STL (ASCII)
  const stlText = `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid test`;
  const stlBuffer = new TextEncoder().encode(stlText).buffer;
  const stlTris = await parse3DModelData(stlBuffer, 'test_model.stl');
  assert.equal(stlTris.length, 1);

  assert.equal(isSupportedModelFilename('model.fbx'), true);
  assert.equal(isSupportedModelFilename('MODEL.GLB'), true);
  assert.equal(isSupportedModelFilename('model.gltf'), true);
  assert.equal(isSupportedModelFilename('model.stl'), true);
  assert.equal(isSupportedModelFilename('model.bin'), false);
  assert.equal(isSupportedModelFilename('model.obj'), false);
  assert.equal(DEFAULT_MODEL_IMPORT_SIZE_BLOCKS, 12);
});

test('parseFBXData extracts mesh triangles from an ASCII FBX scene', async () => {
  const triangles = await parseFBXData(createAsciiTriangleFbx());
  assert.equal(triangles.length, 1);
  assert.deepEqual(triangles[0].a, [0, 0, 0]);
  assert.deepEqual(triangles[0].b, [1, 0, 0]);
  assert.deepEqual(triangles[0].c, [0, 1, 0]);
  assert.equal(triangles[0].color, 0xcccccc);

  const routedTriangles = await parse3DModelData(createAsciiTriangleFbx(), 'triangle.FBX');
  assert.equal(routedTriangles.length, 1);
});

test('ZIP model packages preserve nested paths and load glTF resources', async () => {
  const { jsonBuffer, binBuffer } = createExternalTexturedGltf();
  const manifest = JSON.parse(new TextDecoder().decode(jsonBuffer));
  manifest.buffers[0].uri = '../buffers/mesh.bin';
  manifest.images[0].uri = '../textures/albedo.png';
  const archive = await extractModelArchive(zippedArrayBuffer({
    'package/models/scene.gltf': new TextEncoder().encode(JSON.stringify(manifest)),
    'package/buffers/mesh.bin': new Uint8Array(binBuffer),
    'package/textures/albedo.png': new Uint8Array([1, 2, 3]),
    '__MACOSX/._scene.gltf': new Uint8Array([0]),
  }));

  assert.equal(archive.model.name, 'package/models/scene.gltf');
  assert.deepEqual(
    archive.resources.map(resource => resource.name).sort(),
    ['package/buffers/mesh.bin', 'package/textures/albedo.png']
  );
  const triangles = await withFakeImageBitmapDecoder(() => parse3DModelData(
    archive.model.buffer,
    archive.model.name,
    archive.resources
  ));
  assert.equal(triangles.length, 1);
  assert.equal(sampleTriangleColor(triangles[0], 1, 0, 0), 0xff0000);
  assert.equal(sampleTriangleColor(triangles[0], 0, 0, 1), 0x0000ff);
});

test('ZIP model packages reject ambiguous models and unsafe paths', async () => {
  await assert.rejects(
    extractModelArchive(zippedArrayBuffer({
      'a.gltf': strToU8('{}'),
      'b.fbx': strToU8('invalid'),
    })),
    /contains 2 model files/
  );
  await assert.rejects(
    extractModelArchive(zippedArrayBuffer({ '../scene.gltf': strToU8('{}') })),
    /unsafe path/
  );
});

test('3D model picker accepts one model with external buffers and textures', () => {
  const source = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /accept="\.zip,\.fbx,\.glb,\.gltf,\.stl,\.bin,\.png,\.jpg,\.jpeg,\.webp,\.avif,\.bmp"/);
  assert.match(source, /multiple/);
  assert.match(source, /resources,/);
  assert.match(source, /extractModelArchive/);
  assert.match(source, /parse3DModelData\(buffer, modelName, resources\)/);
  assert.match(source, /useState\(DEFAULT_MODEL_IMPORT_SIZE_BLOCKS\)/);
  assert.match(source, /Upload one self-contained/);
  assert.match(source, /Include exactly one <code>\.fbx<\/code> or <code>\.gltf<\/code> model/);
  assert.match(source, /Keep the original relative folder structure/);
  assert.match(source, /One model per import/);
});

test('PlayerController imports full-color 3D model into block set inventory', async () => {
  const controller = makeController();
  const blocks = [
    { dx: 0, dy: 0, dz: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
    { dx: 1, dy: 0, dz: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 },
    { dx: 0, dy: 1, dz: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff }
  ];

  const slot = controller.importBlockSetToInventory(blocks, 'robot.glb @size 16');
  assert.ok(slot);
  assert.equal(slot.kind, 'blockset');
  assert.equal(slot.blockCount, 3);
  assert.equal(controller.activeInventoryCategory, 'blockset');
  assert.equal(controller.inventories.blockset.items[0].blocks[0].color, 0xff0000);
  assert.equal(controller.inventories.blockset.items[0].blocks[1].color, 0x00ff00);
  assert.equal(controller.inventories.blockset.items[0].blocks[2].color, 0x0000ff);
});

test('parseGLTFData parses GLB model with material baseColorFactor', async () => {
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.1, 1.0] } }
    ],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        material: 0
      }]
    }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: 42 }]
  };

  const bin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    Buffer.from(new Uint16Array([0, 1, 2]).buffer)
  ]);

  const glbBuffer = createGlb(json, bin);
  const triangles = await parseGLTFData(glbBuffer);

  assert.equal(triangles.length, 1);
  assert.ok(triangles[0].color != null);
  // Three.js extracts baseColorFactor as sRGB material color
  const r = (triangles[0].color >> 16) & 0xff;
  const g = (triangles[0].color >> 8) & 0xff;
  const b = triangles[0].color & 0xff;
  assert.ok(r >= 220 && g >= 110 && g <= 140 && b >= 75 && b <= 100);
});

test('sampleTriangleColor handles glTF flipY = false texture sampling', () => {
  const textureData = new Uint8Array([
    255, 0, 0, 255,   // top-left (row 0): Red
    0, 255, 0, 255,   // top-right (row 0): Green
    0, 0, 255, 255,   // bottom-left (row 1): Blue
    255, 255, 0, 255  // bottom-right (row 1): Yellow
  ]);
  const gltfTri: VoxelTriangle = {
    a: [0, 0, 0],
    b: [1, 0, 0],
    c: [0, 1, 0],
    uvs: [[0, 0], [1, 0], [0, 1]], // top-left (0,0), top-right (1,0), bottom-left (0,1) in glTF UVs
    flipY: false,
    texture: { data: textureData, width: 2, height: 2 }
  };
  // Sample vertex A (top-left 0,0) -> Red
  assert.equal(sampleTriangleColor(gltfTri, 1, 0, 0), 0xff0000);
  // Sample vertex B (top-right 1,0) -> Green
  assert.equal(sampleTriangleColor(gltfTri, 0, 1, 0), 0x00ff00);
  // Sample vertex C (bottom-left 0,1) -> Blue
  assert.equal(sampleTriangleColor(gltfTri, 0, 0, 1), 0x0000ff);
});

test('scaled voxelization preserves glTF texture orientation', () => {
  const texture = {
    data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255
    ]),
    width: 2,
    height: 2
  };
  const triangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    uvs: [[number, number], [number, number], [number, number]]
  ): VoxelTriangle => ({ a, b, c, color: 0xffffff, uvs, flipY: false, texture });
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number]
  ) => [
    triangle(a, b, c, [[0, 0], [1, 0], [1, 1]]),
    triangle(a, c, d, [[0, 0], [1, 1], [0, 1]])
  ];
  const side = 2;
  const triangles = [
    ...quad([0, 0, 0], [0, side, 0], [0, side, side], [0, 0, side]),
    ...quad([side, 0, 0], [side, 0, side], [side, side, side], [side, side, 0]),
    ...quad([0, 0, 0], [0, 0, side], [side, 0, side], [side, 0, 0]),
    ...quad([0, side, 0], [side, side, 0], [side, side, side], [0, side, side]),
    ...quad([0, 0, 0], [side, 0, 0], [side, side, 0], [0, side, 0]),
    ...quad([0, 0, side], [0, side, side], [side, side, side], [side, 0, side])
  ];

  const result = voxelizeModel(triangles, 1, 0xffffff, { scale: 2, hollow: true });
  const corner = result.blocks.find(block => block.dx === 0 && block.dy === 0 && block.dz === 0);
  assert.equal(corner?.color, 0xff0000);
});
