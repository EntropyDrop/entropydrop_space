type SampleCell = { x: number; y: number; z: number; span?: number;
  spanX?: number; spanY?: number; spanZ?: number; entityId: string };
export interface CollisionSampleTemplate {
  positions: Float64Array;
  owners: Uint32Array;
  entityIds: string[];
}

/** Geometry-only probes: pivots, pose, body attachment and enable flags stay live. */
export function createCollisionSampleTemplate(cells: readonly SampleCell[], hasMicro: boolean): CollisionSampleTemplate | null {
  const positions: number[] = [], owners: number[] = [], entityIds: string[] = [];
  const ids = new Map<string, number>();
  const low = 0.001, high = 0.999;
  for (const cell of cells) {
    let owner = ids.get(cell.entityId);
    if (owner === undefined) { owner = entityIds.length; entityIds.push(cell.entityId); ids.set(cell.entityId, owner); }
    const sx = (cell.spanX ?? cell.span) * 0.125, sy = (cell.spanY ?? cell.span) * 0.125, sz = (cell.spanZ ?? cell.span) * 0.125;
    const nx = Math.max(1, Math.round(sx / 0.5)), nz = Math.max(1, Math.round(sz / 0.5)), ny = Math.max(1, Math.round(sy / 0.5));
    const adaptive = hasMicro && (nx > 1 || nz > 1);
    const count = adaptive ? 8 + 2 * ((nx + 1) * (nz + 1) - 4) + Math.max(0, ny - 1) * 4 : 10;
    if (!Number.isFinite(count) || owners.length + count > 262144) return null;
    const push = (x: number, y: number, z: number) => {
      positions.push(cell.x * 0.125 + x * sx, cell.y * 0.125 + y * sy, cell.z * 0.125 + z * sz);
      owners.push(owner);
    };
    for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) for (let iz = 0; iz < 2; iz++) push(ix ? high : low, iy ? high : low, iz ? high : low);
    if (adaptive) {
      for (const y of [low, high]) for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
        if ((ix === 0 || ix === nx) && (iz === 0 || iz === nz)) continue;
        push(ix === 0 ? low : ix === nx ? high : ix / nx, y, iz === 0 ? low : iz === nz ? high : iz / nz);
      }
      if (ny > 1) for (let iy = 1; iy < ny; iy++) for (const x of [low, high]) for (const z of [low, high]) push(x, iy / ny, z);
    } else for (const y of [low, high]) push(0.5, y, 0.5);
  }
  return { positions: Float64Array.from(positions), owners: Uint32Array.from(owners), entityIds };
}
