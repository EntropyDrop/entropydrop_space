import { Matrix4, Quaternion, Vector3 } from 'three';
import type { PortableComponent, PortableEntity } from '../../../engine/src/storage/InventoryTypes.ts';
import type { DecorationDefinition } from '../../../engine/src/contraption/Decorations.ts';

// An original Atomic Heart-inspired service drone, made from portable primitives.
// Build in convenient oriented plates, then bake the static plates to the
// engine's greedy-meshed micro grid instead of submitting one draw per plate.
export function createNatureOrb(bake = true): PortableEntity {
  const ink = 0x273236, steel = 0x697779, ivory = 0xdfdac7, red = 0xb92d24;
  const root: PortableComponent = {
    id: 'orb', name: 'VOLNA-01 | Atomic Sphere', pivot: [0, 0, 0],
    body: { type: 'kinematic', mass: 80, useGravity: false, collisionEnabled: true },
    blocks: [], children: [], seats: [], decorations: [], scriptLanguage: 'assemblyscript',
    script: `// A bounded patrol around the authored anchor. Restart never drifts the anchor.
const home: f64[] = [6512.0, 25.0, 620.5];
const phase: f64 = ctx.time * 0.38;
self.setLocalPosition([home[0] + Math.sin(phase) * 1.6,
  home[1] + Math.sin(ctx.time * 1.1) * 0.22,
  home[2] + (Math.cos(phase) - 1.0) * 0.65]);
self.setLocalEuler([Math.sin(phase) * 0.035, Math.sin(phase * 0.7) * 0.28,
  -Math.cos(phase) * 0.055]);`,
  };
  for (let x = -1; x <= 0; x++) for (let y = -1; y <= 0; y++) for (let z = -1; z <= 0; z++) {
    root.blocks.push({ dx: x, dy: y, dz: z, color: ink });
  }
  const add = (id: string, position: number[], scale: number[], color: number,
    rotation?: number[], materialId = 0, component = root) => {
    component.decorations!.push({ id, position, scale, color,
      ...(rotation ? { rotation } : {}), ...(materialId ? { materialId } : {}) } as DecorationDefinition);
  };
  const orientation = (longitude: number, latitude: number) => {
    const x = new Vector3(Math.cos(longitude), 0, -Math.sin(longitude));
    const y = new Vector3(Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude));
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, x.clone().cross(y))).toArray();
  };
  const qz = (angle: number) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  const radius = 2.3, bands = 12, slices = 24;
  for (let j = 0; j < bands; j++) {
    const lat = -Math.PI / 2 + (j + .5) * Math.PI / bands;
    for (let i = 0; i < slices; i++) {
      const lon = i * Math.PI * 2 / slices;
      const normal = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
      const w = 2 * radius * Math.cos(lat) * Math.tan(Math.PI / slices);
      const h = 2 * radius * Math.tan(Math.PI / (bands * 2));
      const rotation = orientation(lon, lat);
      add(`frame_${j}_${i}`, normal.map(n => n * (radius - .035)), [w * 1.02, .16, h * 1.02], ink, rotation);
      // Dark meridian seams and a red service stripe break the ceramic shell into panels.
      const color = j === 5 ? red : (i % 6 === 0 ? steel : ((j + i) % 9 === 0 ? 0xc2c4b6 : ivory));
      add(`armor_${j}_${i}`, normal.map(n => n * (radius + .035)), [w * .9, .14, h * .88], color, rotation);
    }
  }
  // Recessed circular camera housing on the front (-Z).
  for (const [name, r, depth, thickness, color, emissive] of [
    ['bezel', .84, 2.26, .19, steel, 0], ['rim', .69, 2.39, .13, ivory, 0],
    ['sensor', .53, 2.44, .10, red, 1], ['glass', .40, 2.48, .18, 0x161e23, 0],
  ] as const) {
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16;
      add(`${name}_${i}`, [r * Math.cos(a), .18 + r * Math.sin(a), -depth],
        [thickness, 2 * r * Math.tan(Math.PI / 32) * 1.03, .16], color, qz(a), emissive);
    }
  }
  add('lens_back', [0, .18, -2.4], [.75, .75, .10], ink);
  add('lens_core', [0, .18, -2.51], [.34, .34, .09], 0xff4636, undefined, 1);
  add('lens_glint', [-.08, .26, -2.57], [.085, .085, .025], 0xffd3ac, undefined, 1);
  add('brow', [0, 1.07, -2.23], [1.28, .11, .24], steel);
  // Side suspension pylons, ducted turbines and amber status lamps.
  for (const side of [-1, 1]) {
    add(`pylon_${side}`, [side * 2.3, -.68, 0], [.95, .23, .4], steel, qz(side * -.2));
    const child: PortableComponent = {
      id: side === -1 ? 'turbine_left' : 'turbine_right', name: 'Counter-rotating turbine',
      pivot: [0, 0, 0], localPosition: [side * 2.875, -.75, 0],
      body: { type: 'kinematic', mass: 1, useGravity: false, collisionEnabled: false },
      blocks: [{ dx: 0, dy: 0, dz: 0, mx: 0, my: 0, mz: 0, size: .125, color: steel }],
      children: [], seats: [], decorations: [], scriptLanguage: 'assemblyscript',
      script: `self.setLocalSpin([0, 1, 0], ${side * 90});`,
    };
    for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12;
      add(`duct_${side}_${i}`, [side * 2.875 + .56 * Math.sin(a), -.75, .56 * Math.cos(a)],
        [.16, .45, .14], i % 6 === 0 ? red : steel, orientation(a, 0));
      add(`exhaust_${side}_${i}`, [side * 2.875 + .43 * Math.sin(a), -1.03, .43 * Math.cos(a)],
        [.10, .10, .10], 0x64d1d3, undefined, 1);
    }
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      add(`blade_${i}`, [.28 * Math.sin(a), 0, .28 * Math.cos(a)], [.15, .055, .50], ink,
        [0, Math.sin(a / 2), 0, Math.cos(a / 2)], 0, child);
    }
    root.children.push(child);
    add(`lamp_${side}`, [side * 1.45, .78, -1.85], [.20, .11, .12], 0xffb54b, undefined, 1);
  }
  add('antenna_base', [.62, 2.19, .1], [.32, .24, .32], steel);
  add('antenna', [.62, 2.65, .1], [.065, .8, .065], ink);
  add('antenna_tip', [.62, 3.04, .1], [.16, .14, .16], 0xf64c39, undefined, 1);
  // Front service badge and grille (geometry, no texture requests).
  add('badge', [-1.03, .45, -2.10], [.31, .39, .10], red);
  for (let i = 0; i < 5; i++) add(`grille_${i}`, [(i - 2) * .16, -1.16, -1.97], [.075, .36, .10], ink);
  if (bake) {
    bakeDecorations(root);
    // The authored stopped assembly must have unique voxel ownership. Give the
    // spinning blades priority where rasterization touches a stationary duct.
    const movingCells = new Set<string>();
    for (const child of root.children) for (const b of child.blocks) {
      const p = child.localPosition!;
      movingCells.add(`${b.dx * 8 + (b.mx || 0) + p[0] * 8},${b.dy * 8 + (b.my || 0) + p[1] * 8},${b.dz * 8 + (b.mz || 0) + p[2] * 8}`);
    }
    root.blocks = root.blocks.filter(b => b.size !== .125
      || !movingCells.has(`${b.dx * 8 + (b.mx || 0)},${b.dy * 8 + (b.my || 0)},${b.dz * 8 + (b.mz || 0)}`));
  }
  return { type: 'space-entity', version: 8, root, constraints: [] };
}

function bakeDecorations(component: PortableComponent) {
  const cells = new Map<string, { x: number; y: number; z: number; color: number; materialId: number }>();
  for (const decoration of component.decorations || []) {
    const center = new Vector3().fromArray(decoration.position || [0, 0, 0]);
    const q = new Quaternion().fromArray(decoration.rotation || [0, 0, 0, 1]);
    const inverse = q.clone().invert();
    // Preserve small lamps and antennae at the minimum supported voxel size.
    const half = new Vector3().fromArray((decoration.scale || [1,1,1]).map(v => Math.max(.125, v) / 2));
    const lo = new Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate();
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new Vector3(x * half.x, y * half.y, z * half.z).applyQuaternion(q).add(center);
      lo.min(corner); hi.max(corner);
    }
    for (let x = Math.floor(lo.x * 8); x < Math.ceil(hi.x * 8); x++)
      for (let y = Math.floor(lo.y * 8); y < Math.ceil(hi.y * 8); y++)
        for (let z = Math.floor(lo.z * 8); z < Math.ceil(hi.z * 8); z++) {
          const p = new Vector3((x + .5) / 8, (y + .5) / 8, (z + .5) / 8).sub(center).applyQuaternion(inverse);
          if (Math.abs(p.x) > half.x + .001 || Math.abs(p.y) > half.y + .001 || Math.abs(p.z) > half.z + .001) continue;
          cells.set(`${x},${y},${z}`, { x, y, z, color: decoration.color, materialId: decoration.materialId || 0 });
        }
  }
  const existing = component.blocks;
  for (const { x, y, z, color, materialId } of cells.values()) {
    const dx = Math.floor(x / 8), dy = Math.floor(y / 8), dz = Math.floor(z / 8);
    const mx = (x % 8 + 8) % 8, my = (y % 8 + 8) % 8, mz = (z % 8 + 8) % 8;
    const duplicate = existing.some(b => b.dx === dx && b.dy === dy && b.dz === dz
      && (b.size !== .125 || (b.mx === mx && b.my === my && b.mz === mz)));
    if (!duplicate) component.blocks.push({ dx, dy, dz, mx, my, mz, size: .125, color, materialId });
  }
  component.decorations = [];
  for (const child of component.children) bakeDecorations(child);
}
