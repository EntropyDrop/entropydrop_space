import type { PortableComponent } from '../../../engine/src/storage/InventoryTypes.ts';
type Cell = { x: number; y: number; z: number; color: number; material: number };
export type V3 = [number, number, number];

// Author at 1/8 m, then collapse every completely filled, single-color cubic
// metre to one standard voxel. No separate decoration draws or external assets.
export class Grid {
  cells = new Map<string, Cell>();
  shape(lo: V3, hi: V3, test: (x: number, y: number, z: number) => boolean,
    color: number | ((x: number, y: number, z: number) => number), material = 0) {
    for (let x = Math.floor(lo[0] * 8); x < Math.ceil(hi[0] * 8); x++)
      for (let y = Math.floor(lo[1] * 8); y < Math.ceil(hi[1] * 8); y++)
        for (let z = Math.floor(lo[2] * 8); z < Math.ceil(hi[2] * 8); z++) {
          const px = (x + .5) / 8, py = (y + .5) / 8, pz = (z + .5) / 8;
          if (test(px, py, pz)) this.cells.set(`${x},${y},${z}`, {
            x, y, z, color: typeof color === 'number' ? color : color(px, py, pz), material,
          });
        }
  }
  box(center: V3, size: V3, color: number, yaw = 0, material = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw), [w, h, d] = size.map(v => v / 2);
    const bx = Math.abs(c * w) + Math.abs(s * d), bz = Math.abs(s * w) + Math.abs(c * d);
    this.shape([center[0] - bx, center[1] - h, center[2] - bz],
      [center[0] + bx, center[1] + h, center[2] + bz], (x,y,z) => {
        const dx = x - center[0], dz = z - center[2];
        return Math.abs(c * dx - s * dz) <= w && Math.abs(s * dx + c * dz) <= d;
      }, color, material);
  }
  ellipsoid(center: V3, radii: V3, color: number) {
    this.shape(center.map((v,i) => v - radii[i]) as V3, center.map((v,i) => v + radii[i]) as V3,
      (x,y,z) => ((x-center[0])/radii[0])**2 + ((y-center[1])/radii[1])**2 + ((z-center[2])/radii[2])**2 <= 1, color);
  }
  blocks(): PortableComponent['blocks'] {
    const buckets = new Map<string, Cell[]>();
    for (const cell of this.cells.values()) {
      const key = [cell.x, cell.y, cell.z].map(v => Math.floor(v / 8)).join(',');
      const bucket = buckets.get(key) || []; bucket.push(cell); buckets.set(key, bucket);
    }
    const result: PortableComponent['blocks'] = [];
    for (const [key, cells] of buckets) {
      const [dx,dy,dz] = key.split(',').map(Number), first = cells[0];
      if (cells.length === 512 && cells.every(c => c.color === first.color && c.material === first.material)) {
        result.push({ dx,dy,dz,color:first.color,materialId:first.material });
      } else for (const c of cells) {
        // Partial cubic metres need only their exterior skin. Keep solid
        // standard cores above, and remove invisible micro-voxel interiors.
        const enclosed = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
          .every(([x,y,z]) => this.cells.has(`${c.x+x},${c.y+y},${c.z+z}`));
        if (!enclosed) result.push({ dx,dy,dz,
          mx:c.x-dx*8,my:c.y-dy*8,mz:c.z-dz*8,size:.125,color:c.color,materialId:c.material });
      }
    }
    return result;
  }
}
