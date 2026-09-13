import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import {
  SpaceBuilder,
  validateSpaceBuildPlan
} from '../src/engine/building/SpaceBuilder.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

function createHarness() {
  const standard = new Map<string, { block: number; color: number }>();
  const micro = new Map<string, { block: number; color: number }>();
  const world = {
    getBlock(x, y, z) {
      return standard.get(`${x},${y},${z}`)?.block ?? BlockTypes.AIR;
    },
    getBlockColor(x, y, z) {
      return standard.get(`${x},${y},${z}`)?.color ?? 0;
    },
    setBlock(x, y, z, block, _updateMesh, color = 0) {
      const key = `${x},${y},${z}`;
      if (block === BlockTypes.AIR) standard.delete(key);
      else standard.set(key, { block, color });
      return true;
    },
    hasMicroInStandardCell(x, y, z) {
      const prefix = `${x * 5},${y * 5},${z * 5}`;
      return [...micro.keys()].some(key => {
        const [mx, my, mz] = key.split(',').map(Number);
        return Math.floor(mx / 5) === x && Math.floor(my / 5) === y && Math.floor(mz / 5) === z;
      }) || prefix === '__never__';
    },
    getMicroBlock(x, y, z) {
      return micro.get(`${x},${y},${z}`) || null;
    },
    setMicroBlock(x, y, z, color) {
      micro.set(`${x},${y},${z}`, { block: BlockTypes.COLOR_BLOCK, color });
      return true;
    },
    removeMicroBlock(x, y, z) {
      return micro.delete(`${x},${y},${z}`);
    },
    editPersistence: { getSyncStatus: () => ({ backpressured: false }) }
  };
  const manager: any = {
    world,
    contraptions: [],
    performBasicAction(command) {
      return executeBasicAction({ world, manager }, command);
    },
    buildFromSlot(slot, position, _restore, _save, preparedBlocks) {
      const entity = {
        publicId: `entity-${this.contraptions.length + 1}`,
        slot,
        position: position.clone(),
        blocks: preparedBlocks
      };
      this.contraptions.push(entity);
      return entity;
    },
    removeContraption(entity) {
      const index = this.contraptions.indexOf(entity);
      if (index >= 0) this.contraptions.splice(index, 1);
    }
  };
  const controller = {
    getInventoryPlacementPose(slot) {
      return { slot, position: new THREE.Vector3(10, 10, 10) };
    }
  };
  const statuses: any[] = [];
  const builder = new SpaceBuilder({
    world,
    contraptions: manager,
    controller,
    onStatus: status => statuses.push(status)
  });
  return { builder, world, manager, standard, micro, statuses };
}

test('BuildPlan validation expands bounded primitives and rejects overlap', () => {
  const valid = validateSpaceBuildPlan({
    version: 1,
    kind: 'structure',
    name: 'Hollow cube',
    anchor: 'crosshair',
    primitives: [{
      type: 'box',
      from: [0, 0, 0],
      to: [2, 2, 2],
      hollow: true,
      color: '#48dbfb'
    }]
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.summary.voxelCount, 26);
  assert.equal(valid.slot.kind, 'blockset');

  const overlap = validateSpaceBuildPlan({
    kind: 'structure',
    blocks: [
      { x: 0, y: 0, z: 0, size: 1 },
      { x: 0.125, y: 0.125, z: 0.125, size: 0.125 }
    ]
  });
  assert.equal(overlap.ok, false);
  assert.match(overlap.errors.join(' '), /overlapping voxel/);

  const oversized = validateSpaceBuildPlan({
    kind: 'structure',
    primitives: [{ type: 'box', from: [0, 0, 0], to: [100_000, 2, 2] }]
  });
  assert.equal(oversized.ok, false);
  assert.equal(validateSpaceBuildPlan({
    kind: 'structure',
    primitives: [{ type: 'line', from: [0.1, 0, 0], to: [1, 0, 0], size: 1 }]
  }).ok, false);
});

test('SpaceBuilder previews, incrementally commits and undoes a structure', () => {
  const { builder, standard, micro } = createHarness();
  const validation = builder.preview({
    version: 1,
    kind: 'structure',
    name: 'Mixed marker',
    anchor: 'crosshair',
    blocks: [
      { x: 0, y: 0, z: 0, color: '#112233' },
      { x: 1.125, y: 0.125, z: 0.125, size: 0.125, color: '#abcdef' }
    ]
  });
  assert.equal(validation.ok, true);
  assert.deepEqual(builder.getRenderPreview().position.toArray(), [10, 10, 10]);
  assert.deepEqual(builder.commit(), { ok: true, jobId: 'build-1', reason: 'queued' });
  while (builder.update(1, Infinity)) { /* incremental */ }
  assert.equal(standard.get('10,10,10')?.color, 0x112233);
  assert.equal(micro.get('89,81,81')?.color, 0xabcdef);
  assert.equal(builder.getHistory().length, 1);

  assert.deepEqual(builder.undo(), { ok: true, jobId: 'undo-2', reason: 'queued' });
  while (builder.update(1, Infinity)) { /* incremental rollback */ }
  assert.equal(standard.size, 0);
  assert.equal(micro.size, 0);
  assert.equal(builder.getHistory().length, 0);
});

test('SpaceBuilder creates and removes a validated component entity', () => {
  const { builder, manager } = createHarness();
  const validation = builder.preview({
    version: 1,
    kind: 'entity',
    name: 'Rotor',
    anchor: [20, 5, 20],
    blocks: [
      { x: 0, y: 0, z: 0, componentId: 'root' },
      { x: 0, y: 1, z: 0, componentId: 'rotor', color: '#48dbfb' }
    ],
    components: [
      { id: 'root', parentId: null, bodyType: 'dynamic' },
      { id: 'rotor', parentId: 'root', pivot: [0.5, 1.5, 0.5], bodyType: 'kinematic' }
    ]
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.slot.childEntities[0].id, 'rotor');
  builder.commit();
  while (builder.update(1, Infinity)) { /* prepare entity */ }
  assert.equal(manager.contraptions.length, 1);
  assert.deepEqual(manager.contraptions[0].position.toArray(), [20, 5, 20]);
  assert.equal(manager.contraptions[0].blocks.length, 2);

  assert.deepEqual(builder.undo(), { ok: true, jobId: null, reason: 'undone' });
  assert.equal(manager.contraptions.length, 0);
});

test('BuildPlan keeps constraint ids in a namespace separate from component ids', () => {
  const entityPlan = {
    version: 1,
    kind: 'entity',
    name: 'Anchored body',
    blocks: [{ x: 0, y: 0, z: 0, componentId: 'root' }],
    components: [{ id: 'root', parentId: null, bodyType: 'dynamic' }],
    constraints: [{
      id: 'world',
      type: 'point',
      bodyA: null,
      bodyB: 'root',
    }],
  };

  assert.equal(validateSpaceBuildPlan(entityPlan).ok, true);
  const rootNamedConstraint = validateSpaceBuildPlan({
    ...entityPlan,
    constraints: [{ ...entityPlan.constraints[0], id: 'root' }],
  });
  assert.equal(rootNamedConstraint.ok, true, rootNamedConstraint.errors.join(' '));

  const closedConstraint = validateSpaceBuildPlan({
    ...entityPlan,
    components: [{
      ...entityPlan.components[0],
      index: 3,
      kind: 'root',
      unknown: 'discard me',
    }],
    constraints: [{
      ...entityPlan.constraints[0],
      index: 7,
      kind: 'child',
      rootId: 'root',
      bodyAIsWorld: true,
      unknown: 'discard me',
    }],
  });
  assert.equal(closedConstraint.ok, true, closedConstraint.errors.join(' '));
  assert.deepEqual(Object.keys(closedConstraint.plan!.components[0]).sort(), [
    'bodyType', 'id', 'name', 'parentId'
  ]);
  for (const constraint of [closedConstraint.plan!.constraints[0], closedConstraint.slot.constraints[0]]) {
    assert.deepEqual(Object.keys(constraint).sort(), [
      'bodyA', 'bodyB', 'collideConnected', 'id', 'stiffness', 'type'
    ]);
  }

  const portableLeadingCharacters = validateSpaceBuildPlan({
    version: 1,
    kind: 'entity',
    name: 'Portable ids',
    blocks: [
      { x: 0, y: 0, z: 0, componentId: 'root' },
      { x: 1, y: 0, z: 0, componentId: '1arm' },
    ],
    components: [
      { id: 'root', parentId: null, bodyType: 'dynamic' },
      { id: '1arm', parentId: 'root', bodyType: 'kinematic' },
    ],
    constraints: [{
      id: '-joint',
      type: 'point',
      bodyA: null,
      bodyB: '1arm',
    }],
  });
  assert.equal(portableLeadingCharacters.ok, true, portableLeadingCharacters.errors.join(' '));
});

test('SpaceBuilder cancellation rolls back already placed structure voxels', () => {
  const { builder, standard } = createHarness();
  builder.preview({
    kind: 'structure',
    name: 'Cancelled wall',
    primitives: [{ type: 'line', from: [0, 0, 0], to: [4, 0, 0], color: '#f2a93b' }]
  });
  builder.commit();
  assert.equal(builder.update(2, Infinity), true);
  assert.equal(standard.size, 2);
  assert.deepEqual(builder.cancel(), { ok: true, reason: 'rolling_back' });
  while (builder.update(1, Infinity)) { /* rollback */ }
  assert.equal(standard.size, 0);
  assert.equal(builder.getJob()?.phase, 'cancelled');
  assert.equal(builder.getHistory().length, 0);
});

test('SpaceBuilder placement review reports occupancy and rejects player overlap', () => {
  const { builder, standard } = createHarness();
  standard.set('10,10,10', { block: BlockTypes.COLOR_BLOCK, color: 0xffffff });
  const partial = builder.preview({
    kind: 'structure',
    blocks: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 }
    ]
  });
  assert.equal(partial.ok, true);
  assert.match(partial.warnings.join(' '), /occupied voxel targets/);

  builder.controller.physics = {
    getAABB: () => ({ minX: 10, minY: 10, minZ: 10, maxX: 11, maxY: 12, maxZ: 11 })
  };
  const collision = builder.preview({ kind: 'structure', blocks: [{ x: 0, y: 0, z: 0 }] });
  assert.equal(collision.ok, false);
  assert.match(collision.errors.join(' '), /intersects the local player/);
});

test('SpaceBuilder accepts height 255 and rejects blocks crossing the 256 m ceiling', () => {
  const { builder } = createHarness();
  assert.equal(builder.preview({
    kind: 'structure',
    anchor: [10, 255, 10],
    blocks: [{ x: 0, y: 0, z: 0 }],
  }).ok, true);

  const aboveCeiling = builder.preview({
    kind: 'structure',
    anchor: [10, 256, 10],
    blocks: [{ x: 0, y: 0, z: 0 }],
  });
  assert.equal(aboveCeiling.ok, false);
  assert.match(aboveCeiling.errors.join(' '), /\[0,256\)/);
});
