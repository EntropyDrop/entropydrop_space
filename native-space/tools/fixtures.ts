import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeInventoryResource } from '../../engine/src/storage/InventoryProtobuf.ts';

const root = resolve(import.meta.dirname, '..');
const fixtures: Record<string, any> = {
  blockset: { type: 'space-blockset', version: 8, name: 'Cross',
    blocks: [{ dx: -1, dy: 2, dz: 0, mx: 4, my: 3, mz: 2, color: 0x12ab34, materialId: 2 },
      { dx: 0, dy: 0, dz: 0, color: 0 }] },
  entity: { type: 'space-entity', version: 8, root: { id: 'body', name: 'Native engine fixture',
    body: { type: 'dynamic', mass: 8, useGravity: true, collisionEnabled: true },
    pivot: [0.5, 0.5, 0.5], blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xf2a93b }],
    script: 'self.state.setNumber("ticks", self.state.getNumber("ticks") + 1);', scriptLanguage: 'assemblyscript',
    seats: [{ position: [0, 1, 0], fixedOrientation: true }],
    decorations: [{ id: 'light', position: [0.5, 1.5, 0.5], scale: [0.2, 0.2, 0.2], color: 0x48dbfb, materialId: 1 }],
    children: [{ id: 'arm', localPosition: [1, 0, 0], body: { type: 'kinematic' },
      blocks: [{ dx: 1, dy: 0, dz: 0, color: 0x2ed573 }], children: [], seats: [] }] },
    constraints: [{ id: 'hinge', type: 'hinge', bodyA: 'body', bodyB: 'arm', axisA: [0, 1, 0],
      axisB: [0, 1, 0], limits: { min: -1, max: 1 }, stiffness: 0.9 }] },
  colorset: { type: 'space-colorset', version: 8, name: 'Gradient', entries: [
    { materialId: 0, stops: [{ color: '#f2a93b', position: 0 }, { color: '#48dbfb', position: 1 }] }] },
};
fixtures.item = { type: 'space-item', version: 8, id: 'fixture', name: 'Mixed',
  blockSet: fixtures.blockset, entityList: [fixtures.entity] };
mkdirSync(resolve(root, 'tests/fixtures'), { recursive: true });
mkdirSync(resolve(root, 'examples'), { recursive: true });
const result: Record<string, string> = {};
for (const [kind, portable] of Object.entries(fixtures)) {
  const bytes = encodeInventoryResource(kind as any, portable);
  result[kind] = Buffer.from(bytes).toString('hex');
  writeFileSync(resolve(root, `examples/${kind}.edpb`), bytes);
}
writeFileSync(resolve(root, 'tests/fixtures/inventory.json'), JSON.stringify(result, null, 2) + '\n');
