import * as THREE from 'three';

export type HeldTool = 'shovel' | 'spoon' | 'selector' | 'hammer' | 'wrench' | 'brush';

export function normalizeHeldTool(tool: string | null | undefined): HeldTool | null {
  switch (tool) {
    case 'shovel': case 'spoon': case 'selector': case 'hammer': case 'wrench': case 'brush':
      return tool;
    case 'pipette': return 'brush';
    default: return null;
  }
}

// All dimensions are integer cells. The origin is the grip, +Y points toward
// the working end, and +Z is the detailed face. Cells use the skin's model units.
const CELL = 0.4;
// Normalize silhouettes to the same overall length, then reduce the former
// typical 24-cell tool to two thirds. The grip remains at the origin.
export const HELD_TOOL_LENGTH = 24 * CELL * (2 / 3);
const TOOL_COLORS = [
  0xbac5cf, 0xe6edf2, 0x778996, 0x9caab6, 0xf7fafc, // silver
  0x714727, 0x9e6638, 0xc38b50, // wooden brush handle
  0xd9bd8b, 0xa98653, 0xefdbb4 // natural bristles
];
export type HeldVoxelToolMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
type Voxel = { x: number; y: number; z: number; tone: number };

function createMetalEnvironment() {
  // A small neutral reflection map keeps silver readable even in shadow. The
  // world has no environment map; metalness alone would make these tools black.
  const width = 64;
  const height = 32;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sky = y / (height - 1);
      const angle = x / width * Math.PI * 2;
      const strip = Math.pow(Math.max(0, Math.cos(angle - 0.6)), 24);
      const light = Math.min(255, 95 + sky * 115 + strip * 65);
      const offset = (y * width + x) * 4;
      data[offset] = light;
      data[offset + 1] = light;
      data[offset + 2] = light;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function toolVoxels(tool: HeldTool) {
  const cells = new Map<string, Voxel>();
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tone = 0) => {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) cells.set(`${x},${y},${z}`, { x, y, z, tone });
      }
    }
  };
  const handle = (top: number) => {
    box(-1, 1, -4, top, -1, 1, 3);
    box(-1, -1, -3, top, 1, 1, 1);
    // Machined grip bands and a bright metal end cap.
    for (const y of [-3, 0, 3]) box(-1, 1, y, y, -1, 1, 2);
    box(-1, 1, -4, -4, -1, 1, 1);
  };

  switch (tool) {
    case 'shovel': {
      handle(9);
      // Low-resolution spade blade with socket collar, foot treads, dished
      // raised edges, central reinforcing spine, and 45-degree digging tip.
      const widths = [4, 4, 4, 4, 4, 4, 3, 3, 2, 1, 0];
      for (let row = 0; row < widths.length; row++) {
        const width = widths[row];
        const y = row + 10;
        box(-width, width, y, y, -1, 0, 0);
        for (let x = -width; x <= width; x++) {
          if (Math.abs(x) === width && row <= 5) box(x, x, y, y, 1, 1, 4);
          if (x === 0 && row <= 5) box(0, 0, y, y, 1, 1, 1);
        }
      }
      box(-1, 1, 8, 11, -1, 1, 3);
      box(-4, -2, 10, 10, -1, 1, 1);
      box(2, 4, 10, 10, -1, 1, 1);
      break;
    }
    case 'spoon': {
      handle(9);
      // Stepped oval bowl with a recessed center and raised silver rim.
      const widths = [1, 2, 3, 4, 4, 4, 4, 4, 3, 2, 1];
      for (let row = 0; row < widths.length; row++) {
        const width = widths[row];
        box(-width, width, row + 10, row + 10, -1, 0, 3);
        for (let x = -width; x <= width; x++) {
          const rim = Math.abs(x) === width
            || Math.abs(x) >= (widths[row - 1] ?? 0)
            || Math.abs(x) >= (widths[row + 1] ?? 0);
          if (rim) box(x, x, row + 10, row + 10, 1, 1, 1);
        }
      }
      break;
    }
    case 'selector':
      handle(7);
      // A handheld square selection frame, matching the toolbar's outline.
      box(-5, 5, 8, 9, -1, 0);
      box(-5, 5, 17, 18, -1, 0, 1);
      box(-5, -4, 10, 16, -1, 0);
      box(4, 5, 10, 16, -1, 0);
      for (const x of [-5, 3]) {
        for (const y of [8, 16]) box(x, x + 2, y, y + 2, 1, 1, 4);
      }
      break;
    case 'hammer':
      handle(17);
      // A compact eye around the long handle, then a visibly narrower neck
      // behind a heavy square striking face. Avoid a uniform rectangular bar.
      box(-2, 2, 16, 20, -2, 2);
      box(-2, 2, 20, 20, -2, 2, 1);
      box(-1, 1, 17, 19, 3, 3, 3);
      box(0, 0, 18, 18, 3, 3, 1);
      box(-5, -3, 17, 19, -1, 1, 3);
      box(-7, -6, 15, 21, -3, 3, 1);
      box(-8, -8, 16, 20, -2, 2, 4);
      // The opposite end sweeps down into two thin, separated nail-pulling
      // claws. Their stepped taper reads clearly from the side and in 3D.
      box(3, 4, 18, 20, -2, 2);
      for (const z of [-2, 1]) {
        box(5, 5, 17, 20, z, z + 1, 1);
        box(6, 6, 16, 19, z, z + 1, 1);
        box(7, 7, 15, 17, z, z + 1, 1);
        box(8, 8, 14, 15, z, z + 1, 4);
      }
      break;
    case 'wrench':
      handle(9);
      box(-2, 2, 8, 10, -1, 1);
      box(-4, 4, 11, 13, -1, 1);
      box(-5, -3, 14, 17, -1, 1, 1);
      box(3, 5, 14, 17, -1, 1, 1);
      box(-4, -3, 18, 19, -1, 1, 4);
      box(3, 4, 18, 19, -1, 1, 4);
      box(-2, 2, 11, 12, 2, 2, 3);
      break;
    case 'brush':
      box(-1, 1, -4, 10, -1, 1, 6);
      box(-2, 2, -2, 3, -1, 1, 6);
      box(0, 0, -2, 7, 1, 1, 5);
      box(-1, -1, -3, 8, 1, 1, 7);
      box(-3, 3, 10, 11, -1, 1, 3);
      // A short polished ferrule sits between the narrow handle and a much
      // longer, slightly fanned bristle bundle, like a flat painter's brush.
      box(-4, 4, 12, 14, -1, 1, 1);
      box(-4, 4, 12, 12, 2, 2, 4);
      for (const x of [-3, 3]) box(x, x, 13, 13, 2, 2, 3);
      box(-4, 4, 15, 16, -1, 1, 8);
      for (let x = -5; x <= 5; x++) {
        const tip = 23 - Math.floor((x + 5) / 4);
        box(x, x, 17, tip, -1, 1, 8);
        // Fine tonal strands on a continuous surface suggest packed hairs;
        // deep grooves would turn the small silhouette into a comb.
        if (x % 3 === 0) box(x, x, 15, tip - 1, 1, 1, 9);
        box(x, x, tip, tip, -1, 1, 10);
      }
      break;
  }
  return cells;
}

/** Cull internal faces across all materials; only the brush needs three draws. */
export function createHeldVoxelTool(tool: HeldTool): HeldVoxelToolMesh {
  const cells = toolVoxels(tool);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const materialIndices: number[][] = [[], [], []];
  const palette = TOOL_COLORS.map(hex => new THREE.Color(hex));
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
  ];
  for (const { x, y, z, tone } of cells.values()) {
    for (const { n, u, v } of faces) {
      if (cells.has(`${x + n[0]},${y + n[1]},${z + n[2]}`)) continue;
      const start = positions.length / 3;
      const color = palette[tone];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        positions.push(
          (x + (n[0] + a * u[0] + b * v[0]) / 2) * CELL,
          (y + (n[1] + a * u[1] + b * v[1]) / 2) * CELL,
          (z + (n[2] + a * u[2] + b * v[2]) / 2) * CELL
        );
        normals.push(...n);
        colors.push(color.r, color.g, color.b);
      }
      const materialIndex = tone < 5 ? 0 : tone < 8 ? 1 : 2;
      materialIndices[materialIndex].push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const indices: number[] = [];
  for (const [materialIndex, faces] of materialIndices.entries()) {
    if (!faces.length) continue;
    geometry.addGroup(indices.length, faces.length, materialIndex);
    indices.push(...faces);
  }
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const referenceLength = Math.max(size.x, size.y, size.z);
  const scale = HELD_TOOL_LENGTH / referenceLength;
  geometry.scale(scale, scale, scale);
  // Grip near the handle's heel so a smaller tool still shows its shaft above
  // the block-shaped fist. This keeps the handle embedded in the palm.
  geometry.translate(0, 0.65, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.62,
    roughness: 0.3,
    envMap: createMetalEnvironment(),
    envMapIntensity: 1.25,
    emissive: 0x657785,
    emissiveIntensity: 0.16,
    flatShading: true
  });
  const materials = [material];
  material.name = 'ToolSilver';
  if (tool === 'brush') {
    const wood = new THREE.MeshStandardMaterial({
      name: 'BrushWood', vertexColors: true, metalness: 0, roughness: 0.85,
      emissive: 0x2a1a0f, emissiveIntensity: 0.12, flatShading: true
    });
    const bristles = new THREE.MeshStandardMaterial({
      name: 'BrushBristles', vertexColors: true, metalness: 0, roughness: 1,
      emissive: 0x4a3820, emissiveIntensity: 0.08, flatShading: true
    });
    materials.push(wood, bristles);
  }
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = `HeldVoxelTool:${tool}`;
  return mesh;
}
