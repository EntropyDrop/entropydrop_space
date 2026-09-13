import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';


test('Wrench refuses to stop another owner’s server entity', async () => {
  const messages: string[] = [];
  const controller: any = Object.create(PlayerController.prototype);
  controller.hoveredContraption = {
    id: 7,
    serverManaged: true,
    serverCanControl: false,
    isPhysicsSimulationEnabled: () => true,
  };
  controller.hoveredContraptionHit = null;
  controller.ui = { showToast(message: string) { messages.push(message); } };
  controller.serverEntityRunStateHandler = async () => {
    throw new Error('must not be called');
  };

  const result = await controller.toggleHoveredEntityPlayback();

  assert.equal(result, false);
  assert.deepEqual(messages, ['Only this entity’s owner can start or stop it']);
});

test('Wrench asks the backend before changing an owned server entity', async () => {
  const calls: string[] = [];
  const controller: any = Object.create(PlayerController.prototype);
  const contraption = {
    id: 8,
    serverManaged: true,
    serverCanControl: true,
    serverExecutesLocally: true,
    isPhysicsSimulationEnabled: () => true,
  };
  controller.hoveredContraption = contraption;
  controller.hoveredContraptionHit = null;
  controller.ui = { showToast(message: string) { calls.push(`toast:${message}`); } };
  controller.sound = { playWrenchClick() { calls.push('sound'); } };
  controller.serverEntityRunStateHandler = async (target, state) => {
    assert.equal(target, contraption);
    calls.push(`remote:${state}`);
  };

  const result = await controller.toggleHoveredEntityPlayback();

  assert.equal(result, true);
  assert.deepEqual(calls, [
    'remote:stopped',
    'sound',
    'toast:Entity #8 stopped (state reset)',
  ]);
});

test('player tools cannot mutate a server entity locally, while its own script can', () => {
  const contraption: any = {
    serverManaged: true,
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, color: 0x112233 }],
    scriptStatus: 'running',
    physicsEnabled: true,
    isPhysicsSimulationEnabled() { return this.physicsEnabled; },
    stopAllNodeScripts() {
      this.scriptStatus = 'stopped';
      this.physicsEnabled = false;
    },
  };

  const blocked = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'paint-standard',
    target: { contraption },
    nodeId: 'root',
    cell: [0, 0, 0],
    color: 0xffffff,
    actor: { source: 'player', tool: 'shovel' },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'server_entity_read_only');
  assert.equal(contraption.blocks[0].color, 0x112233);

  const stopped = executeBasicAction({ contraption }, {
    domain: ActionDomain.ENTITY,
    action: 'stop-scripts',
    target: { contraption },
    actor: { source: 'script' },
  });
  assert.equal(stopped.ok, true);
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.physicsEnabled, false);
});

test('another owner’s server entity cannot be opened in the local code editor', () => {
  const messages: string[] = [];
  const target: any = { serverManaged: true, scriptStatus: 'stopped' };
  const controller: any = Object.create(PlayerController.prototype);
  controller.hoveredContraption = target;
  controller.contraptions = { contraptions: [target] };
  controller.ui = {
    showToast(message: string) { messages.push(message); },
    openCodeEditor() { throw new Error('must not be called'); },
  };

  assert.equal(controller.openCodeEditorForTarget(), false);
  assert.equal(controller.canEditEntityInternals(target), false);
  assert.deepEqual(messages, [
    'Only this entity’s owner can edit it',
  ]);
});

test('an owned server entity remains locally editable regardless of creation path', () => {
  const target: any = {
    serverManaged: true,
    serverCanEdit: true,
    rootComponentId: 'root',
    scriptStatus: 'stopped',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, color: 0x112233 }],
    rebuildAfterBlockChange() {},
    canEditInternalSelection: () => true,
  };
  const painted = executeBasicAction({ contraption: target }, {
    domain: ActionDomain.ENTITY,
    action: 'paint-standard',
    target: { contraption: target },
    nodeId: 'root',
    cell: [0, 0, 0],
    color: 0xffffff,
    actor: { source: 'player', tool: 'brush' },
  });
  assert.equal(painted.ok, true);
  assert.equal(target.blocks[0].color, 0xffffff);

  let opened = false;
  const controller: any = Object.create(PlayerController.prototype);
  controller.hoveredContraption = target;
  controller.contraptions = { contraptions: [target], activeProgrammingContraption: null };
  controller.ui = { openCodeEditor() { opened = true; } };
  assert.equal(controller.openCodeEditorForTarget(), true);
  assert.equal(controller.canEditEntityInternals(target), true);
  assert.equal(opened, true);
});
