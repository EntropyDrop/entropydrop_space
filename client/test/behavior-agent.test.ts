import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBehaviorPrompt } from '../src/engine/contraption/BehaviorAgent.ts';

const CASES = [
  ['hover 5 meters above the ground and stay level', 'hover'],
  ['follow me at a distance of 3 meters', 'follow'],
  ['orbit the current position with a period of 10 seconds', 'orbit'],
  ['launch like a rocket for 5 seconds', 'launch'],
  ['spin at 20 rpm', 'spin'],
  ['automatically stay level', 'stabilize'],
  ['stop control', 'stop']
];

test('local Agent recognizes supported intents and emits valid controllers', () => {
  for (const [prompt, intent] of CASES) {
    const result = compileBehaviorPrompt(prompt);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.intent, intent);
    assert.doesNotThrow(() => new Function('self', 'ctx', result.code));
    assert.equal(result.code.includes('entity.'), false, 'generated code uses the self/ctx contract');
  }
});

test('local Agent reports unsupported and empty prompts', () => {
  assert.equal(compileBehaviorPrompt('').ok, false);
  assert.equal(compileBehaviorPrompt('turn into a cat').ok, false);
  assert.equal(compileBehaviorPrompt('hover without falling').intent, 'hover');
});

test('local Agent stop intent calls the root Stop API', () => {
  const result = compileBehaviorPrompt('stop control');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ctx.root.stop();');
});

function executeController(code, ctx, state = {}) {
  let force = null;
  const self = {
    state,
    applyForce(value) { force = value; },
    applyTorque() {}
  };
  new Function('self', 'ctx', code)(self, ctx);
  return force;
}

test('local follow controller uses shortest torus deltas and eye-relative height', () => {
  const result = compileBehaviorPrompt('follow me at a distance of 3 meters');
  assert.equal(result.ok, true);
  assert.match(result.code, /wrappedDelta\(ctx\.position\[0\], target\[0\], 16384\)/);
  assert.match(result.code, /wrappedDelta\(ctx\.position\[2\], target\[2\], 2048\)/);
  assert.doesNotMatch(result.code, /target\.map\(\(value, axis\) => value - ctx\.position\[axis\]\)/);
  assert.doesNotMatch(result.summary, /to the right/i);

  const force = executeController(result.code, {
    players: [{ position: [1, 10, 1] }],
    position: [16383, 11.8, 2047],
    velocity: [0, 0, 0],
    rotation: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    gravity: [0, -9.8, 0],
    mass: 1,
    tick: 1
  });

  assert.deepEqual(force, [36, 9.8, 90]);
});

test('every local player-tracking controller includes wrapped X/Z deltas', () => {
  for (const [prompt] of CASES) {
    const result = compileBehaviorPrompt(prompt);
    if (!result.code?.includes('ctx.players')) continue;
    assert.match(result.code, /wrappedDelta\(ctx\.position\[0\]/);
    assert.match(result.code, /wrappedDelta\(ctx\.position\[2\]/);
  }
});

test('local orbit controller uses shortest torus deltas', () => {
  const result = compileBehaviorPrompt('orbit every 10 seconds');
  assert.equal(result.ok, true);
  assert.match(result.code, /wrappedDelta\(ctx\.position\[0\], target\[0\], 16384\)/);
  assert.match(result.code, /wrappedDelta\(ctx\.position\[2\], target\[2\], 2048\)/);

  const force = executeController(result.code, {
    position: [1, 3, 2047],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    gravity: [0, -9.8, 0],
    mass: 1,
    time: 0
  }, { orbitCenter: [16383, 0, 2047] });

  assert.deepEqual(force, [80, 9.8, 0]);
});
