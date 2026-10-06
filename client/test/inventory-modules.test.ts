import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('inventory import, export and preview run without the game or browser runtime', () => {
  // Use a fresh process: the integration suite already loads the controller and
  // patches Three.js, which would hide accidental dependencies on those modules.
  const modules = {
    importer: new URL('../src/engine/inventory/InventoryImport.ts', import.meta.url).href,
    serializer: new URL('../src/engine/inventory/InventorySerialization.ts', import.meta.url).href,
    geometry: new URL('../src/engine/inventory/InventoryGeometry.ts', import.meta.url).href,
    backpack: new URL('../src/engine/inventory/Backpack.ts', import.meta.url).href,
    persistence: new URL('../src/engine/inventory/BackpackPersistence.ts', import.meta.url).href,
    rotation: new URL('../src/engine/inventory/InventoryRotation.ts', import.meta.url).href,
    placement: new URL('../src/engine/inventory/InventoryPlacementGeometry.ts', import.meta.url).href,
    selection: new URL('../src/engine/controls/SelectionGeometry.ts', import.meta.url).href,
    bindings: new URL('../src/engine/controls/ControlBindings.ts', import.meta.url).href,
    protobuf: new URL('../../engine/src/storage/InventoryProtobuf.ts', import.meta.url).href,
  };
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      assert.doesNotMatch(resolved.url,
        /PlayerController|SceneRenderer|Contraption\\.ts|\\/engine\\/(?:src\\/)?(?:render|physics|scripting)\\//,
        'Inventory data must not load rendering, simulation or scripting');
      assert.notEqual(specifier, 'three/webgpu');
      return resolved;
    }});
    const modules = ${JSON.stringify(modules)};
    const { parseInventoryImport } = await import(modules.importer);
    const { encodeInventoryItem } = await import(modules.serializer);
    const { getInventoryPreviewBlocks } = await import(modules.geometry);
    const { createEmptyInventories } = await import(modules.backpack);
    const { loadBackpack } = await import(modules.persistence);
    const { rotateBlocksY90 } = await import(modules.rotation);
    const { getEntityPlacementShape } = await import(modules.placement);
    const { rangePointToLocal } = await import(modules.selection);
    assert.equal(rangePointToLocal(null, null), null);
    const { SpecialTool } = await import(modules.bindings);
    const { encodeInventoryResource, decodeInventoryResource } = await import(modules.protobuf);
    assert.equal(typeof document, 'undefined');
    assert.equal(createEmptyInventories().item.items.length, 198);
    assert.equal(loadBackpack(null).inventories.colorset.items[0].entries.length, 9);
    assert.deepEqual(rotateBlocksY90([{ dx: 0, dy: 0, dz: 0 }], 4), [{ dx: 0, dy: 0, dz: 0 }]);
    assert.equal(SpecialTool.HAMMER, 'hammer');

    const resource = {
      type: 'space-item', version: 8, id: 'headless-copy', name: 'Workshop',
      blockSet: {
        type: 'space-blockset', version: 8, name: 'Base',
        blocks: [{ dx: 0, dy: -1, dz: 0, color: 0x123456, materialId: 1 }],
      },
      entityList: [{
        type: 'space-entity', version: 8,
        root: {
          id: 'root', name: 'Motor', localPosition: [2.03, 0.2, 0.031],
          body: { type: 'dynamic' }, children: [], seats: [],
          blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xabcdef, materialId: 1 }],
          script: 'export function update(): void {}', scriptLanguage: 'assemblyscript',
        },
        constraints: [],
      }],
    };
    const bytes = encodeInventoryResource('item', resource);
    const parsed = parseInventoryImport(bytes, 'item');
    assert.equal(parsed.ok, true, parsed.error);
    const preview = getInventoryPreviewBlocks(parsed.item);
    assert.equal(getEntityPlacementShape(parsed.item).entries.length, 2);
    assert.deepEqual(preview.map(block => block.center.toArray()),
      [[0.5, -0.5, 0.5], [2.53, 0.7, 0.531]]);
    assert.deepEqual(decodeInventoryResource(encodeInventoryItem('item', parsed.item)).portable,
      decodeInventoryResource(bytes).portable);

    resource.entityList.push(resource.entityList[0]);
    const invalid = parseInventoryImport(encodeInventoryResource('item', resource), 'item');
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /overlap/);
    assert.equal(parseInventoryImport('not protobuf', 'item').ok, false);
  `], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
