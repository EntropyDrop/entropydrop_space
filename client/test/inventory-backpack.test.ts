import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import {
  BULK_EDIT_THRESHOLD,
  MAX_INVENTORY_BLOCKS,
  MAX_INVENTORY_IMPORT_BYTES,
  MAX_INVENTORY_SCRIPT_BYTES,
  PlayerController,
  SpecialTool
} from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import {
  decodeBackpack,
  encodeInventoryResource,
  protobufFromBase64,
  protobufToBase64,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { SpaceUiStore, spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

/**
 * Backpack: three categories of 99 items each (block sets, entities, color sets),
 * per-category selection, Protobuf serialize/parse, caps, and deletion.
 */

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
  controller.sound = { playBlockPlace() {}, playAssemblyClack() {}, playGlueApply() {}, playWrenchClick() {} };
  const toasts: string[] = [];
  const appliedSets: any[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {},
    applyColorSetToPalette: set => appliedSets.push(set)
  };
  Object.assign(controller, overrides);
  controller.inventoryCategory(); // lazy 3×99 bootstrap (prototype instances skip the constructor)
  controller.__toasts = toasts;
  controller.__appliedColorSets = appliedSets;
  return controller;
}

function makeMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function makeEntity() {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00, entityId: 'arm' }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      rootComponentId: 'root',
      childEntities: [{ id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }],
    }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  return { contraption, manager, scene };
}

test('R copies into the entity category, T into the blockset category', () => {
  const { contraption, manager } = makeEntity();
  const controller = makeController({ manager, world: {} as any });
  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };

  controller.copySelectionToInventory();
  assert.equal(controller.inventories.entity.items.filter(Boolean).length, 1, 'R should fill an entity slot');
  assert.equal(typeof controller.inventories.entity.items.find(Boolean).name, 'string');
  assert.equal(controller.inventories.blockset.items.filter(Boolean).length, 0);
  assert.equal(controller.activeInventoryCategory, 'entity', 'the bar should switch to entities after R');

  const controller2 = makeController({ manager, world: {} as any });
  controller2.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };
  controller2.copySelectionAsBlockSet();
  const blockset = controller2.inventories.blockset.items.find(Boolean);
  assert.ok(blockset, 'T should fill a blockset slot');
  assert.equal(blockset.kind, 'blockset');
  assert.equal(typeof blockset.name, 'string');
  assert.equal(controller2.inventories.entity.items.filter(Boolean).length, 0);
  assert.equal(controller2.activeInventoryCategory, 'blockset');
});

test('each category caps at 99 items and the copy reports the limit', () => {
  const { contraption, manager } = makeEntity();
  const controller = makeController({ manager, world: {} as any });
  for (let i = 0; i < controller.inventories.entity.items.length; i++) {
    controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };
    assert.ok(controller.copySelectionToInventory(), 'copy ' + (i + 1) + ' should be accepted');
  }
  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };
  const hundredth = controller.copySelectionToInventory();
  assert.equal(hundredth, null, 'the 100th entity copy must be rejected');
  assert.equal(controller.inventories.entity.items.filter(Boolean).length, 99);
  assert.ok(controller.__toasts.some(m => m.includes('full (99)')));
});

test('color set inventory has capacity 99 and renders without visible group or slot labels', () => {
  const controller = makeController();
  assert.equal(controller.inventories.colorset.items.length, 99);

  for (let index = 0; index < 99; index++) {
    assert.equal(controller.addInventoryItem('colorset', {
      name: `Palette ${index + 1}`,
      colors: new Array(9).fill('#123456')
    }), index);
  }
  assert.equal(controller.addInventoryItem('colorset', {
    name: 'Palette 100',
    colors: new Array(9).fill('#abcdef')
  }), null);

  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  const colorSetSlotsSource = inventorySource.slice(
    inventorySource.indexOf('function ColorSetSlots'),
    inventorySource.indexOf('function MarketResourceCard')
  );
  assert.match(colorSetSlotsSource, /className="inventory-grid colorset-grid"/);
  assert.doesNotMatch(colorSetSlotsSource, />Group /);
  assert.doesNotMatch(colorSetSlotsSource, />Slots /);
  assert.match(inventorySource, /<span>My Color Sets<\/span>/);
  assert.doesNotMatch(inventorySource, /My Color Sets \([^)]*(?:slots|groups)/i);
});

test('deleteInventoryItem frees a slot and keeps a valid selection', () => {
  const controller = makeController();
  controller.inventories.blockset.items[0] = { kind: 'blockset', blocks: [], blockCount: 0, name: 'a' };
  controller.inventories.blockset.items[1] = { kind: 'blockset', blocks: [], blockCount: 0, name: 'b' };
  controller.inventories.blockset.selected = 1;
  assert.equal(controller.deleteInventoryItem('blockset', 0), true);
  assert.equal(controller.inventories.blockset.items[0], null);
  assert.equal(controller.inventories.blockset.selected, 1, 'selection stays when the kept slot still exists');
  assert.equal(controller.deleteInventoryItem('blockset', 1), true);
  assert.equal(controller.inventories.blockset.selected, 0, 'selection falls back when the list empties');
  assert.equal(controller.deleteInventoryItem('blockset', 0), false);
  assert.equal(controller.deleteInventoryItem('nope' as any, 0), false);

  controller.inventories.entity.items[2] = { blocks: [{}], blockCount: 1 };
  controller.inventories.entity.items[7] = { blocks: [{}], blockCount: 1 };
  controller.inventories.entity.selected = 7;
  assert.equal(controller.deleteInventoryItem('entity', 2), true);
  assert.equal(controller.inventories.entity.selected, 7, 'deleting another item preserves the active slot');
});

test('inventory slots bridge to the active category', () => {
  const controller = makeController();
  assert.equal(controller.activeInventoryCategory, 'blockset');
  assert.equal(controller.inventorySlots.length, 99);
  controller.inventorySlots[0] = { kind: 'blockset', blocks: [], blockCount: 0, name: 'x' };
  assert.equal(controller.selectedInventoryIndex, 0);
  controller.selectedInventoryIndex = 4;
  controller.setActiveInventoryCategory('entity');
  assert.equal(controller.selectedInventoryIndex, 0, 'each category keeps its own cursor');
  assert.equal(controller.inventories.blockset.selected, 4, 'the blockset cursor is preserved');
  assert.equal(controller.inventorySlots[0], null, 'the entity list is empty');
  controller.selectedInventoryIndex = 99;
  assert.equal(controller.selectedInventoryIndex, 0, 'out-of-range indices reset to 0');

  controller.inventorySlots = new Array(20).fill({ blocks: [{}], blockCount: 1 });
  assert.equal(controller.inventorySlots.length, 9, 'the compatibility setter cannot exceed the 9-item cap');
});

test('the backpack workbench no longer renders tool cards', () => {
  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  const hudSource = readFileSync(new URL('../src/ui/react/components/Hud.tsx', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../src/ui/react/components/EditorModal.tsx', import.meta.url), 'utf8');
  const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(inventorySource, /inventory-card tool-card/);
  assert.doesNotMatch(inventorySource, /const tools = \[/);
  assert.doesNotMatch(inventorySource, /KEYBOARD PALETTE \(9\)/);
  assert.doesNotMatch(inventorySource, /CURRENT BUILD COLOR/);
  assert.match(inventorySource, /ColorSetCard/);
  assert.match(`${inventorySource}\n${hudSource}`, /colorset-(?:preview-grid|colors)/);
  assert.doesNotMatch(editorSource, /\.innerHTML|createElement\(/);
  assert.doesNotMatch(editorSource, /applyAgentCode\(code, targetId, true\)/);
  assert.match(styleSource, /\.colorset-colors\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(indexSource, /Content-Security-Policy/);
  assert.match(indexSource, /object-src 'none'/);
});

test('all categories support duplicate editable names', () => {
  const controller = makeController();
  const blockA = { kind: 'blockset', name: 'Shared', blocks: [{}], blockCount: 1 };
  const blockB = { kind: 'blockset', name: 'Shared', blocks: [{}], blockCount: 1 };
  assert.equal(controller.addInventoryItem('blockset', blockA), 0);
  assert.equal(controller.addInventoryItem('blockset', blockB), 1);
  assert.equal(controller.renameInventoryItem('blockset', 1, 'Shared'), 'Shared');

  assert.equal(controller.addInventoryItem('entity', { name: 'Shared', blocks: [{}], blockCount: 1 }), 0);
  assert.equal(controller.addInventoryItem('colorset', { name: 'Shared', colors: new Array(9).fill('#123456') }), 0);
  assert.equal(controller.inventories.blockset.items[0].name, 'Shared');
  assert.equal(controller.inventories.blockset.items[1].name, 'Shared');
  assert.equal(controller.inventories.entity.items[0].name, 'Shared');
  assert.equal(controller.inventories.colorset.items[0].name, 'Shared');

  assert.equal(controller.renameInventoryItem('entity', 0, '  Renamed  '), 'Renamed');
  assert.equal(controller.renameInventoryItem('entity', 0, '   '), '', 'empty names are allowed as empty string');
  assert.equal(controller.inventories.entity.items[0].name, '');
});

test('serialize/parse round-trips block sets', () => {
  const controller = makeController();
  const slot = {
    kind: 'blockset',
    name: 'my set',
    blockCount: 3,
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 1, block: 1, color: 0xff0000 },
      { dx: 1.125, dy: 0.25, dz: 2.5, size: 0.125, block: 1, color: 0x00ff00 },
      { dx: -0.125, dy: -1.625, dz: -2, size: 0.125, block: 1, color: 0x0000ff }
    ]
  };
  const serialized = controller.serializeInventoryItem('blockset', slot);
  assert.equal(serialized.version, 7);
  assert.equal('label' in serialized, false);
  assert.deepEqual(
    serialized.blocks.map(({ dx, dy, dz, mx, my, mz }) => ({ dx, dy, dz, mx, my, mz })),
    [
      { dx: 0, dy: 0, dz: 0, mx: undefined, my: undefined, mz: undefined },
      { dx: 1, dy: 0, dz: 2, mx: 1, my: 2, mz: 4 },
      { dx: -1, dy: -2, dz: -2, mx: 7, my: 3, mz: 0 }
    ]
  );
  for (const block of serialized.blocks) {
    assert.equal('size' in block, false, 'v5 infers standard/micro from mx/my/mz');
    for (const key of ['dx', 'dy', 'dz', 'mx', 'my', 'mz']) {
      if (block[key] !== undefined) assert.equal(Number.isInteger(block[key]), true, `${key} must be an integer`);
    }
  }

  const encoded = controller.encodeInventoryItem('blockset', slot);
  const parsed = controller.parseInventoryImport(encoded, 'blockset');
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.item.blocks.length, 3);
  assert.deepEqual(parsed.item.blocks.map(block => block.dx), [-0.125, 0, 1.125]);
  const positiveMicro = parsed.item.blocks.find(block => block.color === 0x00ff00);
  const negativeMicro = parsed.item.blocks.find(block => block.color === 0x0000ff);
  const standard = parsed.item.blocks.find(block => block.color === 0xff0000);
  assert.deepEqual(
    [positiveMicro.dx, positiveMicro.dy, positiveMicro.dz, positiveMicro.size],
    [1.125, 0.25, 2.5, 0.125],
  );
  assert.deepEqual([negativeMicro.dx, negativeMicro.dy], [-0.125, -1.625]);
  assert.equal(standard.size, 1);
  assert.equal('part' in positiveMicro, false);
  assert.equal(parsed.item.name, 'my set');

  // Old, untyped and localX-style files are intentionally unsupported.
  const local = JSON.stringify({ blocks: [{ localX: 1, localY: 2, localZ: 3, size: 1, color: 0x123456 }] });
  const localParsed = controller.parseInventoryImport(local, 'blockset');
  assert.equal(localParsed.ok, false);

  const legacy = JSON.stringify({ type: 'space-blockset', version: 1, name: 'old', blocks: [{ dx: 0.125, dy: 1.625, dz: 0, size: 0.125 }] });
  const legacyParsed = controller.parseInventoryImport(legacy, 'blockset');
  assert.equal(legacyParsed.ok, false);

  assert.equal(controller.parseInventoryImport('{"type":"space-blockset","version":2,"name":"bad","blocks":[{"dx":0.125,"dy":0,"dz":0}]}', 'blockset').ok, false);
  assert.equal(controller.parseInventoryImport('{"type":"space-blockset","version":2,"name":"bad","blocks":[{"dx":0,"dy":0,"dz":0,"mx":1,"my":0,"mz":5}]}', 'blockset').ok, false);
  assert.equal(controller.parseInventoryImport('{"type":"space-blockset","version":2,"name":"bad","blocks":[{"dx":0,"dy":0,"dz":0,"mx":1,"my":0}]}', 'blockset').ok, false);
  const inferredMicro = controller.parseInventoryImport(encodeInventoryResource('blockset', {
    type: 'space-blockset', version: 7, name: 'micro',
    blocks: [{ dx: 0, dy: 0, dz: 0, mx: 1, my: 0, mz: 0, color: 0 }]
  }), 'blockset');
  assert.equal(inferredMicro.ok, true);
  assert.equal(inferredMicro.item.blocks[0].size, 0.125);

  assert.equal(controller.parseInventoryImport('{"blocks": []}', 'blockset').ok, false);
  assert.equal(controller.parseInventoryImport('not json', 'blockset').ok, false);
  assert.equal(controller.parseInventoryImport('{"colors": ["#123456"]}', 'blockset').ok, false);
});
test('serialize/parse round-trips recursive entities with component-local data', () => {
  const controller = makeController();
  const slot = {
    name: 'robot',
    rootComponentId: 'root',
    blockCount: 4,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 0xff0000, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, size: 1, block: 1, color: 0x00ff00, entityId: 'arm' },
      { localX: 1.125, localY: 0.25, localZ: 2.5, size: 0.125, block: 1, color: 0x123456, entityId: 'arm' },
      { localX: -0.125, localY: -1.625, localZ: -2, size: 0.125, block: 1, color: 0x654321, entityId: 'root' }
    ],
    childEntities: [{
      id: 'arm',
      parentId: 'root',
      localPosition: [0.625, 0.75, 0],
      localRotation: [0, 1, 0, 0],
      anchorRotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      collisionEnabled: false,
      useGravity: false,
      pivot: [1.5, 0.5, 0.5],
      bodyType: 'dynamic',
      mass: 2,
      seats: [{ position: [0, 1, 0] }, { position: [1, 1, 0] }],
      runtimeOnly: 'must not be exported'
    }],
    scripts: [{ id: 'arm', code: 'self.applyForce([0,1,0]);' }],
    enabled: [{ id: 'arm', enabled: false }],
    constraints: [{
      id: 'arm_hinge',
      type: 'hinge',
      bodyA: 'root',
      bodyB: 'arm',
      anchorA: [1, 0, 0],
      anchorB: [0, 0, 0],
      axisA: [0, 1, 0],
      axisB: [0, 1, 0],
      limits: { min: -1, max: 1 },
      stiffness: 0.8,
      collideConnected: false,
      runtimeOnly: 'must not be exported'
    }],
    rootPivotOverride: [0.875, 0.375, 0.625],
    bodyType: 'dynamic',
    anchorRotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    useGravity: false,
    collisionEnabled: false,
    seats: [{ position: [0.5, 1, 0.5] }]
  };

  const serialized = controller.serializeInventoryItem('entity', slot);
  assert.equal(serialized.version, 7);
  assert.equal(serialized.root.id, 'root');
  assert.equal(serialized.root.body.type, 'dynamic');
  assert.equal(serialized.root.body.useGravity, false);
  assert.equal(serialized.root.body.collisionEnabled, false);
  assert.deepEqual(serialized.root.pivot, [0.875, 0.375, 0.625]);
  assert.deepEqual(serialized.root.seats, [{ position: [0.5, 1, 0.5] }]);
  assert.deepEqual(serialized.root.anchorRotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assert.equal(serialized.root.children.length, 1);
  const arm = serialized.root.children[0];
  assert.equal(arm.id, 'arm');
  assert.equal(arm.body.collisionEnabled, false);
  assert.equal(arm.body.useGravity, false);
  assert.equal(arm.script, 'self.applyForce([0,1,0]);');
  assert.equal(arm.scriptDisabled, true);
  assert.deepEqual(arm.localPosition, [0.625, 0.75, 0]);
  assert.deepEqual(arm.localRotation, [0, 1, 0, 0], '180° quaternions must preserve w = 0');
  assert.deepEqual(arm.anchorRotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  assert.deepEqual(arm.seats, [
    { position: [0, 1, 0] },
    { position: [1, 1, 0] }
  ]);
  assert.equal('runtimeOnly' in arm, false);
  assert.equal('runtimeOnly' in serialized.constraints[0], false);
  assert.equal('blocks' in serialized, false);
  assert.equal('childEntities' in serialized, false);
  assert.equal('isVehicle' in serialized, false);
  assert.equal('cockpitPosition' in serialized, false);
  assert.equal('bearingAxis' in serialized, false);
  assert.equal('pistonAxis' in serialized, false);

  const wireBlocks = [serialized.root.blocks, arm.blocks].flat();
  for (const block of wireBlocks) {
    assert.equal('entityId' in block, false, 'component ownership comes from recursive nesting');
    assert.equal('part' in block, false);
    assert.equal('size' in block, false, 'v5 infers standard/micro from mx/my/mz');
    for (const key of ['dx', 'dy', 'dz', 'mx', 'my', 'mz']) {
      if (block[key] !== undefined) assert.equal(Number.isInteger(block[key]), true, `${key} must be an integer`);
    }
  }

  const encoded = controller.encodeInventoryItem('entity', slot);
  const parsed = controller.parseInventoryImport(encoded, 'entity');
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.item.blocks.length, 4);
  const armMicro = parsed.item.blocks.find(block => block.entityId === 'arm' && block.size === 0.125);
  const rootMicro = parsed.item.blocks.find(block => block.entityId === 'root' && block.size === 0.125);
  assert.deepEqual([armMicro.localX, armMicro.localY, armMicro.localZ], [1.125, 0.25, 2.5]);
  assert.deepEqual([rootMicro.localX, rootMicro.localY, rootMicro.localZ], [-0.125, -1.625, -2]);
  assert.deepEqual(parsed.item.scripts, [{ id: 'arm', code: 'self.applyForce([0,1,0]);' }]);
  assert.deepEqual(parsed.item.enabled, [{ id: 'arm', enabled: false }]);
  assert.equal(parsed.item.childEntities[0].collisionEnabled, false);
  assert.equal(parsed.item.childEntities[0].useGravity, false);
  assert.deepEqual(parsed.item.anchorRotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assert.deepEqual(parsed.item.childEntities[0].localPosition, [0.625, 0.75, 0]);
  assert.deepEqual(parsed.item.childEntities[0].localRotation, [0, 1, 0, 0]);
  assert.deepEqual(parsed.item.childEntities[0].anchorRotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  assert.equal(parsed.item.collisionEnabled, false);
  assert.deepEqual(parsed.item.rootPivotOverride, [0.875, 0.375, 0.625]);
  assert.deepEqual(parsed.item.childEntities[0].seats, [
    { position: [0, 1, 0] },
    { position: [1, 1, 0] }
  ]);
  assert.deepEqual(parsed.item.seats, [{ position: [0.5, 1, 0.5] }]);
  assert.deepEqual(parsed.item.constraints[0].limits, { min: -1, max: 1 });
  assert.equal(parsed.item.name, 'robot');

  const { manager } = makeEntity();
  const built = manager.buildFromSlot(parsed.item, new THREE.Vector3(20, 0, 20));
  assert.ok(built, 'the imported entity should build');
  assert.equal(built.blocks.length, 4);
  assert.ok(built.entityNodes.has('arm'));
  assert.ok(built.getEntityNode('arm').localPosition.distanceTo(new THREE.Vector3(0.625, 0.75, 0)) < 1e-9);
  assert.deepEqual(built.getEntityNode('arm').localQuaternion.toArray(), [0, 1, 0, 0]);
  assert.equal(built.getNodeCollisionEnabled('root'), false);
  assert.equal(built.getComponentSeats('arm').length, 2);
  assert.deepEqual(built.rootPivotOverride?.toArray(), [0.875, 0.375, 0.625]);
  const rebuiltSlot = built.serializeSubtree('root');
  assert.deepEqual(rebuiltSlot.rootPivotOverride, [0.875, 0.375, 0.625]);
  assert.deepEqual(
    controller.serializeInventoryItem('entity', rebuiltSlot).root.pivot,
    [0.875, 0.375, 0.625],
  );

  const inferredMicro = controller.parseInventoryImport(encodeInventoryResource('entity', {
    type: 'space-entity',
    version: 7,
    root: {
      name: 'micro',
      id: 'root',
      body: { type: 'dynamic' },
      blocks: [{ dx: 0, dy: 0, dz: 0, mx: 1, my: 0, mz: 0, color: 0 }],
      seats: [],
      children: []
    },
    constraints: []
  }), 'entity');
  assert.equal(inferredMicro.ok, true);
  assert.equal(inferredMicro.item.blocks[0].size, 0.125);
});

test('serialize/parse round-trips color sets and enforces 9 valid hex colors', () => {
  const controller = makeController();
  const set = { name: 'sunset', colors: ['#f1c40f', '#ff6b81', '#a55eea', '#48dbfb', '#2ed573', '#eb4d4b', '#f5f6fa', '#2f3542', '#f2a93b'] };
  const parsed = controller.parseInventoryImport(controller.encodeInventoryItem('colorset', set), 'colorset');
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(controller.serializeInventoryItem("colorset", set).version, 7);
  assert.equal(parsed.item.colors.length, 9);
  assert.equal(parsed.item.colors[0], '#f1c40f');
  assert.equal(parsed.item.name, 'sunset');

  // Bare arrays and short sets belong to the removed legacy format.
  const bare = controller.parseInventoryImport(JSON.stringify(['#111111', '#222222']), 'colorset');
  assert.equal(bare.ok, false);
  const short = controller.parseInventoryImport(encodeInventoryResource('colorset', {
    type: 'space-colorset', version: 7, name: 'short', colors: ['#111111', '#222222']
  }), 'colorset');
  assert.equal(short.ok, false);

  // Invalid colors are rejected.
  assert.equal(controller.parseInventoryImport('{"type":"space-colorset","version":2,"name":"bad","colors":["#12345","x"]}', 'colorset').ok, false);
  assert.equal(controller.parseInventoryImport('{"blocks":1}', 'colorset').ok, false);
  const tooMany = controller.parseInventoryImport(encodeInventoryResource('colorset', {
    type: 'space-colorset', version: 7, name: 'large', colors: new Array(10).fill('#123456')
  }), 'colorset');
  assert.equal(tooMany.ok, false);
});

test('inventory imports enforce byte, voxel, bounds, hierarchy, and script budgets', () => {
  const controller = makeController();
  assert.equal(controller.parseInventoryImport(new Uint8Array(MAX_INVENTORY_IMPORT_BYTES + 1), 'entity').ok, false);

  const baseEntity = {
    type: 'space-entity',
    version: 7,
    root: {
      name: 'bounded',
      id: 'root',
      body: { type: 'dynamic' },
      blocks: [{ dx: 0, dy: 0, dz: 0, block: 1, color: 0 }],
      seats: [],
      children: []
    },
    constraints: []
  };
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, name: 'x'.repeat(81) }
  }), 'entity').ok, false, 'frontend and backend must both reject names longer than 80 characters');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, name: '🧱'.repeat(80) }
  }), 'entity').ok, true, 'the 80-character limit must count Unicode code points like Python');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, name: '🧱'.repeat(81) }
  }), 'entity').ok, false, 'the shared Unicode code-point limit must still reject character 81');
  const bomName = controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, name: '\ufeffbounded' }
  }), 'entity');
  assert.equal(bomName.ok, true);
  assert.equal(bomName.item.name, '\ufeffbounded', 'Python does not strip U+FEFF from names');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, name: '\u001c' }
  }), 'entity').ok, true, 'Python strips C0 file separators; unnamed components are valid');
  assert.equal(controller.parseInventoryImport(Buffer.from(
    '08065a120a0178120d0a07efbbbf726f6f741a002200',
    'hex',
  ), 'entity').ok, false, 'a leading UTF-8 BOM is component-id data, not a removable marker');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'world',
        body: { type: 'kinematic' },
        blocks: [],
        seats: [],
        children: []
      }]
    }
  }), 'entity').ok, true, 'world is an ordinary component id');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      id: 'world',
      children: [{
        id: 'root',
        body: { type: 'kinematic' },
        blocks: [],
        seats: [],
        children: [],
      }],
    },
  }), 'entity').ok, true, 'root is also an ordinary child id when the tree root has another id');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    constraints: [{
      id: 'root',
      type: 'point',
      bodyA: null,
      bodyB: 'root',
      stiffness: 0.9,
    }],
  }), 'entity').ok, true, 'a missing body A component means the external world');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    constraints: [{
      id: 'world',
      type: 'point',
      bodyA: null,
      bodyB: 'root',
      stiffness: 0.9,
    }],
  }), 'entity').ok, true, 'constraint ids use a namespace separate from component ids');
  const entityWithRootPivot = localPosition => ({
    ...baseEntity,
    root: {
      ...baseEntity.root,
      pivot: [0.6, 0.5, 0.5],
      children: [{
        id: 'arm',
        pivot: [2.5, 0.5, 0.5],
        localPosition,
        localRotation: [0, 0, 0, 1],
        body: { type: 'kinematic' },
        blocks: [{ dx: 2, dy: 0, dz: 0, block: 1, color: 0 }],
        seats: [],
        children: []
      }]
    }
  });
  assert.equal(controller.parseInventoryImport(encodeInventoryResource(
    'entity',
    entityWithRootPivot([1.9, 0, 0]),
  ), 'entity').ok, true, 'stopped-grid geometry must use the explicit root pivot');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource(
    'entity',
    entityWithRootPivot([1, 0, 0]),
  ), 'entity').ok, false, 'root-pivot validation must reject the same off-grid pose as the backend');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, localPosition: [0, 0, 0] }
  }), 'entity').ok, false, 'the root may not carry a parent-relative transform');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, anchorRotation: [0, 0, 0, 2] }
  }), 'entity').ok, false, 'grid quaternions must already be normalized');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, anchorRotation: [1.0000004, 0, 0, 0] }
  }), 'entity').ok, false, 'quaternion components must use the backend -1..1 range');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    constraints: [{
      id: 'link', type: 'point', bodyA: null, bodyB: 'root', stiffness: 2
    }]
  }), 'entity').ok, false, 'constraint stiffness must stay within the backend range');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('blockset', {
    type: 'space-blockset',
    version: 7,
    name: 'bad color',
    blocks: [{ dx: 0, dy: 0, dz: 0, block: 1, color: 0xffffffff }]
  }), 'blockset').ok, false, 'voxel colors may not be silently truncated to 24 bits');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: Array.from({ length: 64 }, (_, index) => ({
        id: `node_${index}`, body: { type: 'kinematic' }, blocks: [], seats: [], children: []
      }))
    }
  }), 'entity').ok, false, 'one root leaves room for at most 63 children');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'arm', pivot: [129, 0, 0], body: { type: 'kinematic' }, blocks: [], seats: [], children: []
      }]
    }
  }), 'entity').ok, false, 'component pivots use the portable coordinate bound');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, body: { type: 'dynamic', mass: 1e12 + 1 } }
  }), 'entity').ok, false, 'entity mass uses the backend safety bound');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, blocks: [
      { dx: 0, dy: 0, dz: 0, color: 0 },
      { dx: 64, dy: 0, dz: 0, color: 0 }
    ] }
  }), 'entity').ok, false, 'a 65-cell AABB must be rejected');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, children: [{
      id: '<img_onerror>', body: { type: 'kinematic' }, blocks: [], seats: [], children: []
    }] }
  }), 'entity').ok, false, 'component ids are restricted to portable characters');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, script: 'x'.repeat(MAX_INVENTORY_SCRIPT_BYTES + 1) }
  }), 'entity').ok, false, 'oversized scripts must be rejected');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: { ...baseEntity.root, seats: [{}] }
  }), 'entity').ok, false, 'every seat must have an explicit position');
  const fortyFiveDegrees = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      anchorRotation: fortyFiveDegrees,
      children: []
    }
  }), 'entity').ok, false, 'mounting frames must use one of the 24 grid orientations');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'arm',
        pivot: [1.5, 0.5, 0.5],
        localPosition: [0.5, 0, 0],
        localRotation: fortyFiveDegrees,
        body: { type: 'kinematic' },
        blocks: [{ dx: 1, dy: 0, dz: 0, color: 0 }],
        seats: [],
        children: []
      }]
    }
  }), 'entity').ok, false, 'component rest rotations must use 90-degree grid steps');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'arm',
        pivot: [1.5, 0.5, 0.5],
        localPosition: [0.6, 0, 0],
        body: { type: 'kinematic' },
        blocks: [{ dx: 1, dy: 0, dz: 0, color: 0 }],
        seats: [],
        children: []
      }]
    }
  }), 'entity').ok, false, 'the stopped pose must stay on the 0.125-unit construction grid');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'arm',
        pivot: [0.5, 0.5, 0.5],
        localPosition: [0, 0, 0],
        body: { type: 'kinematic' },
        blocks: [{ dx: 0, dy: 0, dz: 0, color: 0 }],
        seats: [],
        children: []
      }]
    }
  }), 'entity').ok, false, 'different components may not overlap in the stopped pose');

  const independentlyBoundedComponents = controller.parseInventoryImport(encodeInventoryResource('entity', {
    ...baseEntity,
    root: {
      ...baseEntity.root,
      children: [{
        id: 'arm',
        body: { type: 'kinematic' },
        blocks: [{ dx: 100, dy: 0, dz: 0, color: 0 }],
        seats: [],
        children: []
      }]
    }
  }), 'entity');
  assert.equal(independentlyBoundedComponents.ok, true,
    'component-local voxel bounds must not be combined across the hierarchy');
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('blockset', {
    type: 'space-blockset',
    version: 7,
    name: 'overlap',
    blocks: [
      { dx: 0, dy: 0, dz: 0, block: 1, color: 0 },
      { dx: 0, dy: 0, dz: 0, mx: 0, my: 0, mz: 0, block: 1, color: 0 }
    ]
  }), 'blockset').ok, false, 'standard and micro voxels may not share one cell');

  const repeatedBlock = { dx: 0, dy: 0, dz: 0, color: 0 };
  assert.equal(controller.parseInventoryImport(encodeInventoryResource('blockset', {
    type: 'space-blockset',
    version: 7,
    name: 'too many',
    blocks: new Array(MAX_INVENTORY_BLOCKS + 1).fill(repeatedBlock)
  }), 'blockset').ok, false, 'oversized voxel arrays must be rejected');
});

test('backpack persists all categories and seeds the default palette', () => {
  const storage = makeMemoryStorage();
  const controller = makeController();
  controller.persistentStorage = storage;

  assert.equal(controller.loadInventoriesFromLocalStorage(), false);
  const defaultSet = controller.inventories.colorset.items.find(Boolean);
  assert.equal(defaultSet.name, 'Default palette');
  assert.equal(defaultSet.colors.length, 9);

  controller.addInventoryItem('blockset', {
    kind: 'blockset',
    name: 'Stored shape',
    blocks: [{ dx: 0.125, dy: 0, dz: 0, size: 0.125, block: 1, color: 0x123456 }],
    blockCount: 1
  });
  controller.addInventoryItem('entity', {
    name: 'Stored entity',
    rootComponentId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 0xabcdef, entityId: 'root' }],
    blockCount: 1
  });
  controller.addInventoryItem('colorset', { name: 'Stored colors', colors: new Array(9).fill('#123456') });
  controller.renameInventoryItem('blockset', 0, 'Renamed shape');
  controller.setActiveInventoryCategory('entity');
  controller.selectedInventoryIndex = 0;

  const raw = storage.getItem('space.backpack.v8.pb');
  assert.ok(raw);
  assert.throws(() => JSON.parse(raw), 'backpack storage is binary Protobuf encoded as base64 in localStorage');
  const stored = decodeBackpack(protobufFromBase64(raw));
  assert.equal(stored.activeCategory, 'entity');
  assert.equal(stored.categories.blockset.items[0].name, 'Renamed shape');
  assert.equal('label' in stored.categories.blockset.items[0], false);
  assert.equal('size' in stored.categories.blockset.items[0].blocks[0], false);

  const restored = makeController();
  restored.persistentStorage = storage;
  assert.equal(restored.loadInventoriesFromLocalStorage(), true);
  assert.equal(restored.activeInventoryCategory, 'entity');
  assert.equal(restored.inventories.blockset.items[0].name, 'Renamed shape');
  assert.equal(restored.inventories.blockset.items[0].blocks[0].dx, 0.125);
  assert.equal(restored.inventories.entity.items[0].name, 'Stored entity');
  assert.equal(restored.inventories.colorset.items.filter(Boolean).length, 2);
});

test('old backpack storage keys are ignored without migration', () => {
  const storage = makeMemoryStorage();
  storage.setItem('space.backpack.v5.pb', protobufToBase64(new Uint8Array([8, 4])));

  const controller = makeController();
  controller.persistentStorage = storage;
  assert.equal(controller.loadInventoriesFromLocalStorage(), false);
  assert.equal(controller.inventories.blockset.items.every(item => item === null), true);
  assert.equal(storage.getItem('space.backpack.v5.pb') !== null, true);
});

test('inventory export filenames use the item name', () => {
  const ui = new SpaceUiStore();
  assert.equal(ui.inventoryProtobufFilename('My Palette'), 'My Palette.edpb');
  assert.equal(ui.inventoryProtobufFilename('robot/body?.pb'), 'robot_body_.edpb');
});

test('Tab toggles the hammer bar between block sets and entities', () => {
  const controller = makeController();
  const renders: string[] = [];
  controller.ui.renderInventoryBar = () => renders.push(controller.activeInventoryCategory);

  assert.equal(controller.toggleHammerCategory(), 'entity', 'the default block-set focus toggles to entities');
  assert.equal(controller.activeInventoryCategory, 'entity');
  assert.equal(controller.toggleHammerCategory(), 'blockset', 'the entity focus toggles back to block sets');
  assert.deepEqual(renders, ['entity', 'blockset'], 'the bar re-renders on every toggle');
  assert.ok(controller.__toasts.some(m => m.includes('ENTITIES')));
  assert.ok(controller.__toasts.some(m => m.includes('BLOCK SETS')));

  // A legacy color-set focus still resolves into the two hammer-bar categories.
  controller.setActiveInventoryCategory('colorset');
  assert.equal(controller.toggleHammerCategory(), 'entity');
});

test('hammer left-click applies a selected color set to the palette', () => {
  const controller = makeController();
  controller.activeTool = SpecialTool.HAMMER;
  const set = { name: 'test set', colors: new Array(9).fill('#123456') };
  controller.setActiveInventoryCategory('colorset');
  controller.inventories.colorset.items[2] = set;
  controller.selectedInventoryIndex = 2;

  assert.equal(controller.pasteInventorySlot(), true);
  assert.equal(controller.__appliedColorSets.length, 1);
  assert.equal(controller.__appliedColorSets[0], set);
  assert.ok(controller.__toasts.some(m => m.includes('Applied color set')));

  // An empty color-set slot reports empty instead of applying.
  controller.selectedInventoryIndex = 5;
  assert.equal(controller.pasteInventorySlot(), false);
  assert.ok(controller.__toasts.some(m => m.includes('slot is empty')));
});

test('large Hammer block sets are applied across bounded frame slices', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const controller = makeController({ world });
  controller.activeTool = SpecialTool.HAMMER;
  controller.bulkEditJob = null;
  controller.getInventoryPlacementPose = () => ({ position: new THREE.Vector3(0, 80, 0) });
  const progress: any[] = [];
  controller.ui.setBulkEditProgress = value => progress.push(value);

  const total = BULK_EDIT_THRESHOLD + 44;
  const slot = {
    kind: 'blockset',
    blockCount: total,
    blocks: Array.from({ length: total }, (_, index) => ({
      dx: index,
      dy: 0,
      dz: 0,
      block: BlockTypes.COLOR_BLOCK,
      color: 0x123456
    }))
  };

  assert.equal(controller.pasteBlockSet(slot), true, 'the bulk job should be accepted immediately');
  assert.ok(controller.bulkEditJob, 'the edit should wait for frame processing');
  assert.equal(world.getBlock(0, 80, 0), BlockTypes.AIR);

  controller.processBulkEditFrame(128, Infinity);
  assert.equal(controller.bulkEditJob.processed, 128);
  assert.equal(world.getBlock(127, 80, 0), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(128, 80, 0), BlockTypes.AIR);

  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);
  assert.equal(world.getBlock(total - 1, 80, 0), BlockTypes.COLOR_BLOCK);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.ok(controller.__toasts.some(message => message.includes(`Built block set: ${total}/${total}`)));
});

test('assembleSelection creates the contraption without automatically writing to backpack', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  world.setBlock(10, 10, 10, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeController({ manager, world });
  manager.selectionHost = controller;

  manager.setCornerA({ x: 10, y: 10, z: 10 });
  manager.setCornerB({ x: 10, y: 10, z: 10 });
  assert.equal(manager.hasValidSelection(), true);

  const contraption = controller.assembleSelection();
  assert.ok(contraption, 'contraption should be assembled');
  assert.equal(controller.inventories.entity.items.filter(Boolean).length, 0, 'assembly does not write to backpack');
  assert.ok(controller.__toasts.some(m => m.includes('assembled as root body')));
});

test('copySelectionToInventory reports an error toast and rejects writing when entity inventory is full', () => {
  const { contraption, manager } = makeEntity();
  const controller = makeController({ manager, world: {} as any });

  // Fill all entity slots
  for (let i = 0; i < controller.inventories.entity.items.length; i++) {
    controller.inventories.entity.items[i] = { rootComponentId: 'root', blockCount: 1, blocks: [{}], name: `E${i + 1}` };
  }
  assert.equal(controller.inventories.entity.items.filter(Boolean).length, 99);

  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };
  const result = controller.copySelectionToInventory();
  assert.equal(result, null, 'copy must be rejected when entity inventory is full');
  assert.equal(controller.inventories.entity.items.filter(Boolean).length, 99);
  assert.ok(controller.__toasts.some(m => m.includes('full (99)')), 'toast must report that entity inventory is full');
});

test('copySelectionAsBlockSet reports an error toast and rejects writing when blockset inventory is full (99)', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  world.setBlock(5, 5, 5, BlockTypes.COLOR_BLOCK, false, 0x0000ff);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });
  manager.selectionHost = controller;

  // Fill all blockset slots
  for (let i = 0; i < controller.inventories.blockset.items.length; i++) {
    controller.inventories.blockset.items[i] = { kind: 'blockset', blockCount: 1, blocks: [{}], name: `B${i + 1}` };
  }
  assert.equal(controller.inventories.blockset.items.filter(Boolean).length, 99);

  manager.setCornerA({ x: 5, y: 5, z: 5 });
  manager.setCornerB({ x: 5, y: 5, z: 5 });

  const result = controller.copySelectionAsBlockSet();
  assert.equal(result, null, 'copy must be rejected when blockset inventory is full');
  assert.equal(controller.inventories.blockset.items.filter(Boolean).length, 99);
  assert.ok(controller.__toasts.some(m => m.includes('full (99)')), 'toast must report that block set inventory is full');
});

test('copySelectionSmart handles both entity and world block selection with unified R key', () => {
  const { contraption, manager } = makeEntity();
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  world.setBlock(2, 2, 2, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  const controller = makeController({ manager, world });
  manager.selectionHost = controller;

  // 1. Entity selection -> copySelectionSmart writes to entity inventory
  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm']) };
  const entSlot = controller.copySelectionSmart();
  assert.ok(entSlot, 'should copy entity subtree');
  assert.equal(controller.activeInventoryCategory, 'entity');
  assert.equal(controller.inventories.entity.items[0].nodeCount, 2);

  // 2. World selection -> copySelectionSmart writes to blockset inventory
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  manager.setCornerA({ x: 2, y: 2, z: 2 });
  manager.setCornerB({ x: 2, y: 2, z: 2 });
  assert.equal(manager.hasValidSelection(), true);

  const blockSlot = controller.copySelectionSmart();
  assert.ok(blockSlot, 'should copy world block set');
  assert.equal(controller.activeInventoryCategory, 'blockset');
  assert.equal(controller.inventories.blockset.items[0].blockCount, 1);
});

test('SpaceUiStore resolveDefaultInventoryCategory selects blockset for shovel/spoon/selector/hammer, colorset for brush, and entity for wrench', () => {
  const controller = makeController();
  spaceUiStore.setController(controller);

  // Hammer tool -> defaults to blockset
  controller.activeTool = SpecialTool.HAMMER;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'blockset');

  // Shovel tool -> defaults to blockset
  controller.activeTool = SpecialTool.SHOVEL;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'blockset');

  // Spoon tool -> defaults to blockset
  controller.activeTool = SpecialTool.SPOON;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'blockset');

  // Selector tool -> defaults to blockset
  controller.activeTool = SpecialTool.SELECTOR;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'blockset');

  // Brush tool -> defaults to colorset
  controller.activeTool = SpecialTool.BRUSH;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'colorset');

  // Pipette tool -> defaults to colorset
  controller.activeTool = SpecialTool.PIPETTE;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'colorset');

  // Wrench tool -> defaults to entity
  controller.activeTool = SpecialTool.WRENCH;
  assert.equal(spaceUiStore.resolveDefaultInventoryCategory(), 'entity');
});

test('SpaceUiStore keeps bulk progress visible through server sync completion', () => {
  const ui = new SpaceUiStore();
  ui.setWorldEditSync({ pendingBatches: 2, pendingMutations: 300, sending: true });
  ui.setBulkEditProgress({
    label: 'Building block set',
    phase: 'syncing',
    processed: 300,
    total: 300,
    changed: 300
  });
  assert.equal(ui.getSnapshot().bulkEdit?.phase, 'syncing');

  ui.setWorldEditSync({ pendingBatches: 0, pendingMutations: 0, sending: false });
  assert.equal(ui.getSnapshot().bulkEdit?.phase, 'complete');
  ui.setBulkEditProgress(null);
});

test('toggleInventoryModal automatically opens the corresponding default tab based on tool', () => {
  const controller = makeController();
  spaceUiStore.setController(controller);

  // 1. Open with Hammer active
  controller.activeTool = SpecialTool.HAMMER;
  spaceUiStore.closeAllModals(false);
  spaceUiStore.toggleInventoryModal(true);
  assert.equal(spaceUiStore.getSnapshot().activeModal, 'inventory');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'blockset');

  // 2. Open with Wrench active
  controller.activeTool = SpecialTool.WRENCH;
  spaceUiStore.closeAllModals(false);
  spaceUiStore.toggleInventoryModal(true);
  assert.equal(spaceUiStore.getSnapshot().activeModal, 'inventory');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'entity');

  // 3. Open with Brush active
  controller.activeTool = SpecialTool.BRUSH;
  spaceUiStore.closeAllModals(false);
  spaceUiStore.toggleInventoryModal(true);
  assert.equal(spaceUiStore.getSnapshot().activeModal, 'inventory');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'colorset');

  // 4. Manually switch tab inside modal
  spaceUiStore.selectInventoryCategory('entity');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'entity');

  spaceUiStore.selectInventoryCategory('blockset');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'blockset');

  spaceUiStore.selectInventoryCategory('colorset');
  assert.equal(spaceUiStore.getSnapshot().activeInventoryCategory, 'colorset');

  spaceUiStore.closeAllModals(false);
});

test('InventoryModal tab buttons have clean labels without emoji icons or capacity badges', () => {
  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  assert.match(inventorySource, />\s*Block Set\s*<\/button>/);
  assert.match(inventorySource, />\s*Entity\s*<\/button>/);
  assert.match(inventorySource, />\s*Color Set\s*<\/button>/);
  assert.doesNotMatch(inventorySource, /backpack-tab-icon/);
  assert.doesNotMatch(inventorySource, /backpack-tab-badge/);
  assert.doesNotMatch(inventorySource, /Add current palette/);
  assert.match(inventorySource, /backpack-pixel-btn/);
  assert.match(inventorySource, /PixelCopyIcon/);
  assert.match(inventorySource, /PixelExportIcon/);
  assert.match(inventorySource, /PixelDeleteIcon/);
});

test('SpaceUiStore copyInventoryItem clones colorset, blockset, and entity into available slots with unique IDs', () => {
  const controller = makeController();
  spaceUiStore.setController(controller);

  // 1. Copy colorset (while it is active)
  const colorset = { id: 'cs_orig_1', name: 'Pastel Glow', colors: ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#ffff00', '#00ffff', '#ff00ff', '#888888'] };
  controller.inventories.colorset.items[0] = colorset;
  spaceUiStore.applyColorSetToPalette(colorset);
  assert.equal(spaceUiStore.getSnapshot().activeColorSetId, 'cs_orig_1');

  spaceUiStore.copyInventoryItem('colorset', 0);
  assert.ok(controller.inventories.colorset.items[1]);
  assert.equal(controller.inventories.colorset.items[1].name, 'Pastel Glow (Copy)');
  assert.deepEqual(controller.inventories.colorset.items[1].colors, colorset.colors);
  assert.notEqual(controller.inventories.colorset.items[1].id, 'cs_orig_1');
  assert.match(controller.inventories.colorset.items[1].id, /^cs_/);
  // Active color set must remain the original, not duplicated to clone
  assert.equal(spaceUiStore.getSnapshot().activeColorSetId, 'cs_orig_1');

  // 2. Copy blockset
  const blockset = { id: 'bs_orig_1', name: 'Pillar', blocks: [{ x: 0, y: 0, z: 0 }], blockCount: 1 };
  controller.inventories.blockset.items[0] = blockset;
  spaceUiStore.copyInventoryItem('blockset', 0);
  assert.ok(controller.inventories.blockset.items[1]);
  assert.equal(controller.inventories.blockset.items[1].name, 'Pillar (Copy)');
  assert.notEqual(controller.inventories.blockset.items[1].id, 'bs_orig_1');
  assert.match(controller.inventories.blockset.items[1].id, /^bs_/);

  // 3. Copy entity with unique ID check
  const entity = { id: 'ent_original_123', publicId: 'ent_original_123', name: 'Drone', blocks: [{ x: 0, y: 0, z: 0 }], blockCount: 1, scripts: [] };
  controller.inventories.entity.items[0] = entity;
  spaceUiStore.copyInventoryItem('entity', 0);
  assert.ok(controller.inventories.entity.items[1]);
  assert.equal(controller.inventories.entity.items[1].name, 'Drone (Copy)');
  assert.notEqual(controller.inventories.entity.items[1].id, 'ent_original_123');
  assert.notEqual(controller.inventories.entity.items[1].publicId, 'ent_original_123');
  assert.match(controller.inventories.entity.items[1].id, /^ent_/);
});

test('ColorSetCard renders 9 swatches in 1 row, places Protobuf import in footer, and omits activate text', () => {
  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(inventorySource, /colorset-colors-row/);
  assert.match(inventorySource, /backpack-panel-footer/);
  assert.doesNotMatch(inventorySource, /Click to activate/);
  assert.doesNotMatch(inventorySource, /Current active palette/);
  assert.match(styleSource, /\.colorset-colors-row\s*\{[^}]*grid-template-columns:\s*repeat\(9,/s);
  assert.match(styleSource, /\.backpack-panel-footer\s*\{[^}]*justify-content:\s*flex-end/s);
});

test('ColorSet deletion is rejected when only 1 color set exists', () => {
  const controller = makeController();
  spaceUiStore.setController(controller);

  // Clear all except 1
  controller.inventories.colorset.items = new Array(99).fill(null);
  controller.inventories.colorset.items[0] = {
    name: 'Only Palette',
    colors: ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#ffff00', '#00ffff', '#ff00ff', '#888888']
  };

  spaceUiStore.deleteInventoryItem('colorset', 0);
  assert.ok(controller.inventories.colorset.items[0], 'Should not delete the only color set');
  assert.equal(controller.inventories.colorset.items.filter(Boolean).length, 1);
});

test('Deleting a color set automatically switches active palette to the first available color set and compacts remaining items', () => {
  const controller = makeController();
  spaceUiStore.setController(controller);

  const set1 = { id: 'cs_1', name: 'First Set', colors: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999'] };
  const set2 = { id: 'cs_2', name: 'Second Set', colors: ['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#ffffff', '#123456', '#654321', '#abcdef'] };
  const set3 = { id: 'cs_3', name: 'Third Set', colors: ['#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999', '#000000'] };

  controller.inventories.colorset.items = new Array(99).fill(null);
  controller.inventories.colorset.items.splice(0, 3, set1, set2, set3);

  // Apply set2 initially
  spaceUiStore.applyColorSetToPalette(set2);

  // Delete set2 (index 1)
  spaceUiStore.deleteInventoryItem('colorset', 1);

  // Remaining array should be compacted: set1 at index 0, set3 shifted to index 1, later slots are null.
  assert.equal(controller.inventories.colorset.items[0].name, 'First Set');
  assert.equal(controller.inventories.colorset.items[1].name, 'Third Set');
  assert.equal(controller.inventories.colorset.items[2], null);
  assert.equal(controller.inventories.colorset.items.length, 99);

  // Active palette should have automatically switched to set1
  const snapshot = spaceUiStore.getSnapshot();
  const activePaletteHexes = snapshot.paletteColors.map(p => p.hex.toLowerCase());
  assert.equal(activePaletteHexes[0], '#111111');
  assert.equal(activePaletteHexes[1], '#222222');
});

test('Color set tab does not display slot labels, # numbers, or import json on empty entries', () => {
  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  assert.match(inventorySource, /function EmptyColorSetSlot/);
  // Verify EmptyColorSetSlot has no #{index + 1}
  const emptySlotFunc = inventorySource.slice(inventorySource.indexOf('function EmptyColorSetSlot'));
  const emptySlotBody = emptySlotFunc.slice(0, emptySlotFunc.indexOf('function InventoryItemCard'));
  assert.doesNotMatch(emptySlotBody, /backpack-slot-index/);
  assert.doesNotMatch(emptySlotBody, /import JSON/i);
  assert.doesNotMatch(emptySlotBody, />Empty slot<\/span>/);
  assert.match(emptySlotBody, />Empty color set<\/span>/);
});

test('backpack bar title in HUD has transparent background and clean button styling', () => {
  const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(styleSource, /#backpack-bar-title[^}]*background:\s*transparent/);
  assert.match(styleSource, /#backpack-bar-title[^}]*border:\s*none/);
  assert.match(styleSource, /#backpack-bar-title[^}]*cursor:\s*pointer/);
});

test('InventoryModal has market toggle button and supports collapsing sidebar on small screens', () => {
  const inventorySource = readFileSync(new URL('../src/ui/react/components/InventoryModal.tsx', import.meta.url), 'utf8');
  assert.match(inventorySource, /id="toggle-market-sidebar-btn"/);
  assert.match(inventorySource, /backpack-market-toggle-btn/);
  assert.match(inventorySource, /market-close-btn/);
  assert.match(inventorySource, /market-collapsed/);
  assert.match(inventorySource, />\s*My published\s*</);
  assert.match(inventorySource, /resource\.can_delete/);
  assert.doesNotMatch(inventorySource, /Admin delete market resource/);
  assert.match(inventorySource, /window\.innerWidth\s*<\s*1100/);

  const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(styleSource, /\.backpack-market-toggle-btn/);
  assert.match(styleSource, /\.backpack-split-layout\.market-collapsed/);
  assert.match(styleSource, /\.market-close-btn/);
});
