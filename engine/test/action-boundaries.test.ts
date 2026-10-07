import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBasicAction, executeBasicActionInput, executeUnknownBasicAction } from '../src/actions/BasicActions.ts';

test('malformed messages and non-finite script rays cannot mutate or query the world', () => {
  let calls = 0;
  const world = { raycast() { calls++; return { hit: false as const }; }, setBlock() { calls++; return true; } };
  for (const value of [null, [], 4, { domain: 'world' }, { domain: 'world', action: 42 }]) {
    assert.deepEqual(executeUnknownBasicAction({ world }, value), {
      ok: false, action: 'unknown', changed: 0, reason: 'invalid_command',
    });
  }
  for (const origin of [[NaN, 0, 0], [Infinity, 0, 0], ['bad', 0, 0], [], {}]) {
    const result = executeBasicActionInput({ world }, { domain: 'query', action: 'raycast', origin, direction: [1, 0, 0] });
    assert.equal(result.reason, 'invalid_ray');
    assert.equal(result.hit, null);
  }
  const invalidCell = executeBasicActionInput({ world }, { domain: 'world', action: 'place-standard', cell: ['bad', 0, 0] });
  assert.equal(invalidCell.reason, 'invalid_position');
  assert.equal(calls, 0);
});

test('replacing a standard cell clears existing micro voxels before writing it', () => {
  const writes: string[] = [];
  const result = executeBasicAction({ world: {
    hasMicroInStandardCell: () => true,
    clearMicroStandardCell(x, y, z) { writes.push(`clear ${x},${y},${z}`); return 1; },
    setBlock(x, y, z) { writes.push(`set ${x},${y},${z}`); return true; },
  } }, { domain: 'world', action: 'place-standard', cell: [1, 2, 3], replace: true });
  assert.equal(result.placed, 1);
  assert.deepEqual(writes, ['clear 1,2,3', 'set 1,2,3']);
});
