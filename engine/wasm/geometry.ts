// Allocation-free f64 geometry/solvers. Hosts own bounded scratch arenas.
export { rayQuads } from './picking';
export { obbContacts } from './contacts';
export { modelFill, modelHollow, modelNearest } from './model-voxel';
export { solveJoints, solvePairImpulse, solveTerrainImpulse, toppleSupport } from './physics-solver';
export function abiVersion(): i32 { return 2; }
