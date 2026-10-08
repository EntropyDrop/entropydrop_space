import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityScriptHost } from '../src/scripting/EntityScriptHost.ts';
import type { ScriptSnapshot } from '../src/scripting/ScriptProtocol.ts';

test('components share immutable frame data while commands remain bound to their component', () => {
  const host = createEntityScriptHost(() => null, () => null);
  const players = [{ id: 'local', position: [1, 2, 3] }];
  const snapshot: ScriptSnapshot = {
    entityId: 'entity', rootComponentId: 'root', time: 1, tick: 20,
    position: [1, 2, 3], players, contacts: [{ position: [4, 5, 6] }],
    components: [{ id: 'root', parentId: null, children: ['arm'] }, { id: 'arm', parentId: 'root' }],
  };
  host.beginTick(snapshot);
  const root = host.context('root');
  const arm = host.context('arm');
  assert.notEqual(root, arm);
  for (const key of ['position', 'velocity', 'rotation', 'angularVelocity', 'gravity', 'limits', 'players', 'contacts'] as const) {
    assert.equal(root[key], arm[key]);
    assert.ok(Object.isFrozen(root[key]));
  }
  assert.notEqual(root.players, players);
  const visiblePlayers = root.players as typeof players;
  assert.throws(() => { visiblePlayers[0].position[0] = 999; }, TypeError);
  assert.equal(players[0].position[0], 1);
  root.log('root');
  arm.log('arm');
  assert.deepEqual(host.finish().commands.map(command => command.nodeId), ['root', 'arm']);

  players[0].position[0] = 7;
  host.beginTick({ ...snapshot, time: 2, tick: 40 });
  const next = host.context('root');
  assert.notEqual(next.players, root.players);
  assert.equal((next.players as typeof players)[0].position[0], 7);
  assert.equal(visiblePlayers[0].position[0], 1, 'previous frame stays immutable');
  assert.equal(next.time, 2);
  assert.equal(root.time, 1);
});

test('frame data is isolated across different entity hosts', () => {
  const first = createEntityScriptHost(() => null, () => null);
  const second = createEntityScriptHost(() => null, () => null);
  first.beginTick({ entityId: 'first', position: [1, 2, 3] });
  second.beginTick({ entityId: 'second', position: [4, 5, 6] });
  assert.deepEqual(first.context('root').position, [1, 2, 3]);
  assert.deepEqual(second.context('root').position, [4, 5, 6]);
  assert.notEqual(first.context('root').position, second.context('root').position);
});
