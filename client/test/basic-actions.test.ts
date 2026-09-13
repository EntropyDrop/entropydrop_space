import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';

function block(x, y = 0, z = 0, color = 0x123456) {
  return { localX: x, localY: y, localZ: z, size: 1, block: BlockTypes.COLOR_BLOCK, color, entityId: 'root' };
}

test('script voxel adapters and engine input use the same canonical action dispatcher', () => {
  const scene = new THREE.Scene();
  const scripted = new Contraption(1, [block(0)], new THREE.Vector3(), scene) as any;
  const inputDriven = new Contraption(2, [block(0)], new THREE.Vector3(5, 0, 0), scene) as any;

  const scriptResult = scripted.scriptApi.voxels.subdivide([-0.5, -0.5, -0.5], [4, 1, 1]);
  const inputResult = executeBasicAction({ contraption: inputDriven }, {
    domain: ActionDomain.ENTITY,
    action: 'subdivide-standard',
    target: { contraption: inputDriven },
    nodeId: 'root',
    cell: [0, 0, 0],
    micro: [4, 1, 1],
    actor: { source: 'player' }
  });

  assert.equal(scriptResult.ok, true);
  assert.equal(inputResult.ok, true);
  assert.equal(scripted.blocks.length, 511);
  assert.equal(inputDriven.blocks.length, 511);
  assert.deepEqual(
    scripted.blocks.map(item => [item.localX, item.localY, item.localZ]),
    inputDriven.blocks.map(item => [item.localX, item.localY, item.localZ])
  );
  assert.equal(inputDriven.lastBlocksChangedEvent.type, 'subdivide');
  assert.deepEqual(inputDriven.lastBlocksChangedEvent.cell, [0, 0, 0]);
  assert.equal(inputDriven.lastBlocksChangedEvent.source, 'player');
  assert.equal(inputDriven.lastBlocksChangedEvent.playerId, 'local');

  const controllerSource = readFileSync(new URL('../src/engine/controls/PlayerController.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controllerSource, /(?:c|contraption)\.blocks\.(?:push|splice)/);
  assert.doesNotMatch(controllerSource, /(?:c|contraption)\.blocks\s*=/);
  assert.doesNotMatch(controllerSource, /this\.world\.(?:setBlock|setMicroBlock|removeMicroBlock|subdivideBlock|setBlockColor)/);
});

test('player queries pick published terrain while scripts read the live terrain state', () => {
  const calls: Array<[string, boolean]> = [];
  const miss = { hit: false };
  const world = {
    raycastBent(_origin, _direction, _distance, published) {
      calls.push(['standard-bent', published]);
      return miss;
    },
    raycastMicroBent(_origin, _direction, _distance, published) {
      calls.push(['micro-bent', published]);
      return miss;
    },
    raycastMicro(_origin, _direction, _distance, published) {
      calls.push(['micro-flat', published]);
      return miss;
    },
  };
  const query = {
    domain: ActionDomain.QUERY,
    action: 'raycast',
    origin: [0, 0, 0],
    direction: [1, 0, 0],
    include: 'world',
  };

  executeBasicAction({ world }, {
    ...query,
    space: 'bent',
    voxelKinds: ['standard', 'micro'],
    actor: { source: 'player' },
  });
  executeBasicAction({ world }, {
    ...query,
    space: 'bent',
    voxelKinds: ['standard', 'micro'],
    actor: { source: 'script' },
  });
  executeBasicAction({ world }, {
    ...query,
    space: 'world',
    voxelKinds: ['micro'],
    actor: { source: 'script' },
  });
  executeBasicAction({ world }, {
    ...query,
    space: 'bent',
    voxelKinds: ['standard', 'micro'],
    actor: { source: 'player' },
    usePublishedCollision: false,
  });

  assert.deepEqual(calls, [
    ['standard-bent', true],
    ['micro-bent', true],
    ['standard-bent', false],
    ['micro-bent', false],
    ['micro-flat', false],
    ['standard-bent', false],
    ['micro-bent', false],
  ]);
});

test('entity start and stop use the canonical entity action dispatcher', () => {
  const contraption = new Contraption(
    99,
    [block(0)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  contraption.setScript('self.state.runs = (self.state.runs || 0) + 1;');
  assert.equal(contraption.scriptStatus, 'running');
  contraption.velocity.set(3, 4, 5);
  contraption.angularVelocity.set(1, 2, 3);

  const stopped = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'toggle-scripts',
    target: { contraption },
    actor: { source: 'player', tool: 'wrench' }
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.physicsEnabled, false);
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), false);
  assert.equal(contraption.getRigidBody('root').simulationEnabled, false);
  assert.deepEqual(contraption.velocity.toArray(), [0, 0, 0]);
  assert.deepEqual(contraption.angularVelocity.toArray(), [0, 0, 0]);

  const started = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'toggle-scripts',
    target: { contraption },
    actor: { source: 'player', tool: 'wrench' }
  });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  assert.equal(started.physicsEnabled, true);
  assert.equal(contraption.scriptStatus, 'running');
  assert.equal(contraption.isPhysicsSimulationEnabled(), true);
  assert.equal(contraption.getRigidBody('root').simulationEnabled, true);
});

test('an entity without scripts can still stop and restart its physics', () => {
  const contraption = new Contraption(
    100,
    [block(0)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), true);

  const stopped = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'stop-scripts',
    target: { contraption }
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.physicsEnabled, false);
  assert.equal(contraption.canEditInternalSelection(), true);

  const started = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'start-scripts',
    target: { contraption }
  });
  assert.equal(started.ok, true);
  assert.equal(started.physicsEnabled, true);
  assert.equal(contraption.scriptStatus, 'stopped', 'no synthetic script status is needed');
  assert.equal(contraption.canEditInternalSelection(), false);
});

test('ctx.selection exposes world box, sparse cells, deletion and assembly commands', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  for (let x = 20; x <= 22; x++) {
    world.setBlock(x, 10, 20, BlockTypes.AIR, false);
  }
  world.setBlock(20, 10, 20, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(21, 10, 20, BlockTypes.COLOR_BLOCK, false, 0x00ff00);

  const api = manager.scriptSelectionApi;
  assert.deepEqual(api.box([20, 10, 20], [20, 10, 20]), { ok: true, selected: 1, clamped: false, reason: 'selected' });
  assert.equal(api.get().kind, 'world-box');
  assert.deepEqual(api.delete(), {
    ok: true,
    removed: 1,
    standard: 1,
    micro: 0,
    entities: 0,
    components: 0,
    entityId: null,
    nodeId: null,
    reason: 'removed'
  });
  assert.equal(world.getBlock(20, 10, 20), BlockTypes.AIR);

  assert.deepEqual(api.cells([[21, 10, 20]]), { ok: true, selected: 1, reason: 'selected' });
  const assembled = api.assemble();
  assert.equal(assembled.ok, true);
  assert.equal(assembled.assembled, 1);
  assert.match(assembled.entityId, /^ent_[0-9a-f-]{36}$/);
  assert.equal(typeof assembled.runtimeId, 'number');
  assert.equal(world.getBlock(21, 10, 20), BlockTypes.AIR);
  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.contraptions[0].mode, 'programmable');
  assert.equal(manager.contraptions[0].bodyType, 'dynamic');
  assert.equal(manager.contraptions[0].mass, 10);
  assert.equal(manager.contraptions[0].restitution, 0.1);
  assert.equal(manager.contraptions[0].friction, 0.7);
  assert.equal(manager.contraptions[0].useGravity, true);
});

test('ctx.selection rejects invalid assembly modes before consuming world voxels', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  world.setBlock(30, 10, 30, BlockTypes.COLOR_BLOCK, false, 0xff0000);

  const api = manager.scriptSelectionApi;
  assert.deepEqual(api.box([30, 10, 30], [30, 10, 30]), { ok: true, selected: 1, clamped: false, reason: 'selected' });
  assert.deepEqual(api.assemble('not_a_mode'), {
    ok: false,
    assembled: 0,
    entityId: null,
    runtimeId: null,
    reason: 'invalid_mode'
  });
  assert.equal(world.getBlock(30, 10, 30), BlockTypes.COLOR_BLOCK);
  assert.equal(manager.hasValidSelection(), true);
  assert.equal(manager.contraptions.length, 0);

  for (const mode of ['free_physics', 'projectile', 'programmable']) {
    assert.equal(manager.normalizeAssemblyMode(mode), mode);
  }
  const assembled = api.assemble('auto');
  assert.equal(assembled.ok, true);
  assert.equal(manager.contraptions[0].mode, 'programmable');
});

test('ctx.selection entity and entityBox share component selection state and createChild', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const entity = manager.registerContraption(new Contraption(
    7,
    [block(0), block(1), block(2)],
    new THREE.Vector3(0, 10, 0),
    scene
  )) as any;
  entity.stopAllNodeScripts();

  const api = manager.scriptSelectionApi;
  assert.deepEqual(api.entity(7), { ok: true, selected: 3, reason: 'selected' });
  assert.equal(api.get().kind, 'entity-subtree');

  // Root pivot is [1.5,0.5,0.5], so these node-local bounds select cells 1 and 2.
  const boxed = api.entityBox(7, 'root', [-0.5, -0.5, -0.5], [1.5, 0.5, 0.5]);
  assert.equal(boxed.ok, true);
  assert.equal(boxed.selected, 3);
  const child = api.createChild('arm');
  assert.deepEqual(child, { ok: true, childId: 'arm', reason: 'created' });
  assert.equal(entity.blocks.every(item => item.entityId === 'arm'), true);
});

test('ctx.selection createChild has a stable null failure shape', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null) as any;
  assert.deepEqual(manager.scriptSelectionApi.createChild(), {
    ok: false,
    childId: null,
    reason: 'no_selection'
  });
});

test('ctx.selection.delete removes child subtrees and whole root entities', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const entity = manager.registerContraption(new Contraption(
    71,
    [block(0), block(1), block(2)],
    new THREE.Vector3(0, 10, 0),
    scene
  )) as any;
  entity.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'arm');
  entity.createChildEntity('arm', new Set(['2,0,0']), 'hand');
  entity.setNodeScript('arm', 'self.state.live = true;');
  entity.setNodeScript('hand', 'self.state.live = true;');
  entity.stopAllNodeScripts();

  const api = manager.scriptSelectionApi;
  assert.deepEqual(api.entity(entity.publicId, 'arm'), { ok: true, selected: 2, reason: 'selected' });
  assert.deepEqual(api.delete(), {
    ok: true,
    removed: 2,
    standard: 2,
    micro: 0,
    entities: 0,
    components: 2,
    entityId: entity.publicId,
    nodeId: 'arm',
    reason: 'subtree_removed'
  });
  assert.equal(manager.contraptions.includes(entity), true, 'the root entity should remain');
  assert.deepEqual([...entity.entityNodes.keys()], ['root']);
  assert.deepEqual(entity.blocks.map(item => item.localX), [0]);
  assert.equal(entity.childDefinitions.has('arm'), false);
  assert.equal(entity.childDefinitions.has('hand'), false);
  assert.equal(entity.nodeScripts.has('arm'), false);
  assert.equal(entity.nodeScripts.has('hand'), false);
  assert.equal(api.get().kind, 'world-box', 'the deleted subtree selection should clear');

  const publicId = entity.publicId;
  assert.deepEqual(api.entity(publicId), { ok: true, selected: 1, reason: 'selected' });
  assert.deepEqual(api.delete(), {
    ok: true,
    removed: 1,
    standard: 1,
    micro: 0,
    entities: 1,
    components: 1,
    entityId: publicId,
    nodeId: 'root',
    reason: 'entity_removed'
  });
  assert.equal(manager.contraptions.includes(entity), false);
  assert.equal(manager.scriptWorldApi.entities.get(publicId), null, 'public entity query should update immediately');
});

test('manager runtime provides the same selection API through ctx', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const entity = manager.registerContraption(new Contraption(
    3,
    [block(0)],
    new THREE.Vector3(0, 10, 0),
    scene
  )) as any;
  entity.setScript(`
if (!self.state.once) {
  self.state.once = true;
  ctx.selection.entity(3, 'root');
  self.state.selectionKind = ctx.selection.get().kind;
}
`);

  manager.update(1 / 60, null);
  assert.equal(entity.getComponentState('root').selectionKind, 'entity-subtree');
});
